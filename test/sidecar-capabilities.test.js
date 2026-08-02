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
const ALLOWED_BUILTINS = new Set(['node:fs', 'node:path', 'node:os']);

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
const rel = (/** @type {string} */ f) => path.relative(ROOT, f);

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

test('the graph walk actually found the sidecar and its renderers', () => {
  // A regex that silently matches nothing would make every test above vacuous.
  assert.ok(GRAPH.has(ENTRY), 'entry point missing from the walked graph');
  assert.ok(GRAPH.size >= 10, `walked only ${GRAPH.size} files — the graph walk is not reaching the render layer`);
  const names = [...GRAPH.keys()].map(rel);
  for (const expected of ['src/render/economy.js', 'src/sanitize.js', 'src/transcripts.js']) {
    assert.ok(names.includes(expected), `${expected} missing from the walked graph`);
  }
});
