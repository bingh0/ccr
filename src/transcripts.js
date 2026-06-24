// @ts-check
'use strict';
// src/transcripts.js — read-only reader for Claude Code session transcripts
// (`~/.claude/projects/<slug>/<sessionId>.jsonl`). The shared spine for the
// tool/skills feed and the resume list.
//
// NEVER writes to ~/.claude. Tolerant of malformed lines (skipped) and schema
// drift (CC stamps `version`; we degrade, never throw). Pure parsing lives in
// `parseEvents` (operates on lines/strings) so it's testable without the FS; the
// file/dir helpers are thin wrappers.
//
// Skills/slash-commands: in current CC they appear as USER messages carrying a
// `<command-name>…</command-name>` tag (verified — zero `Skill` tool_use blocks
// in real transcripts). We detect that tag first, and ALSO accept a `Skill` /
// `SlashCommand` tool_use for forward/back compatibility.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stripControl } = require('./sanitize');

/** Rough input-token-equivalent weights — the meter-drain proxy (see backtest-burn.js). */
const DRAIN_WEIGHTS = { output: 5, cacheCreate: 1.25, input: 1, cacheRead: 0.1 };

const projectsDir = () => path.join(os.homedir(), '.claude', 'projects');

/** @param {string} [p] */
function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }

/**
 * One-line summary of a tool call's arguments, per tool.
 * @param {string} name
 * @param {any} input
 * @returns {string}
 */
function summarizeArg(name, input) {
  const i = input || {};
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return basename(i.file_path || i.notebook_path);
    case 'Bash':
      return i.description || String(i.command || '').split('\n')[0].slice(0, 48);
    case 'Grep': case 'Glob':
      return String(i.pattern || '');
    case 'Task': case 'Agent':
      return i.subagent_type || i.description || '';
    case 'Skill':
      return i.skill || i.command || '';
    case 'SlashCommand':
      return i.command || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    default:
      return '';
  }
}

/** Flatten a message's content to plain text (content may be a string or block array). */
function messageText(/** @type {any} */ msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : (typeof b === 'string' ? b : ''))).join('');
  return '';
}

// Linear: a single greedy class with a literal terminator not in the class — no
// overlapping quantifiers, so no catastrophic backtracking. (The old
// `\s*([^<]+?)\s*` form was super-quadratic on a long unclosed tag; the `\s*`
// was redundant anyway since we .trim() the capture.)
const CMD_RE = /<command-name>([^<]+)<\/command-name>/;
const CMD_SCAN_MAX = 64 * 1024; // only scan a bounded prefix for the tag

/**
 * Parse transcript lines into events, rolling stats, and session metadata.
 * @param {string | string[]} input  raw JSONL text or an array of raw lines
 * @returns {{
 *   meta: { sessionId: string|null, cwd: string|null, gitBranch: string|null, version: string|null, startTs: number|null, lastTs: number|null },
 *   events: { ts: number|null, kind: 'tool'|'cmd', tool: string, arg: string }[],
 *   title: string|null, lastPrompt: string|null,
 *   stats: { tools: Record<string, number>, commands: number, tokens: { input: number, output: number, cacheRead: number, cacheCreate: number }, weighted: number, files: string[], models: string[], userPrompts: number, assistantTurns: number, lastTurn: { input: number, output: number, cacheRead: number, cacheCreate: number }|null, lastModel: string|null }
 * }}
 */
