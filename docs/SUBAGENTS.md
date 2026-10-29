# The subagent channel catalogue — what ccr reads, and from where

Build documentation for `src/subagents.js`, the derivation layer under the S2
sidecar view and `ccr subagents`. It is **not a runtime surface**: ruling R13
and `features/subagent-channels.feature`'s last scenario keep channel health
out of `ccr doctor`, and the only provenance surfaces users get are the pane's
stale banner and `ccr subagents --debug`. This file exists so a maintainer
facing tomorrow's Claude Code can see exactly which records ccr leans on, and
therefore which drift would cost what.

Verified on **Claude Code 2.1.252**, 2026-09-01, against real transcripts in
`~/.claude/projects/`. Every shape below may drift. Parsing is fail-open by
ruling (need N14): an unrecognized record is skipped, never thrown on, never
guessed at. If everything drifts, the roster is empty and says so.

## Where the channels live

For session `<sid>` of project slug `<slug>`:

| Channel | Path | Kind |
|---|---|---|
| session | `~/.claude/projects/<slug>/<sid>.jsonl` | JSONL |
| agent | `~/.claude/projects/<slug>/<sid>/subagents/agent-<agentId>.jsonl` | JSONL |
| meta | `~/.claude/projects/<slug>/<sid>/subagents/agent-<agentId>.meta.json` | one JSON object |

The session path is the one the statusline snapshot carries as
`transcript_path`, **after** `currentTranscriptPath` has confined it to the
projects tree. The subagents directory is derived from that confined path
(`subagentsDir`), never from a snapshot field — the snapshot is
attacker-influenceable, and a path taken from it would reach `readdir`
unchecked.

`agentId` is a 17-hex-character token in practice; the channel matcher accepts
up to 64 characters of `[A-Za-z0-9_-]` so a lengthened id keeps working, and
refuses everything else so nothing can walk out of the directory.

Only **regular files** become channels: a fifo, socket, symlink or directory
named like an agent file is skipped rather than opened (`src/safe-read.js`'s
rule — a fifo in a read path once froze the whole panel). Agent files are taken
newest-mtime-first and capped at 128 per tick; past that a session keeps its
roster (dispatches live in the session transcript) and loses only the
*progress* of its coldest agents.

## The records, and what each one feeds

### 1. Dispatch — session channel, or a parent agent's channel

```json
{"type":"assistant","timestamp":"2026-09-01T17:03:50.291Z",
 "message":{"content":[{"type":"tool_use","id":"toolu_01MYgG…","name":"Agent",
   "input":{"description":"Fix installer.ts review findings",
            "subagent_type":"general-purpose","model":"opus",
            "prompt":"You are the builder…","run_in_background":true}}]}}
```

| Field | Roster fact |
|---|---|
| `id` | `dispatchId`, and the key every completion is matched on |
| `input.subagent_type` | `type` (absent → `general-purpose`, as upstream defaults it) |
| `input.description` | `task` — the task column is Claude's own dispatch words (R10, **amended 2026-09-02**: the description, not the prompt) |
| `input.prompt` | `task`, when the dispatch carries no description — head-first (R19) |
| record `timestamp` | `spawnedAt` |
| the channel it was found in | `parentId`, when that channel is an agent file |

**`name` is `Agent` or `Task`.** The rename landed in Claude Code 2.1.63; both
must yield one roster (`subagent-channels.feature` scenario 3). The `Task`
spelling is **reconstructed** in fixtures — the captured corpus is all `Agent`.

A dispatch found inside an **agent file** is a nested spawn: the child's
`tool_use` lives in the parent agent's jsonl, not in the session transcript.
That is the only place nesting is visible from the dispatch side.

A dispatch rosters immediately, before any agent id exists, keyed
`dispatch:<toolUseId>` — need N15 says a new spawn reaches the roster within a
tick, and the record naming its id can be a line or two behind.

### 2. Async launch result — same channel as its dispatch

