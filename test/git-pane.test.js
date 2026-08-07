// @ts-check
'use strict';
// test/git-pane.test.js — the identity line's column arithmetic.
//
// features/OUT-OF-SCOPE.md deferred "exact truncation arithmetic" to the build:
// the reviewed contract pins the observable (one row, inside the pane width, the
// distinguishing part of the name kept) and not the maths. These are that
// deferred half, and they exist because the feature scenarios CANNOT see the
// failure they were written for.
//
// The failure, found by rendering against real repositories rather than by
// reading the code: the position marker was handed to the layout already
// wrapped in SGR escapes, and `visibleWidth` — which measures display text and
// knows nothing about colour — scored a dimmed "  2/2" at 13 columns instead of
// 5. Every identity line silently budgeted eight columns it actually had. At 48
// columns that just looked like generous spacing; at 20 it collapsed to
// "c…  …". Both satisfy "the identity line is at most 40 columns wide", which is
// the whole point: a scenario that pins an upper bound cannot catch a line that
// is too SHORT, so the bound gets a companion here that pins the line to the
// pane exactly.

const test = require('node:test');
const assert = require('node:assert');

const { renderGitPane } = require('../src/render/git-pane');
const { visibleWidth, ellipsize } = require('../src/render/shared');

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** @param {Partial<import('../src/git-repo').RepoIdentity>} [over] */
const identity = (over = {}) => ({
  state: /** @type {'ok'} */ ('ok'),
  name: 'ccr',
  branch: 'main',
  detached: false,
  root: '/tmp/ccr',
  launchName: null,
  ...over,
});

const line = (/** @type {any} */ id, /** @type {number} */ width, position = '2/2') =>
  plain(renderGitPane({ identity: id }, { width, position }));

test('the identity line occupies the whole pane width, not merely less than it', () => {
  // Both names are short, so the layout has slack: it must spend that slack on
  // the gap and flush the branch to the right edge. A line narrower than the
  // pane here is the SGR-measurement bug returning.
  for (const width of [20, 32, 40, 48, 72]) {
    assert.strictEqual(visibleWidth(line(identity(), width)), width,
      `at ${width} columns the identity line should fill the pane exactly`);
  }
});

test('the cycle position costs its own width and no more', () => {
  const withPos = line(identity(), 48, '2/3');
  const without = line(identity(), 48, '');
  assert.strictEqual(visibleWidth(withPos), 48);
  assert.strictEqual(visibleWidth(without), 48);
  // "  2/3" is five columns; the branch must sit exactly that much earlier, and
  // the names must not lose anything else to the marker.
  assert.ok(withPos.trimEnd().endsWith('2/3'), `expected the marker last, got "${withPos}"`);
  assert.strictEqual(withPos.indexOf('main') + 5, without.indexOf('main'),
    'the marker shifts the branch left by its own width, nothing more');
});

test('the pinned launch repo survives a branch name long enough to fill the row', () => {
  // The failure this replaces: an inline "launch › current" had to be dropped
  // when the identity row got tight, so a repo with a long branch name silently
  // lost the identity the chosen option promises to keep visible. Its own row
  // cannot be crowded out by a branch.
  const out = line(identity({
    name: 'docs-mirror', launchName: 'ccr', branch: 'ci/latest-lts-and-napi-prebuilds',
  }), 48);
  const rows = out.split('\n');
  assert.match(rows[0], /docs-mirror/, 'row 0 names the repo the session is in');
  assert.match(rows[0], /ci\/latest/, 'and its branch');
  assert.match(rows[1] || '', /launched in ccr/, `the launch repo stays pinned: ${JSON.stringify(rows)}`);
});

test('the launch repo is pinned on its own row, never squeezed into the identity line', () => {
  const rows = line(identity({ name: 'docs-mirror', launchName: 'ccr' }), 48).split('\n');
  assert.strictEqual(rows.length, 2);
  assert.ok(!rows[0].includes('ccr'), `the identity row is the current repo alone: "${rows[0]}"`);
  assert.match(rows[1], /^\s+launched in ccr$/);
  // Even at a width that cannot hold both names side by side, the pin remains.
  const narrow = line(identity({ name: 'ccr', launchName: 'docs-mirror' }), 20).split('\n');
  assert.strictEqual(narrow.length, 2, 'a narrow pane keeps the pin rather than dropping it');
  assert.ok(narrow.every((/** @type {string} */ r) => visibleWidth(r) <= 20), 'and every row stays inside the pane');
});

test('both names overlong: each keeps a readable head rather than one taking it all', () => {
  const out = line(identity({
    name: 'claude-code-runrate-prototype-fork',
    branch: 'feature/instance-slot-owner-rework',
  }), 40);
  assert.strictEqual(visibleWidth(out), 40);
  assert.ok(out.includes('claude-code'), `the repo must stay recognisable: "${out}"`);
  assert.ok(out.includes('feature/'), `the branch must stay recognisable: "${out}"`);
  assert.ok(out.includes('…'), 'a shortened value is marked as shortened');
});

test('the refusal states never carry a branch slot', () => {
  for (const state of /** @type {const} */ (['not-a-repo', 'unreadable'])) {
    const out = line(identity({ state, name: null, branch: null }), 48);
    assert.ok(!out.includes('main'), `${state} must not render a branch: "${out}"`);
    assert.strictEqual(out.split('\n').length, 1, `${state} with no launch repo is one row`);
  }
});

test('ellipsize never exceeds its budget, including on wide glyphs', () => {
  assert.strictEqual(ellipsize('abcdef', 10), 'abcdef');
  assert.strictEqual(visibleWidth(ellipsize('abcdef', 4)), 4);
  assert.strictEqual(ellipsize('abcdef', 4), 'abc…');
  // A CJK glyph costs two columns: cutting by code point alone would overflow.
  assert.ok(visibleWidth(ellipsize('日本語テキスト', 5)) <= 5);
  assert.strictEqual(ellipsize('anything', 0), '');
});
