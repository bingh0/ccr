// @ts-check
'use strict';
// test/probe-wt.test.js — the verdict logic of scripts/probe-wt.js.
//
// The probe runs only on Windows, but the part that decides what its output
// MEANS is a pure function, and it is the part a release decision would rest
// on. A diagnostic nobody can test is not evidence, so the classification is
// tested here on every platform; only the tab-opening is Windows-only.

const test = require('node:test');
const assert = require('node:assert');
const { classify, samePath } = require('../scripts/probe-wt.js');

const CASE = { id: 'x', what: 'a path', dir: 'C:\\Users\\me\\proj' };

test('a tab that landed where it was asked reads as ok', () => {
  const r = classify(CASE, null, 'C:\\Users\\me\\proj\r\n');
  assert.strictEqual(r.kind, 'ok');
  assert.strictEqual(r.reported, 'C:\\Users\\me\\proj');
});

test('a tab that landed elsewhere is a divergence, and says where', () => {
  const r = classify(CASE, null, 'C:\\WINDOWS\r\n');
  assert.strictEqual(r.kind, 'diverged');
  assert.strictEqual(r.reported, 'C:\\WINDOWS', 'the actual directory is what the report is for');
});

test('a tab that never wrote is a missing tab, not a silent pass', () => {
  // The failure mode that would make the probe useless: treating "no output"
  // as "fine". This is the case that decides whether `-d` can cost the tab.
  assert.strictEqual(classify(CASE, null, null).kind, 'no-tab');
  assert.strictEqual(classify(CASE, 'wt exited 1', null).kind, 'no-tab');
});

test('a fixture that could not be built is skipped, never counted as ok', () => {
  const r = classify({ ...CASE, skip: 'needs elevation' }, null, null);
  assert.strictEqual(r.kind, 'skipped');
  assert.match(r.verdict, /needs elevation/, 'the reason has to survive into the report');
});

test('an empty result is reported as empty rather than matching anything', () => {
  const r = classify(CASE, null, '   \r\n');
  assert.strictEqual(r.kind, 'diverged');
  assert.strictEqual(r.reported, '(empty)');
});

test('path comparison is case-insensitive and ignores a trailing separator', () => {
  // Windows reports the cwd in whatever case the filesystem holds, and `cd`
  // prints a drive root as "C:\" — neither is a divergence.
  assert.ok(samePath('C:\\Users\\Me\\Proj', 'c:\\users\\me\\proj'));
  assert.ok(samePath('C:\\Users\\me\\proj\\', 'C:\\Users\\me\\proj'));
  assert.ok(!samePath('C:\\Users\\me\\proj2', 'C:\\Users\\me\\proj'));
  // A UNC path must not be mangled into equality with anything else.
  assert.ok(!samePath('C:\\WINDOWS', '\\\\localhost\\c$\\Windows'));
});
