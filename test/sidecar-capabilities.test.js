// @ts-check
'use strict';
// test/sidecar-capabilities.test.js — the structural half of the sidecar's
// trust boundary (docs/PANE-CONTRACT.md, "Threat model").
//
// The behavioural rules in features/pane-blobs.feature all assume the renderer
// is OURS: they say what ccr does with a hostile blob. They are worth nothing
// against a hostile *renderer*, because an attacker who controls the rendering
// code rewrites the rules — and nothing in Node stops that process reattaching
// to the tmux socket at its predictable path and typing into the agent's pane.
//
// Containment for that threat is structural: the sidecar holds no capability it
// does not need in order to draw. This file asserts that against the module
// graph itself, so it survives any rewrite of the rendering logic beneath it.
//
// These assertions are ALLOWLISTS on purpose. If a change makes one fail, the
// fix is not to widen the list reflexively — it is to ask whether the pane
// renderer really needs to spawn, connect, or read input, and to route the need
// through the launcher (which legitimately has that authority) instead. Widening
// is a deliberate act, which is the whole point of pinning it here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'sidecar.js');

// The only Node builtins the sidecar may reach, transitively. Reading files and
// joining paths is the entire job; everything else is a capability.
//
// WIDENED DELIBERATELY on 2026-08-06, per this file's own rule that widening
// must be an act with a reason. The git pane's working-tree section reads
// `.git` itself (the fork ruled in src/git-repo.js), which requires exactly
// two more builtins: `node:zlib` (git objects are deflate streams) and
// `node:crypto` (the modified-check hashes worktree files the way git names
// blobs). Both are pure computation over bytes already readable through
// node:fs — neither can spawn, connect, listen, or read input, so the threat
// this allowlist exists to contain (a rewritten renderer reattaching to the
// tmux socket) gains nothing from either. The capabilities that would matter
// stay out: child_process, net, http, dgram, worker_threads, vm, repl.
const ALLOWED_BUILTINS = new Set(['node:fs', 'node:path', 'node:os', 'node:zlib', 'node:crypto']);

/**
 * Every in-repo file transitively required from `entry`, mapped to its source.
 * Relative requires are followed; bare/`node:` specifiers are recorded by the
 * callers below rather than walked.
 * @param {string} entry
 * @returns {Map<string, string>}
 */
function moduleGraph(entry) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  (function walk(/** @type {string} */ file) {
    const resolved = require.resolve(file);
    if (seen.has(resolved) || !resolved.startsWith(ROOT) || resolved.includes('node_modules')) return;
    const src = fs.readFileSync(resolved, 'utf8');
    seen.set(resolved, src);
    for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      if (m[1].startsWith('.')) walk(path.join(path.dirname(resolved), m[1]));
    }
  })(entry);
  return seen;
}

const GRAPH = moduleGraph(ENTRY);
// POSIX separators regardless of host: these values are compared against
// literals like 'src/render/economy.js', and path.relative yields backslashes
// on Windows — which made the graph-walk assertions fail there while passing
// everywhere else.
const rel = (/** @type {string} */ f) => path.relative(ROOT, f).split(path.sep).join('/');

test('sidecar graph reaches only fs, path, and os', () => {
  /** @type {string[]} */
  const violations = [];
  for (const [file, src] of GRAPH) {
    for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) continue;
      if (!ALLOWED_BUILTINS.has(spec)) violations.push(`${rel(file)} requires ${spec}`);
    }
  }
  assert.deepStrictEqual(violations, [],
    'the pane renderer must not gain process or network capability — a renderer that can '
    + 'exec or connect is a renderer that can inject into the Claude pane or exfiltrate. '
    + `Allowed: ${[...ALLOWED_BUILTINS].join(', ')}.`);
});

