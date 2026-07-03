// @ts-check
'use strict';
// Unit test for src/account-limits.js — cross-profile meter reconciliation and,
// above all, the different-account guard.

const test = require('node:test');
const assert = require('node:assert');
const { accountFingerprint, mergeAccountLimits } = require('../src/account-limits');

const T5 = 1_783_101_000; // 5h reset instant (epoch s)
const TW = 1_783_616_400; // weekly reset instant

/** A same-account snapshot's rate_limits at a given usage. */
const acct = (five, week, extra = {}) => ({
  five_hour: { used_percentage: five, resets_at: T5 },
  seven_day: { used_percentage: week, resets_at: TW },
  ...extra,
});

test('raises each meter to the freshest same-account value', () => {
  const local = acct(15, 18);                 // idle profile, slightly behind
  const busy = acct(16, 19);                  // busier sibling, ahead
  const merged = mergeAccountLimits(local, [busy]);
  assert.strictEqual(merged.five_hour.used_percentage, 16);
  assert.strictEqual(merged.seven_day.used_percentage, 19);
  // reset instants are never adopted from the sibling — only the used% moves.
  assert.strictEqual(merged.five_hour.resets_at, T5);
  assert.strictEqual(merged.seven_day.resets_at, TW);
});

test('never lowers a meter (local already ahead wins)', () => {
  const merged = mergeAccountLimits(acct(40, 50), [acct(10, 12)]);
  assert.strictEqual(merged.five_hour.used_percentage, 40);
  assert.strictEqual(merged.seven_day.used_percentage, 50);
});

test('the model in use is irrelevant — Opus and Fable reconcile', () => {
  // Real-world repro: cq=Opus, cw=Fable, identical account-wide buckets.
  const cq = acct(15, 18);
  const cw = acct(16, 19);
  assert.strictEqual(mergeAccountLimits(cq, [cw]).seven_day.used_percentage, 19);
});

test('GUARD: a DIFFERENT account is never merged (weekly reset differs)', () => {
  const local = acct(15, 18);
  // Same 5h reset by coincidence, but a different weekly reset → different account.
  const foreign = { five_hour: { used_percentage: 99, resets_at: T5 },
                    seven_day: { used_percentage: 99, resets_at: TW + 12345 } };
  const merged = mergeAccountLimits(local, [foreign]);
  assert.strictEqual(merged, local, 'foreign account must be ignored wholesale');
  assert.strictEqual(merged.five_hour.used_percentage, 15);
});

test('GUARD: a foreign account cannot even bump a coincidentally-aligned bucket', () => {
  const local = acct(15, 18);
  const foreign = { five_hour: { used_percentage: 88, resets_at: T5 },   // aligned…
                    seven_day: { used_percentage: 88, resets_at: TW + 1 } }; // …but weekly differs
  // Fingerprint mismatch distrusts the WHOLE sibling, so even the aligned 5h stays put.
  assert.strictEqual(mergeAccountLimits(local, [foreign]).five_hour.used_percentage, 15);
});

test('GUARD: a rolled-window sibling (stale) is distrusted, not treated as fresh', () => {
  const local = acct(15, 18);
  // Sibling already crossed the 5h boundary: new reset instant, counter reset low.
  const rolled = { five_hour: { used_percentage: 2, resets_at: T5 + 18000 },
                   seven_day: { used_percentage: 19, resets_at: TW } };
  const merged = mergeAccountLimits(local, [rolled]);
  // Fingerprint differs (5h reset moved) → no merge at all; local numbers stand.
  assert.strictEqual(merged.five_hour.used_percentage, 15);
  assert.strictEqual(merged.seven_day.used_percentage, 18);
});

test('picks the max across several same-account siblings', () => {
  const merged = mergeAccountLimits(acct(15, 18), [acct(16, 17), acct(14, 22), acct(20, 19)]);
  assert.strictEqual(merged.five_hour.used_percentage, 20);
  assert.strictEqual(merged.seven_day.used_percentage, 22);
});

test('model-scoped buckets do not anchor the account, but reconcile when present', () => {
  // Account-wide 5h/weekly define the account; a shared Opus-weekly also bumps.
  const local = acct(15, 18, { seven_day_opus: { used_percentage: 30, resets_at: TW } });
  const sib = acct(16, 19, { seven_day_opus: { used_percentage: 42, resets_at: TW } });
  const merged = mergeAccountLimits(local, [sib]);
  assert.strictEqual(merged.seven_day_opus.used_percentage, 42);
});

test('a sibling with a different model-scoped bucket still reconciles the shared ones', () => {
  // cw runs Fable (no opus bucket); it must still refresh 5h/weekly for an Opus local.
  const local = acct(15, 18, { seven_day_opus: { used_percentage: 30, resets_at: TW } });
  const fableSib = acct(16, 19); // no seven_day_opus
  const merged = mergeAccountLimits(local, [fableSib]);
  assert.strictEqual(merged.five_hour.used_percentage, 16);
  assert.strictEqual(merged.seven_day.used_percentage, 19);
  assert.strictEqual(merged.seven_day_opus.used_percentage, 30); // untouched, no sibling data
});

test('no usable account-wide bucket → nothing to anchor, returns local unchanged', () => {
  const local = { seven_day_opus: { used_percentage: 30, resets_at: TW } };
  assert.strictEqual(mergeAccountLimits(local, [acct(99, 99)]), local);
});

test('accountFingerprint ignores model-scoped buckets and ordering', () => {
  const a = accountFingerprint(acct(15, 18, { seven_day_opus: { used_percentage: 1, resets_at: TW } }));
  const b = accountFingerprint({ seven_day: { used_percentage: 77, resets_at: TW },
                                 five_hour: { used_percentage: 77, resets_at: T5 } });
  assert.strictEqual(a, b, 'same account-wide windows → same fingerprint regardless of order/usage');
});

test('tolerates ISO-string resets_at (same instant matches numeric)', () => {
  const iso = new Date(TW * 1000).toISOString();
  const local = { five_hour: { used_percentage: 15, resets_at: T5 },
                  seven_day: { used_percentage: 18, resets_at: iso } };
  const sib = acct(16, 25); // numeric resets_at
  const merged = mergeAccountLimits(local, [sib]);
  assert.strictEqual(merged.seven_day.used_percentage, 25, 'ISO vs epoch must not defeat matching');
});