```json
{"type":"user","timestamp":"…",
 "message":{"content":[{"tool_use_id":"toolu_01MYgG…","type":"tool_result",
   "content":[{"type":"text","text":"Async agent launched successfully…"}]}]},
 "toolUseResult":{"isAsync":true,"status":"async_launched",
   "agentId":"a4e4cc6b8ee1a633e","description":"…","resolvedModel":"opus",
   "prompt":"…","outputFile":"…","canReadOutputFile":true}}
```

This is the **dispatch-id → agentId link**, and nothing else. It is explicitly
**not a completion**: the agent has only just started. Recognised by
`status === "async_launched"` or `isAsync === true`.

### 3. Completion — a task notification (the shape 2.1.252 actually emits)

Emitted **twice** per task: once as a `queue-operation` when it is enqueued,
and again as a `user` record when Claude dequeues it.

```json
{"type":"queue-operation","operation":"enqueue","timestamp":"…","sessionId":"…",
 "content":"<task-notification>\n<task-id>ae3a37762b32b772d</task-id>\n<tool-use-id>toolu_01T1jA…</tool-use-id>\n<output-file>…</output-file>\n<status>completed</status>\n<summary>Agent \"Conventions CLAUDE.md check\" finished</summary>\n<note>…</note>\n<result>…</result>\n</task-notification>"}
```

| Field | Roster fact |
|---|---|
| `<tool-use-id>` | the key when present — matched against a dispatch id |
| `<task-id>` | the agentId; the key when there is **no** `<tool-use-id>` (the skill-driven shape) |
| `<status>` | `completed` → `done`; **anything else** → `failed` |
| `<summary>` | `failure` text, on a non-completed status (R17) |
| record `timestamp` | `completedAt` — the retirement clock |

Four decisions live here:

- **Keyed on `<tool-use-id>` when it carries one.** Background *bash* commands
  notify in exactly the same shape with a task-id that is no agent's
  (`bz1r106j3`, observed). Keying on the dispatch id makes them fall out with
  no special case.
- **Keyed on `<task-id>` when it carries no tool-use id.** A skill-driven
  agent (`/code-review`, forked by the Skill tool) has no Agent dispatch
  anywhere, and its notification has **no `<tool-use-id>` line at all** —
  only `<task-id>` = its agentId (verified on 2.1.252; found by the
  adversarial review of 2026-09-01, where such an agent read as live forever
  on a real session). It is stored under the agent id and matched to the
  agent the metadata and progress channels already established.
- **The enqueue wins, and the latest enqueue wins.** The enqueue record stamps
  when the agent actually stopped; the dequeue record only stamps when Claude
  read it, which can be minutes later if Claude was busy — so a dequeue fills
  in only when no enqueue was seen, whatever order the tail met them in.
  Agents are also **resumed** upstream (`resumedAgentId`, observed) and finish
  a second time — and that second notification carries the **resume call's**
  tool-use id, which no dispatch matches. So every notification is stored under
  both keys it carries, the fold prefers the agent-id key (it follows an agent
  across resumes), and the latest enqueue replaces the earlier one, whatever
  either status was, because the latest finish is the fact. Between the resume and
  that second notification the agent's own file is the truth: **a record
  stamped after the completion reads as live again** (measured on eleven real
  agents, a normal finish leaves the file ~1.5 s quieter than its enqueue, so
  a plain completion never trips this).
- **Only `completed` was observed.** Any other value is read as failure. That
  is the fail-open direction: inventing "done" for a status ccr does not
  recognize is precisely the lie the feature exists to prevent. `failed`,
  `error`, `killed` are therefore **reconstructed**, not verified.
- Only the first 4 KB of the block is scanned. `<result>` carries the agent's
  entire output and sits after every field ccr reads.

### 4. Completion, foreground — RECONSTRUCTED, unverified on 2.1.252

2.1.252 launches **every** Agent async, so no synchronous completion exists in
the captured corpus. Earlier versions returned the agent's final text inline,
and the rule ccr applies is: **any `tool_result` for a known dispatch id that
is not an async launch is that dispatch finishing**, at the record's timestamp;
`is_error: true` makes it `failed` and the result's text becomes `failure`.

