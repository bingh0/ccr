// @ts-check
'use strict';
// Step definitions for features/account-limits.feature — drives the pure
// reconciliation core in src/account-limits.js (no disk; the guard logic is what
// these ACs pin).

const assert = require('node:assert');
const { mergeAccountLimits } = require('../../src/account-limits');

const T5 = 1_783_101_000; // shared 5h reset instant
const TW = 1_783_616_400; // shared weekly reset instant

/** A same-account rate_limits object. */
const acct = (five, week) => ({
  five_hour: { used_percentage: five, resets_at: T5 },
  seven_day: { used_percentage: week, resets_at: TW },
});

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineAccountLimitsSteps(reg) {
  // --- Local profile capture ---
  reg.define(/^the local profile last captured 5h at (\d+)% and weekly at (\d+)%$/, (w, five, week) => {
    w.local = acct(Number(five), Number(week));
    w.siblings = [];
  });

  // --- Siblings ---
  reg.define(/^a sibling profile on the same account shows 5h at (\d+)% and weekly at (\d+)%$/, (w, five, week) => {
    w.siblings.push(acct(Number(five), Number(week)));
  });
  reg.define(/^a sibling profile on a different account shows 5h at (\d+)% and weekly at (\d+)%$/, (w, five, week) => {
    // Different account → different reset instants on BOTH account-wide windows.
    w.siblings.push({
      five_hour: { used_percentage: Number(five), resets_at: T5 + 777 },
      seven_day: { used_percentage: Number(week), resets_at: TW + 4242 },
    });
  });
  reg.define(/^a sibling whose 5h reset aligns but whose weekly reset differs shows 5h at (\d+)%$/, (w, five) => {
    w.siblings.push({
      five_hour: { used_percentage: Number(five), resets_at: T5 },      // coincidental alignment
      seven_day: { used_percentage: 88, resets_at: TW + 1 },            // …weekly gives it away
    });
  });
  reg.define(/^a sibling whose 5h window has already rolled shows 5h at (\d+)%$/, (w, five) => {
    w.siblings.push({
      five_hour: { used_percentage: Number(five), resets_at: T5 + 18000 }, // next window
      seven_day: { used_percentage: 19, resets_at: TW },
    });
  });
  reg.define(/^same-account siblings report weekly at (\d+)%, (\d+)% and (\d+)%$/, (w, a, b, c) => {
    for (const week of [a, b, c]) w.siblings.push(acct(15, Number(week)));
  });

  // --- Action ---
  reg.define(/^the meters are reconciled$/, (w) => {
    w.merged = mergeAccountLimits(w.local, w.siblings);
  });

  // --- Assertions ---
  reg.define(/^the local 5h meter reads (\d+)%$/, (w, pct) => {
    assert.strictEqual(w.merged.five_hour.used_percentage, Number(pct));
  });
  reg.define(/^the local weekly meter reads (\d+)%$/, (w, pct) => {
    assert.strictEqual(w.merged.seven_day.used_percentage, Number(pct));
  });
};
