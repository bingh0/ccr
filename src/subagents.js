// @ts-check
'use strict';
// src/subagents.js — the fail-open derivation layer under both subagent doors.
//
// Claude Code fans a session's work out to subagents and records the whole
// affair in its own transcripts. This module turns those records into ONE
// in-memory roster model; the sidecar view (Phase 2) and `ccr subagents`
// (Phase 3) both render from it, and `rosterView` below holds the display
// POLICY in one place so the two doors cannot disagree
// (features/subagent-mirror.feature, "The reading matches the pane fact for
// fact"). Nothing here is ever persisted — features/DESIGN.md principle 1,
// ruled N9: a restarted panel recomputes identical facts from the same records.
//
// THE CHANNELS, and what each contributes, are catalogued in docs/SUBAGENTS.md.
// Everything below is fail-open by ruling (features/subagent-channels.feature,
// N14): an unrecognized record shape is SKIPPED, never thrown on, never
// guessed at. If every shape drifts, the roster is empty and says so, which is
// the honest degradation the feature asks for.
//
// ONE DERIVATION PATH. `tick()` reads only what is new since the last tick, the
// way src/sidecar.js's `updateFeed` tails the session transcript; `readRoster`
// (the CLI's full parse) is that same tick run until the channels are
// exhausted, feeding the SAME accumulator. Parity between the pane and the CLI
// is therefore by construction, not by two code paths that agree today.
//
// ORDER INSENSITIVITY. `model()` is a pure fold over keyed stores rather than a
// sequence of overwrites, because the tick reads channels in whatever order the
// directory hands them over and splits any channel across ticks. The single
// order-DEPENDENT place is noted at its site (tool_result completions), and it
// is safe because both records involved live in one append-only channel.
//
// READS ONLY, BOUNDED, REGULAR FILES ONLY. Every path is derived from the
// CONFINED transcript path (`currentTranscriptPath`'s rule), never from a
// snapshot field; every read is capped; a FIFO planted in the subagents
// directory is skipped rather than blocking the redraw loop.

const fs = require('node:fs');
const path = require('node:path');
const { stripControl } = require('./sanitize');
const { readNewLines, summarizeArg } = require('./transcripts');
const { readTextCapped } = require('./safe-read');

/**
 * Whole-transcript silence before the facts read as stale. Tunable constant,
 * as the fence deferred it ("Staleness threshold constant … 30s is the proposed
 * tunable default"); the observable is what binds.
 */
const STALE_MS = 30000;

/**
 * How long a finished agent keeps its slot after the completion Claude Code
 * stamped. Keyed to the UPSTREAM timestamp, never to observation time (ruling
 * R16/R24/R37) — which is what lets a restarted panel agree with itself.
 */
const RETIRE_MS = 60000;

// Bounds. A tick must finish inside one second under any feed
// (subagent-channels.feature, "A flood of unknown shapes never wedges the
// redraw"), so every read is capped per file AND per tick, and the number of
// agent files touched in one tick is capped too. Nothing here is a correctness
// limit: a channel that does not fit this tick's budget is read by the next.
const MAX_AGENT_FILES = 128;
const META_MAX_BYTES = 64 * 1024;
const PER_FILE_MAX = 2 * 1024 * 1024;
const TICK_BUDGET = 8 * 1024 * 1024;
const FULL_PARSE_PASSES = 16;

/** Head-first cap on any single stored string (words, task, failure text). */
const TEXT_CAP = 512;

/** Only the head of a task notification is scanned — `<result>` can be huge. */
const NOTE_SCAN_MAX = 4096;

/** Ceiling on remembered notifications, so a hostile transcript cannot grow us. */
const MAX_NOTIFICATIONS = 4096;

/** Depth is derived by walking parents; the walk is bounded against a cycle. */
const MAX_DEPTH_WALK = 8;

/**
 * @typedef {object} Channel
 * @property {'session'|'agent'|'meta'} kind
 * @property {string} name   stable across ticks — the tail keys its offsets by it
 * @property {string} path
 * @property {string|null} agentId  the agent an 'agent'/'meta' channel belongs to
 */

/**
 * One roster row. The seam both consumers render from; see features/DESIGN.md
 * ("Derivation layer"). `lastToolArg` and `dispatchId` are additive to the
 * shape the build brief named — the first because `summarizeArg` already
 * produces the argument and the renderer should not re-derive it, the second
 * because `--debug` and the nesting tests need to name a dispatch.
 *
 * @typedef {object} RosterAgent
 * @property {string} id            agentId when known, else `dispatch:<toolUseId>`
 * @property {string|null} dispatchId
 * @property {string} type          subagent_type / meta agentType
 * @property {string} task          the dispatch PROMPT, head-first (R10/R18/R19)
 * @property {'live'|'done'|'failed'} state
 * @property {number|null} spawnedAt   ms epoch, null when upstream stamped none
 * @property {number|null} completedAt ms epoch; null NEVER retires (R37)
 * @property {number} tokens
 * @property {string|null} words       latest non-empty text block
 * @property {number|null} wordsAt
 * @property {string|null} lastTool    latest tool_use name
 * @property {string|null} lastToolArg summarizeArg of that call
 * @property {number|null} lastToolAt
 * @property {string|null} parentId    parent agentId (nesting, display only)
 * @property {number} depth            1 for a session-dispatched agent
 * @property {string|null} failure     what Claude Code surfaced (R17)
 */