This is the one **order-dependent** read in the accumulator — it counts only
when the dispatch is already known. That is safe because a `tool_result` and
the `tool_use` it answers always live in the same append-only channel with the
dispatch first, and it is necessary, because without the gate every `Bash` and
`Read` result in the transcript would be remembered as a candidate completion.

### 5. Agent progress — the agent's own channel

The first record is the dispatched prompt (`isSidechain: true`, `agentId`,
content as a plain string). Then assistant records, tool-result user records,
and `attachment` records (skipped).

```json
{"type":"assistant","timestamp":"…","agentId":"a4e4cc6b8ee1a633e","isSidechain":true,
 "message":{"id":"msg_011Ced5h6Npm…","content":[{"type":"text","text":"…"}],
   "usage":{"input_tokens":2,"cache_creation_input_tokens":22676,
            "cache_read_input_tokens":0,"output_tokens":1}}}
```

| Field | Roster fact |
|---|---|
| newest **non-empty `text`** block | `words`, `wordsAt` |
| newest `tool_use` block | `lastTool` (name), `lastToolArg` (`summarizeArg`), `lastToolAt` |
| `message.usage` | `tokens` |
| first record's string content | `task`, when neither a dispatch nor the metadata offers a description |

**A `thinking` block is not words.** It is the agent talking to itself, and
quoting it as its latest word would misreport what the agent said (R11).

