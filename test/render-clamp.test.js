// @ts-check
'use strict';
// Unit tests for clampVisible — the ANSI-aware per-line width clamp that keeps
// the sidecar from soft-wrapping (and corrupting its cursor-home redraw) in a
// narrow cmd/PowerShell/split pane.

const test = require('node:test');
const assert = require('node:assert');
const { clampVisible, dim, red, bar } = require('../src/render/shared');

const visible = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('clampVisible: no-op when cols is missing or non-positive', () => {
  const s = red('hello world');
  assert.strictEqual(clampVisible(s, undefined), s);
  assert.strictEqual(clampVisible(s, 0), s);
  assert.strictEqual(clampVisible(s, -5), s);
});

test('clampVisible: truncates plain text to cols visible columns', () => {
  const out = clampVisible('abcdefghij', 4);
  assert.strictEqual(visible(out), 'abcd');
  assert.ok(out.endsWith('\x1b[0m'), 'appends a reset after cutting');
});

test('clampVisible: SGR escapes have zero width; a fitting colour line is untouched', () => {
  const s = dim('1234'); // 4 visible cols wrapped in escapes
  assert.strictEqual(clampVisible(s, 10), s, 'fits within cols → returned verbatim');
  assert.strictEqual(visible(clampVisible(s, 10)), '1234');
});

test('clampVisible: a colour run cut mid-string is reset so it cannot bleed', () => {
  const out = clampVisible(red('abcdef'), 3);
  assert.strictEqual(visible(out), 'abc', 'exactly cols visible chars kept');
  assert.ok(out.includes('\x1b[31m'), 'opening colour preserved');
  assert.ok(out.endsWith('\x1b[0m'), 'closed with a reset');
});

test('clampVisible: block-bar glyphs count as one column each', () => {
  // bar(50, 10) is 10 glyphs; clamp to 6 keeps 6 of them.
  const out = clampVisible(bar(50, 10), 6);
  assert.strictEqual(visible(out).length, 6);
});

test('clampVisible: a line exactly cols wide is not cut (no spurious reset)', () => {
  const out = clampVisible('abcde', 5);
  assert.strictEqual(out, 'abcde');
});
