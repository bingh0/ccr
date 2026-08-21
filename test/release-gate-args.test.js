// @ts-check
'use strict';
// test/release-gate-args.test.js — the argument surface the pre-push hook uses.
//
// The hook passes two shas it resolved itself: the sha being pushed, and the
// LIVE public tip from `git ls-remote`. Everything about whether the scan looks
// at the right commits rests on those two values arriving intact, so the
// parsing fails closed rather than guessing. A mistyped sha that silently
// scanned some other range would report "clean" and mean nothing.

const test = require('node:test');
const assert = require('node:assert');
const { parseArgs, requireOid } = require('../scripts/release-gate.js');

const OID = 'a'.repeat(40);

/** requireOid and parseArgs report to stderr; tests read return values. */
function quiet(/** @type {() => any} */ fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

test('no arguments is the publish path, unchanged', () => {
  assert.deepStrictEqual(parseArgs([]), { prePush: false, tip: null, published: null });
});

test('the pre-push form carries both ends of the range', () => {
  const b = 'b'.repeat(40);
  assert.deepStrictEqual(parseArgs(['--pre-push', '--tip', OID, '--published', b]),
    { prePush: true, tip: OID, published: b });
});

test('an unknown argument is refused rather than ignored', () => {
  // Ignoring it would let `--publised <sha>` (typo) fall through to the
  // default range, scan the wrong thing, and pass.
  assert.strictEqual(quiet(() => parseArgs(['--publised', OID])), null);
});

test('a flag with no value does not silently become the next flag', () => {
  const got = parseArgs(['--tip']);
  assert.deepStrictEqual(got, { prePush: false, tip: null, published: null });
});

test('requireOid takes only a full object id, and normalises case', () => {
  assert.strictEqual(requireOid(OID, 'tip'), OID);
  assert.strictEqual(requireOid('A'.repeat(40), 'tip'), OID, 'a capitalised sha is the same sha');
  assert.strictEqual(requireOid('c'.repeat(64), 'tip'), 'c'.repeat(64), 'sha-256 repositories too');
});

test('requireOid refuses anything short of a full id', () => {
  // An abbreviated sha is the dangerous input: it looks right, and git would
  // even resolve it — but this scan takes the value literally.
  for (const bad of ['deadbeef', '', null, undefined, 'refs/heads/main', OID + 'a', 42]) {
    assert.strictEqual(quiet(() => requireOid(/** @type {any} */ (bad), 'tip')), null, `must refuse ${String(bad)}`);
  }
});
