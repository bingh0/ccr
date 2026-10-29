# `ccr economy --json` — the integration contract

`ccr economy --json` emits the **computed economy model** as a single JSON
object on stdout. This is the stable, machine-readable surface other tools build
on (menu-bar widgets, status bars, alerting, dashboards). The text panel and
this JSON read from the *same* model (`src/economy-model.js`), so they can never
disagree about which window binds.

```sh
ccr economy --json            # from the latest captured snapshot
cat status.json | ccr economy --json   # or pipe a CC status-line JSON in
```

## Stability promise

- **`schemaVersion`** starts at `1`. It bumps **only** on a breaking change — a
  renamed/removed field or changed semantics.
- **New fields may be added without bumping** `schemaVersion`. Consumers MUST
  ignore unknown fields rather than fail on them.
- Pin behaviour to `schemaVersion`; treat any field you don't recognise as
  optional.

## Shape

```jsonc
{
  "schemaVersion": 1,
  "model": "Opus 4.8",            // CC display name, or null (API session)

  "context": {
    "tokens": 262000,             // live context tokens, or null
    "windowSize": 1000000,        // model context window
    "pct": 26.2,                  // tokens / windowSize * 100, raw; null if unknown
    "cachedPct": null             // share of context served from cache, or null
  },

  // One entry per rate-limit bucket the plan exposes (5h, weekly, model-scoped,
  // monthly, …). Empty [] on an API session with no subscription limits.
  "windows": [
    {
      "key": "five_hour",         // stable bucket id from the status JSON
      "label": "5h",              // human label
      "usedPct": 80,              // percent of the window consumed
      "rate": 0.5,                // burn rate in %/min, or null (not enough samples)
      "minutesLeft": 40,          // minutes to exhaust at `rate`, or null
      "minutesToReset": 200,      // minutes until the window resets, or null
      "band": "warn",             // "ok" | "warn" (<=120m) | "imminent" (<=30m)
      "binding": true,            // is this the window you'll hit first?
      "resetsBeforeHit": false    // true = it resets before you'd exhaust it
    }
  ],

  // The window you'll hit first (smallest minutesLeft that exhausts before
  // reset), or null if every window resets before you reach it / API session.
  "binding": {
    "key": "five_hour",
    "label": "5h",
    "minutesLeft": 40,
    "band": "warn"
  },

  // ROI of clearing context now, framed against the binding wall.
  "clear": {
    "worthwhile": true,           // false when context is near baseline / no pressure
    "boughtMinutes": 35,          // extra minutes before the wall if you clear now
    "contextTokens": 262000,
    "baselineTokens": 14000       // assumed post-clear floor
  },

  "session": {
    "costUsd": 4.2,               // or null
    "durationMin": 30,            // or null
    "branch": "main"             // or null
  }
}
```

## Units & conventions

- **Numbers are raw (unrounded)** — the panel rounds for display; consumers
  format as they like. `pct`/`usedPct` are percent, `rate` is `%/min`,
  `minutes*` are minutes, `tokens` are counts, `costUsd` is US dollars.
- **`null` means "not known"**, not zero. An API session has `windows: []` and
  `binding: null`; a fresh session may have `rate: null` until it has ≥2 samples.
- The object is **always fully JSON-serialisable** — no `undefined`/`NaN` holes.

## For widget authors

A menu-bar / status-bar widget is **pure presentation**: poll
`ccr economy --json` on a timer and render. Do **not** reimplement the burn math
— `binding.band` gives you the colour, `binding.minutesLeft` the headline, and
`clear.worthwhile` / `clear.boughtMinutes` the clear hint. Keeping the single
tested source of truth in JS is the whole point of the contract.

---

# `ccr subagents` — the roster contract

**New at 0.7.** A second, *separate* contract in this file. It shares nothing
with the economy model above — different command, different shape, its own
stability story — and the economy contract's `schemaVersion` says nothing about
it.

`ccr subagents` emits **one JSON object** on stdout and exits 0. It is
**read-only**: it derives the roster from Claude Code's own transcripts and
writes nothing into the instance's state dir.

```sh
ccr subagents                  # the instance resolved from your cwd
ccr subagents -i side-project  # a named live instance
ccr subagents --all            # every live instance, rolled up
ccr subagents -i side-project --debug   # plus the channels read
```