/**
 * @typedef {object} ChannelReport
 * @property {string} name
 * @property {string} path
 * @property {number|null} lastEventAt
 * @property {boolean} readable
 */

/**
 * @typedef {object} RosterModel
 * @property {RosterAgent[]} agents
 * @property {number|null} lastEventAt  newest upstream timestamp across channels
 * @property {ChannelReport[]} channels
 * @property {number} derivedAt
 */

/** @param {any} s @returns {number|null} */
function parseTs(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Sanitize + bound a string as it is CAPTURED, the way `parseEvents` does — the
 * words reach a terminal, so control characters are stripped here rather than
 * trusted to a renderer (src/sanitize.js's header states the rule).
 * @param {any} s
 * @returns {string}
 */
function clean(s) {
  if (s == null) return '';
  // Line breaks and tabs become ONE space before the strip. `stripControl`
  // deletes them outright, which welds the words on either side together
  // ("uncommitted.## Files changed", read off a real agent's final report in
  // the adversarial review of 2026-09-02). A space keeps the words apart on the
  // pane's one row and in the JSON alike; it is whitespace normalisation, not
  // masking — every non-whitespace character still passes through verbatim.
  const t = String(stripControl(String(s).replace(/[\r\n\t]+/g, ' ')));
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t;
}

/** Flatten a message/tool_result content field to plain text. @param {any} c */
function blockText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const b of c) {
    if (typeof b === 'string') out += b;
    else if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

/**
 * The subagents directory for a session, derived from the CONFINED transcript
 * path and nothing else. `~/.claude/projects/<slug>/<sid>.jsonl` implies
 * `~/.claude/projects/<slug>/<sid>/subagents/`; deriving it from a snapshot
 * field instead would hand an attacker-influenced path straight to readdir.
 * @param {string} transcriptPath
 * @returns {string}
 */
function subagentsDir(transcriptPath) {
  const dir = path.dirname(transcriptPath);
  const sid = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  return path.join(dir, sid, 'subagents');
}

// An agent id is a hex-ish token in practice; the pattern is deliberately wider
// than 17 hex characters (upstream may lengthen it) and still refuses anything
// that could walk out of the directory.
const AGENT_JSONL_RE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
const AGENT_META_RE = /^agent-([A-Za-z0-9_-]{1,64})\.meta\.json$/;

/**
 * The channel list for a session: the parent transcript, then each agent file
 * and its metadata sidecar. Regular files only — a fifo or a symlink planted
 * here is skipped rather than opened, which is the same rule src/safe-read.js
 * states for every file ccr does not write.
 *
 * Agent files are taken newest-first and capped: a session that fanned out past
 * the cap keeps its roster (dispatches live in the parent transcript) and loses
 * only the PROGRESS of its coldest agents, which is the honest trade under a
 * burst. The order is stable for a given directory state, so the tick and the
 * full parse enumerate identically.
 *
 * @param {string} transcriptPath
 * @returns {Channel[]}
 */
function listChannels(transcriptPath) {
  /** @type {Channel[]} */
  const out = [{ kind: 'session', name: 'session', path: transcriptPath, agentId: null }];
  const dir = subagentsDir(transcriptPath);
  /** @type {fs.Dirent[]} */
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  /** @type {{ agentId: string, file: string, meta: string|null, mtimeMs: number }[]} */
  const found = [];
  /** @type {Record<string, string>} */
  const metas = Object.create(null); // agentId → meta filename
  for (const e of ents) {
    if (!e.isFile()) continue;                    // fifo, socket, symlink, dir: skipped
    const m = AGENT_META_RE.exec(e.name);
    if (m) metas[m[1]] = e.name;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    const m = AGENT_JSONL_RE.exec(e.name);
    if (!m) continue;
    const file = path.join(dir, e.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    found.push({ agentId: m[1], file, meta: metas[m[1]] || null, mtimeMs });
  }
  // Newest activity first, name as the tie-break so the order never depends on
  // readdir's.
  found.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  for (const f of found.slice(0, MAX_AGENT_FILES)) {
    out.push({ kind: 'agent', name: `agent-${f.agentId}`, path: f.file, agentId: f.agentId });
    if (f.meta) out.push({ kind: 'meta', name: `agent-${f.agentId}.meta`, path: path.join(dir, f.meta), agentId: f.agentId });
  }
  return out;
}

// The task-notification block, as Claude Code writes it into a queue-operation
// record and again into the user record that dequeues it. `[^<]*` is linear —
// no nested quantifier, so a long unclosed tag cannot backtrack.
const NOTE_MARK = '<task-notification>';
const NOTE_TOOL_USE_ID = /<tool-use-id>([^<]*)<\/tool-use-id>/;
const NOTE_TASK_ID = /<task-id>([^<]*)<\/task-id>/;
const NOTE_STATUS = /<status>([^<]*)<\/status>/;
const NOTE_SUMMARY = /<summary>([^<]*)<\/summary>/;

/**
 * The accumulator. Ingests raw lines from named channels and folds them into
 * the roster model on demand. In-memory only — writing anything here would
 * break "Reading never disturbs the instance" and the statelessness ruling
 * alike.
 */
function createAccumulator() {
  // Null-prototype throughout: every key below is a transcript-sourced string
  // (an agent id, a tool_use id, a channel name), so on a plain object a record
  // naming `__proto__` would perform a prototype write instead of being counted
  // — the same trap src/sidecar.js's feed accumulator documents.

  /** @type {Record<string, { toolUseId: string, type: string, task: string, spawnedAt: number|null, parentAgentId: string|null }>} */
  const dispatches = Object.create(null);
  /** @type {Record<string, string>} */
  const links = Object.create(null);           // dispatch toolUseId → agentId
  /** @type {Record<string, { at: number|null, state: 'done'|'failed', failure: string|null }>} */
  const results = Object.create(null);         // toolUseId → foreground tool_result completion
  /** @type {Record<string, { at: number|null, state: 'done'|'failed', failure: string|null, taskId: string|null, enqueued: boolean }>} */
  const notes = Object.create(null);           // toolUseId → task-notification completion
  /** @type {Record<string, { at: number|null, state: 'done'|'failed', failure: string|null, taskId: string|null, enqueued: boolean }>} */
  const taskNotes = Object.create(null);       // agentId → the same, for notifications carrying NO tool-use-id
  let noteCount = 0;
  /** @type {Record<string, { agentId: string, words: string|null, wordsAt: number|null, lastTool: string|null, lastToolArg: string|null, lastToolAt: number|null, tokens: number, firstPrompt: string|null, firstTs: number|null, msgId: string|null, msgTokens: number, lastAt: number|null }>} */
  const progress = Object.create(null);        // agentId → what its own file shows
  /** @type {Record<string, { agentType: string, toolUseId: string|null, parentAgentId: string|null, spawnDepth: number|null }>} */
  const metas = Object.create(null);           // agentId → its .meta.json
  /** @type {Record<string, ChannelReport>} */
  const channels = Object.create(null);

  let lastEventAt = /** @type {number|null} */ (null);

  /** @param {Channel} ch @param {boolean} readable */
  function channel(ch, readable) {
    const c = channels[ch.name] || (channels[ch.name] = { name: ch.name, path: ch.path, lastEventAt: null, readable });
    c.path = ch.path;
    c.readable = readable;
    return c;
  }

  /** @param {Channel} ch @param {number|null} ts */
  function sawEvent(ch, ts) {
    if (ts == null) return;
    const c = channel(ch, true);
    if (c.lastEventAt == null || ts > c.lastEventAt) c.lastEventAt = ts;
    if (lastEventAt == null || ts > lastEventAt) lastEventAt = ts;
  }

  /** @param {string} agentId */
  function progressOf(agentId) {
    return progress[agentId] || (progress[agentId] = {
      agentId, words: null, wordsAt: null, lastTool: null, lastToolArg: null,
      lastToolAt: null, tokens: 0, firstPrompt: null, firstTs: null,
      msgId: null, msgTokens: 0, lastAt: null,
    });
  }

  /**
   * A dispatch: `{type:'tool_use', name:'Agent'|'Task', input:{…}}` inside an
   * assistant record. Both names yield the same row — the Task→Agent rename
   * (Claude Code 2.1.63) is the drift case subagent-channels.feature pins.
   * @param {any} b @param {number|null} ts @param {Channel} ch
   */
  function dispatch(b, ts, ch) {
    const id = clean(b.id);
    if (!id) return;
    const input = (b.input && typeof b.input === 'object') ? b.input : {};
    // First dispatch for an id wins: a transcript replayed into the same
    // accumulator must not shift a spawn time.
    if (dispatches[id]) return;
    dispatches[id] = {
      toolUseId: id,
      type: clean(input.subagent_type) || 'general-purpose',
      task: clean(input.prompt),
      spawnedAt: ts,
      // A dispatch found INSIDE an agent file is that agent's child (R39,
      // nesting): the child's tool_use lives in the parent agent's jsonl, not
      // in the session transcript.
      parentAgentId: ch.kind === 'agent' ? ch.agentId : null,
    };
  }

  /** @param {any} o @param {number|null} ts @param {Channel} ch */
  function assistant(o, ts, ch) {
    const msg = (o.message && typeof o.message === 'object') ? o.message : {};
    const content = msg.content;
    const p = ch.kind === 'agent' && ch.agentId ? progressOf(ch.agentId) : null;

    if (p) {
      // Tokens. ONE assistant message is split across SEVERAL transcript
      // records — one per content block — each repeating the same `usage`
      // object, so summing per record triple-counts a three-block turn
      // (verified on 2.1.252: 107 message ids across 179 assistant records in
      // one agent file). Records of a message are contiguous, so remembering
      // only the last message id is enough to replace its contribution rather
      // than add to it.
      const u = msg.usage;
      if (u && typeof u === 'object') {
        const t = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
          + (Number(u.cache_creation_input_tokens) || 0);
        const mid = typeof msg.id === 'string' && msg.id ? msg.id : null;
        if (mid && mid === p.msgId) p.tokens -= p.msgTokens;
        p.tokens += t;
        p.msgId = mid;
        p.msgTokens = t;
      }
    }

    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (name === 'Agent' || name === 'Task') dispatch(b, ts, ch);
        if (p) {
          // Latest tool call — the activity line's fallback when an agent has
          // written no words (R20). Last wins: an agent's tool calls come from
          // its own file alone, so file order IS newest-last.
          p.lastTool = clean(name) || null;
          p.lastToolArg = clean(summarizeArg(name, b.input)) || null;
          p.lastToolAt = ts;
        }
        continue;
      }
      // LATEST WORDS = the newest non-empty `text` block. A `thinking` block is
      // NOT words (R11): it is the agent talking to itself, and quoting it as
      // its latest word would be a lie about what it said.
      if (p && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        p.words = clean(b.text);
        p.wordsAt = ts;
      }
    }
  }

  /**
   * A task notification — the completion shape 2.1.252 actually emits, seen
   * twice per task (the queue-operation that enqueues it and the user record
   * that dequeues it).
   *
   * KEYED TWO WAYS, because upstream writes two shapes. An Agent-tool dispatch
   * notifies with a `<tool-use-id>`, matched against the dispatch; a
   * BACKGROUND BASH command notifies the same way and simply matches no
   * dispatch, so it drops out in the fold rather than needing a special case.
   * A SKILL-DRIVEN agent (`/code-review`, forked by the Skill tool) notifies
   * with a `<task-id>` — its agentId — and NO tool-use-id at all (verified on
   * 2.1.252, adversarial review 2026-09-01); it is stored under the agent id
   * so the fold can complete an agent that never had a dispatch.
   *
   * THE ENQUEUE RECORD WINS, AND THE LATEST ENQUEUE WINS. The enqueue stamps
   * when the agent actually stopped; the dequeue only when Claude read it,
   * which can be minutes later if Claude was busy — so a dequeue fills in only
   * when no enqueue was seen. Agents are also RESUMED upstream and finish
   * again (`resumedAgentId`, verified), and the finish that matters is the
   * latest one: a later enqueue replaces an earlier, whatever either's status.
   * @param {any} raw @param {number|null} ts @param {boolean} enqueued  a queue-operation record, not the dequeued user record
   */
  function notification(raw, ts, enqueued) {
    const text = String(raw).slice(0, NOTE_SCAN_MAX);
    const idm = NOTE_TOOL_USE_ID.exec(text);
    const tm = NOTE_TASK_ID.exec(text);
    const taskId = tm ? clean(tm[1]) || null : null;
    const id = idm ? clean(idm[1]) : '';
    if (!id && !taskId) return;
    const statusM = NOTE_STATUS.exec(text);
    const status = statusM ? statusM[1].trim() : '';
    // `completed` is the only value observed. ANY other value is treated as a
    // failure carrying the summary — the fail-open direction, because inventing
    // "done" for a status we do not recognize would be the lie the feature
    // exists to prevent.
    const state = /** @type {'done'|'failed'} */ (status === 'completed' ? 'done' : 'failed');
    const sm = NOTE_SUMMARY.exec(text);
    const note = {
      at: ts,
      state,
      failure: state === 'failed' ? (sm ? clean(sm[1]) : null) : null,
      taskId,
      enqueued: !!enqueued,
    };
    // Stored under BOTH keys it carries. A resumed agent's second notification
    // carries the RESUME call's tool-use id — one no dispatch ever matches
    // (verified on 2.1.252) — so the agent id is the key that follows an agent
    // across its resumes, and the fold prefers it.
    for (const [store, key] of /** @type {[Record<string, typeof note>, string|null][]} */ ([[notes, id || null], [taskNotes, taskId]])) {
      if (!key) continue;
      const prev = store[key];
      if (!prev && noteCount >= MAX_NOTIFICATIONS) continue;
      if (prev && !enqueued) continue;           // a dequeue never outranks anything already seen
      if (!prev) noteCount++;
      store[key] = note;
    }
  }

  /** @param {any} o @param {number|null} ts @param {Channel} ch */
  function user(o, ts, ch) {
    const msg = (o.message && typeof o.message === 'object') ? o.message : {};
    const content = msg.content;

    if (typeof content === 'string') {
      if (content.includes(NOTE_MARK)) { notification(content, ts, false); return; }
      // The first record of an agent file is the prompt it was dispatched with
      // (`isSidechain:true`). It is the same text the dispatch carried, and the
      // only source of a task for a SKILL-driven agent, which has no dispatch
      // tool_use at all (verified: a `.meta.json` with `"name":"code-review"`
      // and no toolUseId).
      if (ch.kind === 'agent' && ch.agentId && o.isSidechain) {
        const p = progressOf(ch.agentId);
        if (p.firstPrompt == null && content.trim()) { p.firstPrompt = clean(content); p.firstTs = ts; }
      }
      return;
    }
    if (!Array.isArray(content)) return;

    const async = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type !== 'tool_result') continue;
      const id = clean(b.tool_use_id);
      if (!id) continue;
      // ASYNC LAUNCH RESULT: the dispatch-id → agentId link, and NOT a
      // completion — the agent has only just started.
      if (async && (async.status === 'async_launched' || async.isAsync === true)) {
        const aid = clean(async.agentId);
        if (aid) links[id] = aid;
        continue;
      }
      // A non-async result may still name the agent it ran. Gated on a KNOWN
      // dispatch, unlike the launch link above: `status:"async_launched"` is a
      // marker only an Agent launch carries, whereas a bare `agentId` on some
      // future tool's result would otherwise mint a phantom roster row for an
      // agent that was never dispatched.
      if (async && dispatches[id] && typeof async.agentId === 'string') {
        const aid = clean(async.agentId);
        if (aid) links[id] = aid;
      }
      // FOREGROUND COMPLETION (unverified on 2.1.252, which launches every
      // Agent async — see docs/SUBAGENTS.md): any tool_result for a dispatch
      // id that is not an async launch is that dispatch finishing.
      //
      // This is the one order-DEPENDENT read in the accumulator: it only counts
      // when the dispatch is already known. That is safe because a tool_result
      // and the tool_use it answers always live in the SAME append-only channel
      // with the dispatch first — and it is necessary, because without the gate
      // every Bash and Read result in the transcript would be remembered here.
      if (!dispatches[id] || results[id]) continue;
      const failed = b.is_error === true;
      results[id] = {
        at: ts,
        state: failed ? 'failed' : 'done',
        failure: failed ? (clean(blockText(b.content)) || null) : null,
      };
    }
  }

  /** @param {string} agentId @param {any} o */
  function meta(agentId, o) {
    if (!o || typeof o !== 'object') return;
    const depth = Number(o.spawnDepth);
    metas[agentId] = {
      agentType: clean(o.agentType) || 'general-purpose',
      toolUseId: clean(o.toolUseId) || null,
      parentAgentId: clean(o.parentAgentId) || null,
      spawnDepth: Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : null,
    };
  }

  /**
   * Feed raw lines from one channel. Never throws: a malformed line, a record
   * of an unknown type, a record that is not an object at all — each is
   * skipped, which is the whole of subagent-channels.feature's first scenario.
   * @param {Channel} ch
   * @param {string[]} lines
   */
  function ingest(ch, lines) {
    if (ch.kind === 'meta') {
      // A metadata sidecar is ONE JSON object, not JSONL; join before parsing so
      // a pretty-printed one still reads.
      if (!ch.agentId) return;
      let o; try { o = JSON.parse(lines.join('\n')); } catch { return; }
      meta(ch.agentId, o);
      return;
    }
    for (const ln of lines) {
      if (!ln || !ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }   // malformed: skipped
      if (!o || typeof o !== 'object') continue;
      const ts = parseTs(o.timestamp);
      sawEvent(ch, ts);
      if (ch.kind === 'agent' && ch.agentId && ts != null) {
        const p = progressOf(ch.agentId);
        if (p.lastAt == null || ts > p.lastAt) p.lastAt = ts;
      }
      // Unknown `type` values fall off the end of this switch by design.
      if (o.type === 'assistant') assistant(o, ts, ch);
      else if (o.type === 'user') user(o, ts, ch);
      else if (o.type === 'queue-operation' && typeof o.content === 'string'
        && o.content.includes(NOTE_MARK)) notification(o.content, ts, true);
    }
  }

  /**
   * Fold the stores into the roster model. Pure over the accumulator's state —
   * no reads, no clock beyond the `now` it is handed — so calling it twice
   * yields the same answer and the tick can call it every second.
   * @param {{ now?: number }} [opts]
   * @returns {RosterModel}
   */
  function model(opts = {}) {
    const now = opts.now != null ? opts.now : Date.now();

    /** @type {Record<string, string>} */ const agentOf = Object.create(null);   // toolUseId → agentId
    /** @type {Record<string, string>} */ const dispatchOf = Object.create(null); // agentId → toolUseId
    // Metadata first, the async launch result second: both name the same pair,
    // and the launch result is the record that ESTABLISHES the link, so it wins
    // any disagreement.
    for (const aid of Object.keys(metas)) {
      const t = metas[aid].toolUseId;
      if (t) { agentOf[t] = aid; dispatchOf[aid] = t; }
    }
    for (const t of Object.keys(links)) {
      const aid = links[t];
      agentOf[t] = aid; dispatchOf[aid] = t;
    }

    /** @type {Set<string>} */ const agentIds = new Set();
    for (const aid of Object.keys(progress)) agentIds.add(aid);
    for (const aid of Object.keys(metas)) agentIds.add(aid);
    for (const t of Object.keys(agentOf)) agentIds.add(agentOf[t]);

    /** @type {RosterAgent[]} */ const rows = [];
    /** @type {Record<string, RosterAgent>} */ const byAgentId = Object.create(null);

    /** @param {string|null} agentId @param {string|null} tuid */
    function row(agentId, tuid) {
      const d = tuid ? dispatches[tuid] : null;
      const m = agentId ? metas[agentId] : null;
      const p = agentId ? progress[agentId] : null;
      let c = completion(tuid, agentId);
      // RESUMED. Upstream can resume a finished agent (`resumedAgentId`,
      // verified on 2.1.252), and it then finishes a second time with a second
      // notification. Until that arrives, the agent's own file is the truth:
      // a record stamped AFTER the completion means it is working again. On a
      // normal finish the file goes quiet ~1.5 s BEFORE the enqueue (measured
      // across eleven agents), so this never misreads a plain completion.
      if (c && c.at != null && p && p.lastAt != null && p.lastAt > c.at) c = null;
      const r = /** @type {RosterAgent} */ ({
        id: agentId || `dispatch:${tuid}`,
        dispatchId: tuid || null,
        type: (d && d.type) || (m && m.agentType) || 'general-purpose',
        // The task column is Claude's own dispatch words (R10). The agent
        // file's opening prompt is the same text and covers the skill-driven
        // agent that has no dispatch record.
        task: (d && d.task) || (p && p.firstPrompt) || '',
        state: c ? c.state : 'live',
        spawnedAt: (d && d.spawnedAt != null) ? d.spawnedAt : (p ? p.firstTs : null),
        completedAt: c ? c.at : null,
        tokens: p ? p.tokens : 0,
        words: p ? p.words : null,
        wordsAt: p ? p.wordsAt : null,
        lastTool: p ? p.lastTool : null,
        lastToolArg: p ? p.lastToolArg : null,
        lastToolAt: p ? p.lastToolAt : null,
        parentId: (m && m.parentAgentId) || (d && d.parentAgentId) || null,
        depth: (m && m.spawnDepth) || 0,
        failure: c ? c.failure : null,
      });
      rows.push(r);
      if (agentId) byAgentId[agentId] = r;
    }

    for (const aid of agentIds) row(aid, dispatchOf[aid] || null);
    // A dispatch whose agentId has not arrived yet is still an agent: a new
    // spawn must reach the roster within one tick (N15), and the launch result
    // that names its id can be a record or two behind.
    for (const t of Object.keys(dispatches)) if (!agentOf[t]) row(null, t);

    // Depth: upstream's `spawnDepth` when it said one, else walk the lineage.
    for (const r of rows) {
      if (r.depth > 0) continue;
      let d = 1, p = r.parentId, hops = 0;
      const seen = new Set([r.id]);
      while (p && hops++ < MAX_DEPTH_WALK && !seen.has(p)) {
        seen.add(p);
        const parent = byAgentId[p];
        if (!parent) { d += 1; break; }
        if (parent.depth > 0) { d += parent.depth; break; }
        d += 1; p = parent.parentId;
      }
      r.depth = d;
    }

    // Oldest spawn first, id as the tie-break: a stable order means a roster
    // that does not reshuffle under the reader between ticks. Rows with no
    // spawn timestamp sort last rather than pretending to be oldest.
    rows.sort((a, b) => {
      const at = a.spawnedAt, bt = b.spawnedAt;
      if (at == null && bt == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      return (at - bt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

    return {
      agents: rows,
      lastEventAt,
      channels: Object.keys(channels).map((k) => ({ ...channels[k] })),
      derivedAt: now,
    };
  }

  /**
   * The completion for an agent, from whichever channel reported one: the
   * notification keyed on its agent id first (that key follows an agent across
   * resumes, and it is the only key a skill-driven agent has), else the one
   * keyed on its dispatch id, else a foreground tool_result. A failure outranks
   * a success: if two shapes spoke, the one naming trouble is the fact worth
   * showing (R17).
   * @param {string|null} tuid @param {string|null} agentId
   */
  function completion(tuid, agentId) {
    const n = (agentId && taskNotes[agentId]) || (tuid && notes[tuid]) || null;
    const r = tuid ? results[tuid] : null;
    if (n && r) return n.state === 'failed' ? n : (r.state === 'failed' ? r : n);
    return n || r || null;
  }

  return { ingest, model, channel };
}

/**
 * The incremental tail: byte offsets per channel, exactly as src/sidecar.js's
 * `updateFeed` tails the session transcript. Held in memory, keyed by the
 * parent transcript path, and thrown away on a session switch or a tail
 * restart — a restart replays lines already counted, and tokens accumulate.
 */
function createTail() {
  return {
    path: /** @type {string|null} */ (null),
    acc: createAccumulator(),
    offsets: /** @type {Record<string, number>} */ (Object.create(null)),
    metaDone: /** @type {Record<string, boolean>} */ (Object.create(null)),
  };
}

/** @typedef {ReturnType<typeof createTail>} Tail */

/** @param {Tail} tail @param {string|null} tpath */
function resetTail(tail, tpath) {
  tail.path = tpath;
  tail.acc = createAccumulator();
  tail.offsets = Object.create(null);
  tail.metaDone = Object.create(null);
}

/**
 * Read what is new since the last tick and fold it in. Bounded per file and per
 * tick; a channel that does not fit is picked up next tick, so a huge backlog
 * costs ticks rather than a frozen redraw.
 *
 * @param {Tail} tail
 * @param {string} transcriptPath
 * @param {{ maxRead?: number, budget?: number }} [opts]
 * @returns {boolean} whether any channel advanced
 */
function tick(tail, transcriptPath, opts = {}) {
  if (tail.path !== transcriptPath) resetTail(tail, transcriptPath);
  const maxRead = opts.maxRead != null ? opts.maxRead : PER_FILE_MAX;
  const budget = opts.budget != null ? opts.budget : TICK_BUDGET;

  // One retry: a channel that shrank means the offsets describe a file that no
  // longer exists, so the whole tail restarts and this tick re-reads from zero.
  for (let attempt = 0; attempt < 2; attempt++) {
    let advanced = false;
    let spent = 0;
    let restarted = false;
    for (const ch of listChannels(transcriptPath)) {
      if (spent >= budget) break;
      if (ch.kind === 'meta') {
        // Metadata is written once, so it is read once — re-reading it every
        // tick would be a stat and a read per agent per second for a file that
        // never changes.
        if (tail.metaDone[ch.name]) continue;
        const txt = readTextCapped(ch.path, META_MAX_BYTES);
        tail.acc.channel(ch, txt != null);
        if (txt == null) continue;
        tail.metaDone[ch.name] = true;
        spent += txt.length;
        tail.acc.ingest(ch, [txt]);
        advanced = true;
        continue;
      }
      const from = tail.offsets[ch.name] || 0;
      const before = from;
      // The budget decides whether to START another channel this tick; it never
      // SHRINKS the window, because `readNewLines` skips a line longer than its
      // cap outright (its own comment: forward progress beats completeness). A
      // window trimmed to the budget's remainder would therefore drop whole
      // records rather than defer them, which is data loss dressed as a bound.
      // One tick reads at most `budget + maxRead`, which is the real ceiling.
      const r = readNewLines(ch.path, from, maxRead);
      if (r.restarted) { restarted = true; break; }
      tail.acc.channel(ch, true);
      tail.offsets[ch.name] = r.offset;
      spent += Math.max(0, r.offset - before);
      if (r.lines.length) { tail.acc.ingest(ch, r.lines); advanced = true; }
      else if (r.offset !== before) advanced = true;
    }
    if (!restarted) return advanced;
    resetTail(tail, transcriptPath);
  }
  return false;
}

// The sidecar's tick state, module-level for the same reason the feed's is: one
// panel, one session, one tail. Reset on a session switch by `tick` itself.
const rosterTail = createTail();

/**
 * The pane's per-tick entry point: read what is new, return the roster model.
 * @param {string} transcriptPath  a path already confined by currentTranscriptPath
 * @param {{ now?: number, maxRead?: number, budget?: number }} [opts]
 * @returns {RosterModel}
 */
function updateRoster(transcriptPath, opts = {}) {
  tick(rosterTail, transcriptPath, opts);
  return rosterTail.acc.model({ now: opts.now });
}

/** Drop the module-level tail. For tests, and for a sidecar changing sessions. */
function __resetRosterState() { resetTail(rosterTail, null); }

/**
 * The CLI's full parse: the SAME accumulator, ticked until the channels stop
 * advancing. There is no second derivation path to disagree with the pane —
 * this IS the pane's path, run to exhaustion.
 * @param {string} transcriptPath  a path already confined by currentTranscriptPath
 * @param {{ now?: number, maxRead?: number, budget?: number, passes?: number }} [opts]
 * @returns {RosterModel}
 */
function readRoster(transcriptPath, opts = {}) {
  const tail = createTail();
  const passes = opts.passes != null ? opts.passes : FULL_PARSE_PASSES;
  for (let i = 0; i < passes; i++) {
    if (!tick(tail, transcriptPath, opts)) break;
  }
  return tail.acc.model({ now: opts.now });
}

/**
 * @typedef {RosterAgent & { ageMs: number|null, wordsAgeMs: number|null, toolAgeMs: number|null }} RosterViewAgent
 */

/**
 * @typedef {object} RosterViewResult
 * @property {RosterViewAgent[]} agents   what a door should show, in order
 * @property {boolean} empty              nothing to show — the "no subagents" truth
 * @property {number} live                live agents surviving retirement
 * @property {number} finished            finished agents surviving retirement
 * @property {number} total               agents surviving retirement
 * @property {number} retired             agents dropped by the retirement clock
 * @property {number} overflow            agents beyond the slots
 * @property {string[]} overflowNames      types of the LIVE work beyond the cap
 * @property {boolean} stale
 * @property {number|null} staleForMs
 * @property {number|null} lastEventAt
 * @property {number|null} slots
 */

/**
 * The display POLICY, in one place, as a pure function of the model. Both doors
 * call it so neither can drift from the other (subagent-mirror.feature's parity
 * ruling).
 *
 * `slots` is what the pane's row budget fits; the CLI passes none and reports
 * every unretired agent. "Retired agents are absent from both doors alike" is
 * about RETIREMENT, which applies to both, not about slots, which do not.
 *
 * @param {RosterModel} model
 * @param {{ now?: number, slots?: number|null, staleMs?: number, retireMs?: number }} [opts]
 * @returns {RosterViewResult}
 */
function rosterView(model, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const staleMs = opts.staleMs != null ? opts.staleMs : STALE_MS;
  const retireMs = opts.retireMs != null ? opts.retireMs : RETIRE_MS;
  const slots = (typeof opts.slots === 'number' && opts.slots >= 0) ? Math.trunc(opts.slots) : null;
  const all = (model && Array.isArray(model.agents)) ? model.agents : [];

  /** @type {RosterAgent[]} */ const live = [];
  /** @type {RosterAgent[]} */ const finished = [];
  let retired = 0;
  for (const a of all) {
    if (a.state === 'live') { live.push(a); continue; }
    // Retirement keys to the completion Claude Code stamped, never to when ccr
    // noticed (R16/R24/R37) — which is why a resumed session's ancient finishes
    // never come back, and why a completion carrying NO timestamp stays until
    // the session ends rather than being retired on a clock ccr invented.
    if (a.completedAt != null && now - a.completedAt >= retireMs) { retired++; continue; }
    finished.push(a);
  }

  // Live agents own the slots (R15); finished agents fill only what is left,
  // NEWEST completion first (owner ruling 2026-08-24) on the same upstream
  // clock retirement uses. A finish with no timestamp sorts last: it is the one
  // whose age nobody can vouch for.
  finished.sort((a, b) => {
    const at = a.completedAt, bt = b.completedAt;
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    return bt - at;
  });

  const liveShown = slots == null ? live : live.slice(0, slots);
  const leftover = slots == null ? finished : finished.slice(0, Math.max(0, slots - liveShown.length));
  const shown = [...liveShown, ...leftover];
  const total = live.length + finished.length;

  const withAges = shown.map((a) => ({
    ...a,
    ageMs: a.spawnedAt == null ? null : now - a.spawnedAt,
    wordsAgeMs: a.wordsAt == null ? null : now - a.wordsAt,
    toolAgeMs: a.lastToolAt == null ? null : now - a.lastToolAt,
  }));

  // Staleness is the WHOLE-transcript silence clock: the newest upstream
  // timestamp across every channel read for this session. It is marked only
  // when at least one agent is live — a roster of finished work has nothing
  // left to be stale about, and saying otherwise would put a fault marker on a
  // view that is simply finished (documented in features/DESIGN.md's changelog).
  const lastEventAt = model && model.lastEventAt != null ? model.lastEventAt : null;
  const staleForMs = lastEventAt == null ? null : now - lastEventAt;
  const stale = live.length > 0 && staleForMs != null && staleForMs >= staleMs;

  return {
    agents: withAges,
    empty: total === 0,
    live: live.length,
    finished: finished.length,
    total,
    retired,
    overflow: Math.max(0, total - shown.length),
    overflowNames: live.slice(liveShown.length).map((a) => a.type),
    stale,
    staleForMs,
    lastEventAt,
    slots,
  };
}

module.exports = {
  STALE_MS, RETIRE_MS, PER_FILE_MAX,
  subagentsDir, listChannels,
  createAccumulator, createTail, tick,
  updateRoster, readRoster, rosterView, __resetRosterState,
};
