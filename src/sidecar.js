// @ts-check
'use strict';
// src/sidecar.js — the live economy panel that runs in the tmux sidebar.
// Reads the per-session snapshot that `ccr statusline` writes (CCR_STATE_DIR),
// re-renders the economy screen every second (so the imminent band flashes),
// and shows a clean ended/​waiting state. Pure Node, zero dependencies.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeStatus } = require('./normalize');
const { renderEconomy } = require('./render/economy');
const { renderFeed } = require('./render/feed');
const { currentTranscriptPath, readNewLines, parseEvents } = require('./transcripts');

const STATE_DIR = process.env.CCR_STATE_DIR || path.join(os.homedir(), '.ccr');
const SNAPSHOT = path.join(STATE_DIR, 'last-status.json');
const EXITED = path.join(STATE_DIR, 'exited');

// Live feed accumulator: tail the current transcript incrementally (by byte
// offset) and roll up tool/skill events + per-session stats. Reset on session
// switch. Best-effort — must never break the economy panel.
const FEED_CAP = 200;
const feedState = { path: /** @type {string|null} */ (null), offset: 0, events: /** @type {any[]} */ ([]), tools: /** @type {Record<string,number>} */ ({}), commands: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, files: new Set() };

/** @param {string} tpath @returns {any} feed view for renderFeed */
function updateFeed(tpath) {
  if (feedState.path !== tpath) {           // new session → start clean
    feedState.path = tpath; feedState.offset = 0; feedState.events = []; feedState.tools = {};
    feedState.commands = 0; feedState.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }; feedState.files = new Set();
  }
  const { offset, lines } = readNewLines(tpath, feedState.offset);
  feedState.offset = offset;
  if (lines.length) {
    const p = parseEvents(lines);
    for (const e of p.events) feedState.events.push(e);
    if (feedState.events.length > FEED_CAP) feedState.events.splice(0, feedState.events.length - FEED_CAP);
    for (const k of Object.keys(p.stats.tools)) feedState.tools[k] = (feedState.tools[k] || 0) + p.stats.tools[k];
    feedState.commands += p.stats.commands;
    feedState.tokens.input += p.stats.tokens.input;
    feedState.tokens.output += p.stats.tokens.output;
    feedState.tokens.cacheRead += p.stats.tokens.cacheRead;
    feedState.tokens.cacheCreate += p.stats.tokens.cacheCreate;
    for (const f of p.stats.files) feedState.files.add(f);
  }
  return { events: feedState.events, tools: feedState.tools, commands: feedState.commands, tokens: feedState.tokens, files: [...feedState.files] };
}

const dim = (/** @type {string} */ s) => `\x1b[2m${s}\x1b[0m`;
const bold = (/** @type {string} */ s) => `\x1b[1m${s}\x1b[0m`;

let prev = '';
function draw(/** @type {string} */ s) {
  if (s === prev) return;
  prev = s;
  // Cursor home, clear-to-EOL per line, then clear below — flicker-free.
  process.stdout.write('\x1b[H' + s.replace(/\n/g, '\x1b[K\n') + '\x1b[J');
}

function frame() {
  if (fs.existsSync(EXITED)) { draw(bold('ccr') + '  ' + dim('session ended') + '\n'); return; }
  let raw = '';
  try { raw = fs.readFileSync(SNAPSHOT, 'utf8'); } catch { /* none yet */ }
  if (!raw.trim()) { draw(dim('ccr · waiting for the first status tick…') + '\n'); return; }
  let state;
  try { state = JSON.parse(raw); } catch { draw(dim('ccr · status unreadable') + '\n'); return; }
  let out;
  try {
    out = renderEconomy(normalizeStatus(state), { tick: Math.floor(Date.now() / 1000) % 2 === 0 });
  } catch (e) {
    out = dim('ccr render error: ' + (e && e instanceof Error ? e.message : String(e)));
  }
  // Live tool/skills feed below the panel — best-effort; never break the panel.
  try {
    const tpath = currentTranscriptPath(state);
    if (tpath) {
      const feedStr = renderFeed(updateFeed(tpath), { max: 6 });
      if (feedStr) out += '\n\n' + feedStr;
    }
  } catch { /* feed is optional */ }
  draw(out.endsWith('\n') ? out : out + '\n');
}

function run() {
  frame();
  const id = setInterval(frame, 1000);
  const stop = () => { clearInterval(id); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// `updateFeed` is exported for tests (the incremental tail + session-switch
// reset is the subtle part); the live loop uses `run`.
module.exports = { run, updateFeed };