These are the **same facts the sidebar's subagent pane shows** — both doors
render from one model and one display policy (`src/subagents.js`), so they
cannot disagree. The single difference: the pane shows what its rows fit, this
reports **every agent retirement has left standing**.

## Stability

- The **first property is always `instance`**, the name the resolution chain
  landed on. That is how this door "heads with the name it resolved" without
  putting a line in front of the object and breaking `| jq`.
- New fields may be added. Consumers MUST ignore unknown fields.
- `null` means *not known*, never zero. Claude Code omits a timestamp often
  enough that every derived age can legitimately be `null`.

## Shape

```jsonc
{
  "instance": "side-project",   // resolved name; null when the instance is unnamed
                                // (under --all, "slot 3" when it has no name)
  "transcript": "/home/you/.claude/projects/-code-app/<sid>.jsonl",
                                // null when no snapshot or no transcript yet —
                                // which is NOT the same as "no subagents"
  "stale": false,               // whole-transcript silence while agents are live
  "staleForMs": 4200,           // how long since the newest upstream event, or null
  "lastEventAt": "2026-09-01T12:00:00.000Z",  // ISO, or null
  "live": 2,                    // agents surviving retirement, by state
  "finished": 1,
  "retired": 3,                 // agents the retirement clock dropped
  "agents": [ /* see below */ ]
}
```

### `agents[]`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Claude Code's agent id, or `dispatch:<toolUseId>` before the id arrives |
| `type` | string | the subagent type (`explore`, `general-purpose`, …) |
| `task` | string | Claude's own dispatch **description**; its prompt, head-first, when the dispatch carries none (R10 as amended 2026-09-02) |
| `state` | `"live"` \| `"done"` \| `"failed"` | a failure never reads as done |
| `spawnedAt` | ISO \| null | when the dispatch was recorded |
| `ageMs` | number \| null | now − `spawnedAt` |
| `completedAt` | ISO \| null | the completion Claude Code stamped; null never retires |
| `tokens` | number | `input + output + cache_creation` over the agent's own turns |
| `words` | string \| null | its latest non-empty text block (thinking is not words) |
| `wordsAgeMs` | number \| null | how old those words are |
| `lastTool` | string \| null | its latest tool call, by name |
| `lastToolArg` | string \| null | that call's summarised argument |
| `toolAgeMs` | number \| null | how old that call is |
| `parentId` | string \| null | the parent agent, for a nested spawn |
| `depth` | number | 1 for an agent the session itself dispatched |
| `failure` | string \| null | what Claude Code surfaced when it failed |

### `--all`

```jsonc
{ "instances": [ { "instance": "alpha", /* …the single-instance object… */ }, … ] }
```

Every live instance, each entry labelled by its own name. Cross-instance
aggregation is **CLI-only** by design — panes stay strictly own-session.

### `--debug`

Adds one array and changes nothing else:

```jsonc
"channels": [
  { "name": "session",              "path": "…/<sid>.jsonl",   "lastEventAgeMs": 4200, "readable": true },
  { "name": "agent-a4e4cc6b8ee1a633e",      "path": "…/subagents/agent-….jsonl",      "lastEventAgeMs": 1500, "readable": true },
  { "name": "agent-a4e4cc6b8ee1a633e.meta", "path": "…/subagents/agent-….meta.json", "lastEventAgeMs": null, "readable": true }
]
```

`lastEventAgeMs` is `null` for a metadata sidecar: it is a single JSON object
carrying no timestamp, so its freshness is unknown rather than zero.

## Exit codes

| Code | When |
|---|---|
| 0 | a reading — including an empty roster, which is an answer, not an error |
| 1 | the instance could not be resolved (`-i` named nothing live, several matched, none live) |
| 2 | a usage error (`--all` together with `-i`) |

A session that never fanned out exits **0** with `"agents": []` and a non-null
`transcript`. An instance with no snapshot yet exits 0 with `"agents": []` and
`"transcript": null`. Distinguish the two by that field, never by the exit code.

## For script authors

Poll it, don't reimplement it. Retirement, staleness and the live/finished split
are policy, and the policy lives in one function that both doors call — a script
that re-derives them from `completedAt` will drift from what the user's sidebar
is showing them at that moment.
