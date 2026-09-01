// @ts-check
'use strict';
// test/scan-package-shape.test.js — the tarball privacy scan must actually
// read the tarball's files.
//
// WHY THIS FILE EXISTS. scan-package is the last guard between the repository
// and npm: it reads every file that would ship and refuses on anything private.
// It asks npm which files those are, via `npm pack --dry-run --json`.
//
// npm has shipped three different shapes for that JSON — a bare entry, a
// one-element array (npm 8-11), and an object keyed by package name (npm 12).
// The script understood the first two. On npm 12 it reached for `.files` on
// the wrong object, got undefined, scanned an EMPTY LIST, and printed
// "package scan clean — 0 file(s)". It reported clean because it had looked at
// nothing, and it did so through the 0.6.0 publish.
//
// Two things are pinned here: that every known shape is unwrapped, and — the
// one that would have caught this — that the real probe names real files. A
// guard whose input can silently become empty is not a guard.

const test = require('node:test');
const assert = require('node:assert');
const { packedFiles, packEntry } = require('../scripts/scan-package.js');

const FILES = [{ path: 'package.json', size: 1, mode: 420 }];

test('the npm 12 shape — an object keyed by package name — is unwrapped', () => {
  const entry = packEntry({ 'claude-code-runrate': { name: 'x', files: FILES } });
  assert.deepStrictEqual(entry && entry.files, FILES);
});

test('the npm 8-11 shape — a one-element array — is unwrapped', () => {
  assert.deepStrictEqual(packEntry([{ name: 'x', files: FILES }]).files, FILES);
});

test('a bare entry object is unwrapped', () => {
  assert.deepStrictEqual(packEntry({ name: 'x', files: FILES }).files, FILES);
});

// The whole point: a shape nobody anticipated must not read as "no files".
test('an unrecognised shape yields no entry, so the caller can refuse', () => {
  assert.strictEqual(packEntry({ something: { unexpected: true } }), null);
  assert.strictEqual(packEntry(null), null);
  assert.strictEqual(packEntry('a string'), null);
});

// The control that would have caught the real defect: not "does the parser
// work on shapes we wrote down", but "does the live probe still see files".
test('the live probe names the files npm would really pack', () => {
  const pack = packedFiles();
  assert.ok(pack.ok, `the probe must succeed on this npm: ${pack.why}`);
  assert.ok(pack.files.length > 10,
    `scanned only ${pack.files.length} file(s) — the scan is reading nothing and would report clean`);
  assert.ok(pack.files.includes('package.json'), 'package.json always ships');
});