**The task column is the DESCRIPTION (owner ruling, 2026-09-02).** R10 said
"Claude's own dispatch words" and the build read `input.prompt`; on a real
session that is the wrong half of the dispatch, because Claude opens every
prompt the same way ("You are the builder for batch A…") and the column showed
one identical string down the whole roster. `input.description` ("Fix
installer.ts review findings") is equally Claude's own and is written to be
glanceable, which is this column's entire job. The ladder, in order:

1. the dispatch's `input.description`;
2. the metadata sidecar's `description` — the stand-in for a dispatch a
   skill-driven agent never had;
3. the dispatch's `input.prompt`, head-first (R19 unchanged);
4. the agent file's own opening prompt;
5. nothing, which leaves the type alone carrying the row (R18 unchanged).

**The task fallback matters for real agents.** A skill-driven agent carries
`"name":"code-review"` and **no** `toolUseId` in its metadata — it has no
dispatch record anywhere — so its metadata's `description` is its only
description, and its own opening prompt is the only thing under that. Observed
on disk.

### The token formula

```
tokens = Σ over distinct assistant MESSAGES of
         (input_tokens + output_tokens + cache_creation_input_tokens)
```

Two choices, both deliberate:

- **Cache reads are excluded.** The three summed components are the
  meter-draining ones; `DRAIN_WEIGHTS` in `src/transcripts.js` is the precedent
  (it weights cache reads at 0.1 against output's 5). This is a per-agent
  *spend* figure, not a context-size figure.
- **Per message, not per record.** Claude Code splits ONE assistant message
  across SEVERAL transcript records — one per content block — and **each
  record repeats the same `usage` object**. Verified: 107 distinct message ids
  across 179 assistant records in a single agent file, with 61 ids appearing
  more than once. Summing per record inflates a three-block turn threefold.
  The accumulator remembers the last message id and replaces its contribution
  rather than adding to it, which works because a message's records are
  contiguous. (`parseEvents` in `src/transcripts.js` sums per record; that is
  the feed's long-standing behaviour and is left alone here.)

### 6. Metadata sidecar

```json
{"agentType":"general-purpose","description":"Angle B removed-behavior audit",
 "toolUseId":"toolu_014eM3…","parentAgentId":"a8f25d5c76399f8c2","spawnDepth":2}
```

| Field | Roster fact |
|---|---|
| `agentType` | `type`, when no dispatch supplied one |
| `toolUseId` | a second dispatch → agent link (absent for skill-driven agents) |
| `parentAgentId` | `parentId` |
| `spawnDepth` | `depth`; absent → derived by walking the lineage, bounded at 8 hops |

Read once per agent and never re-read: the file is written once, and re-reading
it every tick would be a stat and a read per agent per second for something
that never changes.

### 7. Timestamps

Every one is an ISO string under `timestamp`, and a record may carry none. A
missing timestamp is kept as `null` rather than substituted — and a completion
without one **never retires** (ruling R37), because there is no upstream clock
to retire it against and ccr refuses to invent one.

## The model, and the policy above it

`readRoster` / `updateRoster` produce:

```js
{ agents: [{ id, dispatchId, type, task, state, spawnedAt, completedAt, tokens,
             words, wordsAt, lastTool, lastToolArg, lastToolAt,
             parentId, depth, failure }],
  lastEventAt, channels: [{ name, path, lastEventAt, readable }], derivedAt }
```

`rosterView(model, { now, slots, staleMs, retireMs })` is the display policy,
in one place so the pane and the CLI cannot disagree:

- **Retirement** drops a finished agent once `now - completedAt >= RETIRE_MS`
  (60 s). Keyed to the upstream stamp, never to observation time — which is
  what lets a restarted panel agree with itself and stops a resumed session
  resurrecting ancient finishes.
- **Live-first slotting.** Live agents own the slots; finished agents fill only
  what is left, newest completion first. Live agents are ordered oldest-spawn
  first, so the roster does not reshuffle under the reader.
- **Overflow** counts everything beyond the slots and names the *types* of the
  live work that did not fit.
- **Stale** marks whole-transcript silence: `now - lastEventAt >= STALE_MS`
  (30 s), where `lastEventAt` is the newest timestamp across **every** channel
  read for the session — and only while at least one agent is live.
- `slots` is the pane's row budget. The CLI passes none and reports every
  unretired agent: "retired agents are absent from both doors alike" is about
  retirement, which applies to both, not about slots, which do not.

## One derivation path

`tick()` reads only what is new since the last tick, keyed by the parent
transcript path, resetting on a session switch or a tail restart — the same
pattern `updateFeed` uses in `src/sidecar.js`. `readRoster` (the CLI's full
parse) is that same tick run until the channels stop advancing, feeding the
**same** accumulator. Parity between the pane and the CLI is therefore by
construction rather than by two implementations that agree today.

`model()` is a pure fold over keyed stores rather than a sequence of
overwrites, because the tick reads channels in whatever order the directory
hands them over and splits any channel across ticks. Per-agent progress comes
from exactly one channel, so words, tools and tokens have no cross-channel
ordering to get wrong; the stores that do span channels (dispatches, links,
completions, metadata) are keyed and idempotent.

## Bounds

| Bound | Value | Why |
|---|---|---|
| bytes per file per tick | 2 MB | one tick must finish inside a second |
| bytes per tick | 8 MB (soft) | the budget stops the tick starting another channel; it never shrinks a window below one record, because `readNewLines` *skips* a line longer than its cap |
| agent files per tick | 128 | newest mtime first |
| metadata file | 64 KB, read once | |
| stored string (words, task, failure) | 512 characters, head-first | |
| remembered notifications | 4096 | a hostile transcript cannot grow the accumulator |
| full-parse passes | 16 | |

Nothing here is a correctness limit: a channel that does not fit this tick is
read by the next.

## Never

- Never writes anything, anywhere. Not to `~/.claude`, not into an instance's
  state dir, not a cache — statelessness is ruled (need N9), and "reading never
  disturbs the instance" is a scenario.
- Never throws. Every record shape it does not recognize falls off the end of a
  switch.
- Never masks. Words render verbatim, secret-shaped or not (need N11, ruled
  with eyes open). Control characters *are* stripped at capture — that is
  inert-rendering, not masking — and line breaks and tabs become one space
  first, so a multi-line report reads as words rather than as words welded
  together.