function parseEvents(input) {
  const lines = Array.isArray(input) ? input : String(input).split('\n');
  const meta = { sessionId: /** @type {string|null} */(null), cwd: /** @type {string|null} */(null), gitBranch: /** @type {string|null} */(null), version: /** @type {string|null} */(null), startTs: /** @type {number|null} */(null), lastTs: /** @type {number|null} */(null) };
  /** @type {{ ts: number|null, kind: 'tool'|'cmd', tool: string, arg: string }[]} */
  const events = [];
  const tools = /** @type {Record<string, number>} */ ({});
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const files = new Set();
  const models = new Set();
  let commands = 0, userPrompts = 0, assistantTurns = 0;
  let title = /** @type {string|null} */ (null);
  let lastPrompt = /** @type {string|null} */ (null);
  // The freshest assistant turn's usage + model — what a resume re-feeds (its
  // input side is ~the context size), as opposed to the cumulative totals.
  let lastTurn = /** @type {{ input: number, output: number, cacheRead: number, cacheCreate: number }|null} */ (null);
  let lastModel = /** @type {string|null} */ (null);

  for (const ln of lines) {
    if (!ln || !ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; } // tolerate malformed lines
    if (!o || typeof o !== 'object') continue;

    // Metadata: first non-null wins for identity; ts tracks the span.
    // Sanitize every externally-sourced field (titles, prompts, args, identity)
    // as it's captured — these are displayed in the terminal, so control chars
    // would otherwise be a terminal-escape-injection vector.
    if (meta.sessionId == null && o.sessionId) meta.sessionId = stripControl(String(o.sessionId));
    if (meta.cwd == null && o.cwd) meta.cwd = stripControl(String(o.cwd));
    if (meta.gitBranch == null && o.gitBranch) meta.gitBranch = stripControl(String(o.gitBranch));
    if (meta.version == null && o.version) meta.version = o.version;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    const tsOk = Number.isFinite(ts) ? ts : null;
    if (tsOk != null) {
      if (meta.startTs == null || tsOk < meta.startTs) meta.startTs = tsOk;
      if (meta.lastTs == null || tsOk > meta.lastTs) meta.lastTs = tsOk;
    }

    if (o.type === 'ai-title' && o.aiTitle) { title = stripControl(String(o.aiTitle)); continue; }       // last wins
    if (o.type === 'last-prompt' && o.lastPrompt != null) { lastPrompt = stripControl(String(o.lastPrompt)); continue; } // last wins

    if (o.type === 'user') {
      const text = messageText(o.message);
      const m = CMD_RE.exec(text.length > CMD_SCAN_MAX ? text.slice(0, CMD_SCAN_MAX) : text);
      // Command name goes in `tool` (the renderer's convention — same as the
      // Skill/SlashCommand tool_use path below); `arg` stays empty.
      if (m) { commands++; events.push({ ts: tsOk, kind: 'cmd', tool: stripControl(m[1].trim()), arg: '' }); continue; }
      // A genuine prompt: has text and isn't a tool_result echo or meta line.
      const isToolResult = Array.isArray(o.message && o.message.content) && o.message.content.some((/** @type {any} */ b) => b && b.type === 'tool_result');
      if (text.trim() && !o.isMeta && !isToolResult) userPrompts++;
      continue;
    }

    if (o.type === 'assistant') {
      assistantTurns++;
      const msg = o.message || {};
      if (msg.model) { models.add(msg.model); lastModel = msg.model; }
      const u = msg.usage;
      if (u) {
        const turn = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0 };
        tokens.input += turn.input;
        tokens.output += turn.output;
        tokens.cacheRead += turn.cacheRead;
        tokens.cacheCreate += turn.cacheCreate;
        lastTurn = turn;
      }
      const c = msg.content;
      if (Array.isArray(c)) for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        const name = String(b.name || '');
        const cleanName = stripControl(name); // the displayed name (header count + event)
        const kind = /** @type {'tool'|'cmd'} */ (name === 'Skill' || name === 'SlashCommand' ? 'cmd' : 'tool');
        if (kind === 'cmd') commands++; else tools[cleanName] = (tools[cleanName] || 0) + 1;
        const arg = stripControl(summarizeArg(name, b.input));
        if ((name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && arg) files.add(arg);
        events.push({ ts: tsOk, kind, tool: kind === 'cmd' ? (name === 'Skill' || name === 'SlashCommand' ? arg : cleanName) : cleanName, arg: kind === 'cmd' ? '' : arg });
      }
    }
  }

  const weighted = tokens.output * DRAIN_WEIGHTS.output + tokens.cacheCreate * DRAIN_WEIGHTS.cacheCreate
    + tokens.input * DRAIN_WEIGHTS.input + tokens.cacheRead * DRAIN_WEIGHTS.cacheRead;

  return {
    meta, events, title, lastPrompt,
    stats: { tools, commands, tokens, weighted, files: [...files], models: [...models], userPrompts, assistantTurns, lastTurn, lastModel },
  };
}