test('sidecar graph never reads stdin', () => {
  /** @type {string[]} */
  const violations = [];
  for (const [file, src] of GRAPH) {
    for (const pattern of [/process\.stdin/, /\/dev\/stdin/, /\breadline\b/]) {
      if (pattern.test(src)) violations.push(`${rel(file)} matches ${pattern}`);
    }
  }
  assert.deepStrictEqual(violations, [],
    'the sidecar must have no input channel: with stdin unread, terminal-response '
    + 'channels and echoed keystrokes are structurally dead rather than filtered.');
});

test('sidecar graph requires nothing computed at runtime', () => {
  /** @type {string[]} */
  const violations = [];
  for (const [file, src] of GRAPH) {
    // A require whose first non-space character is not a single quote: a
    // variable, a template literal, a concatenation — any of which could name a
    // producer-supplied path.
    for (const m of src.matchAll(/require\(\s*(?!')/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      violations.push(`${rel(file)}:${line}`);
    }
  }
  assert.deepStrictEqual(violations, [],
    'no path from configuration, a blob, or a producer may ever be require()d — '
    + 'the permanent fence in docs/PANE-CONTRACT.md is that producer code never '
    + 'runs in ccr\'s process. A pane is data all the way down.');
});

// ── The hotkey host, and the wall between it and the renderer ────────────────
//
// `ccr sidecar --keys` gives ccr a key on hosts that bind none (VS Code and its
// forks). That is only safe because the reader and the renderer are DIFFERENT
// PROCESSES: the parent owns the terminal's stdin, the child draws with its
// stdin closed. Prose cannot hold that apart — a single `require` in either
// direction collapses it back into one process that both reads keys and renders
// untrusted blob text, and every test above would still pass.
//
// So both directions are pinned. These are the assertions that make the answer
// to "why is this not just a stdin listener on the panel?" a fact rather than an
// intention.

const KEYS_ENTRY = path.join(ROOT, 'src', 'sidecar-keys.js');

test('the renderer can never reach the hotkey host', () => {
  const names = [...GRAPH.keys()].map(rel);
  // step-lint: allow unearned-absence -- "the graph walk actually found the sidecar and its renderers" below is this file's control arm: it proves GRAPH is populated and names three modules it must contain, so an empty walk cannot make this refusal vacuous
  assert.ok(!names.includes('src/sidecar-keys.js'),
    'src/sidecar.js now reaches the key reader — the renderer would gain an input '
    + 'channel, which is precisely the capability docs/PANE-CONTRACT.md says it lacks.');
});

test('the hotkey host can never reach a renderer', () => {
  const keysGraph = moduleGraph(KEYS_ENTRY);
  assert.ok(keysGraph.has(KEYS_ENTRY), 'entry point missing from the walked graph');
  const reached = [...keysGraph.keys()].map(rel)
    .filter((f) => f === 'src/sidecar.js' || f.startsWith('src/render/'));
  assert.deepStrictEqual(reached, [],
    'the process that owns the terminal\'s stdin must never be the process that '
    + 'draws producer-authored text. It reads keys and writes a counter; that is all.');
});

test('the hotkey host spawns the panel with its stdin closed', () => {
  const src = fs.readFileSync(KEYS_ENTRY, 'utf8');
  // The separation is worth nothing if the child inherits this terminal's stdin:
  // the renderer would be readable-from again through the same tty, and the two
  // processes would race for every keystroke.
  assert.match(src, /stdio:\s*\['ignore',\s*'inherit',\s*'inherit'\]/,
    'the panel child must be spawned with stdin ignored');
});

test('the graph walk actually found the sidecar and its renderers', () => {
  // A regex that silently matches nothing would make every test above vacuous.
  assert.ok(GRAPH.has(ENTRY), 'entry point missing from the walked graph');
  assert.ok(GRAPH.size >= 10, `walked only ${GRAPH.size} files — the graph walk is not reaching the render layer`);
  const names = [...GRAPH.keys()].map(rel);
  for (const expected of ['src/render/economy.js', 'src/sanitize.js', 'src/transcripts.js']) {
    assert.ok(names.includes(expected), `${expected} missing from the walked graph`);
  }
});