/**
 * The current session's transcript path from the captured statusline JSON,
 * CONFINED to `~/.claude/projects`. The snapshot can be attacker-influenced (e.g.
 * a planted /tmp state file), so we never hand the sidecar a path that escapes
 * the projects tree or isn't a `.jsonl` — preventing arbitrary-file reads.
 * Confinement is lexical (path.resolve, not realpath): a symlink planted *inside*
 * the projects tree is out of scope, as that already requires write access to
 * the user's home directory.
 * @param {any} snapshot
 * @param {string} [base] projects dir (injectable for tests)
 * @returns {string|null} the resolved in-tree path, or null if rejected
 */
function currentTranscriptPath(snapshot, base = projectsDir()) {
  const p = snapshot && snapshot.transcript_path;
  if (typeof p !== 'string' || !p || !p.endsWith('.jsonl')) return null;
  const resolved = path.resolve(p);
  const root = path.resolve(base);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Enumerate transcript files across all projects, newest first (by mtime). Cheap:
 * stat only — callers parse just the top N.
 * @param {string} [base]
 * @returns {{ path: string, sessionId: string, mtimeMs: number, size: number }[]}
 */
function listSessionFiles(base = projectsDir()) {
  /** @type {{ path: string, sessionId: string, mtimeMs: number, size: number }[]} */
  const out = [];
  let dirs; try { dirs = fs.readdirSync(base); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(base, d);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      let s; try { s = fs.statSync(fp); } catch { continue; }
      out.push({ path: fp, sessionId: f.replace(/\.jsonl$/, ''), mtimeMs: s.mtimeMs, size: s.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

const MAX_READ = 4 * 1024 * 1024; // bound one tick's allocation; large backlogs catch up over ticks

/**
 * Read complete new lines appended since `fromOffset` (for the live tail). The
 * transcript is append-only; if it shrank (rotation/truncation) we restart at 0.
 * Reads at most `maxRead` bytes per call (bounded allocation), so a very large
 * transcript is consumed over several ticks rather than in one giant buffer.
 * Returns the new byte offset (advanced only past whole lines).
 * @param {string} file
 * @param {number} [fromOffset]
 * @param {number} [maxRead]
 * @returns {{ offset: number, lines: string[] }}
 */
function readNewLines(file, fromOffset = 0, maxRead = MAX_READ) {
  let st; try { st = fs.statSync(file); } catch { return { offset: fromOffset, lines: [] }; }
  let start = fromOffset;
  if (st.size < start) start = 0;               // truncated/rotated → restart
  let len = st.size - start;
  if (len <= 0) return { offset: st.size, lines: [] };
  const capped = len > maxRead;                 // more data than one window holds
  if (capped) len = maxRead;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) {
      // No complete line in this window. If capped, the current line is longer
      // than the cap — skip past the window to guarantee forward progress (the
      // resulting partial line fails JSON.parse and is tolerated). Otherwise the
      // last line just isn't finished yet; wait for more.
      return capped ? { offset: start + len, lines: [] } : { offset: start, lines: [] };
    }
    const whole = text.slice(0, lastNl);
    const consumed = start + Buffer.byteLength(whole, 'utf8') + 1; // +1 for the newline
    return { offset: consumed, lines: whole.split('\n').filter(Boolean) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse a whole transcript file in one shot. @param {string} file */
function readSession(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return parseEvents(txt);
}

module.exports = {
  DRAIN_WEIGHTS, parseEvents, summarizeArg, currentTranscriptPath,
  listSessionFiles, readNewLines, readSession, projectsDir,
};
