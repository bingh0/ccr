// @ts-check
'use strict';
// Unit test for src/economy-model.js — the `ccr economy --json` contract.
// Locks the shape and the key invariants outside devs will code against.

const test = require('node:test');
const assert = require('node:assert');
const { computeEconomy, SCHEMA_VERSION } = require('../src/economy-model');

// A live, pressured session: the 5h window is burning and would exhaust before
// it resets (rate supplied directly so the estimate is deterministic), context
// well above baseline so clearing is worthwhile.
function pressuredView() {
  return {
    model: 'Opus 4.8',
    windowSize: 1_000_000,
    contextTokens: 262_000,
    cachedPct: null,
    baselineTok: 14_000,
    costUsd: 4.2,
    durationMin: 30,
    branch: 'main',
    windows: [
      { key: 'five_hour', label: '5h', usedPct: 80, rate: 0.5, minutesToReset: 200, windowMinutes: 300 },
      { key: 'seven_day', label: 'weekly', usedPct: 18, rate: 0.01, minutesToReset: 8000, windowMinutes: 10080 },
    ],
  };
}

test('emits the versioned contract shape', () => {
  const m = computeEconomy(pressuredView());
  assert.strictEqual(m.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(m.model, 'Opus 4.8');
  for (const k of ['context', 'windows', 'binding', 'clear', 'session']) {
    assert.ok(k in m, `missing top-level key: ${k}`);
  }
  assert.deepStrictEqual(Object.keys(m.context), ['tokens', 'windowSize', 'pct', 'cachedPct']);
  assert.deepStrictEqual(Object.keys(m.session), ['costUsd', 'durationMin', 'branch']);
});

test('context pct is tokens/windowSize, raw (unrounded)', () => {
  const m = computeEconomy(pressuredView());
  assert.strictEqual(m.context.tokens, 262_000);
  assert.strictEqual(m.context.pct, (262_000 / 1_000_000) * 100);
});

test('identifies the binding window and bands it', () => {
  const m = computeEconomy(pressuredView());
  // 5h: (100-80)/0.5 = 40 min left < 200 to reset → it binds, and 40 ≤ WARN(120)
  assert.strictEqual(m.binding.key, 'five_hour');
  assert.strictEqual(m.binding.band, 'warn');
  const five = m.windows.find((w) => w.key === 'five_hour');
  assert.strictEqual(five.binding, true);
  assert.strictEqual(five.minutesLeft, 40);
  assert.strictEqual(five.resetsBeforeHit, false);
  // weekly resets long before it would exhaust → not binding
  const week = m.windows.find((w) => w.key === 'seven_day');
  assert.strictEqual(week.binding, false);
  assert.strictEqual(week.resetsBeforeHit, true);
});

test('clear is worthwhile and buys positive minutes when context is high', () => {
  const m = computeEconomy(pressuredView());
  assert.strictEqual(m.clear.worthwhile, true);
  assert.ok(m.clear.boughtMinutes > 0);
  assert.strictEqual(m.clear.baselineTokens, 14_000);
});

test('degrades cleanly on an API session (no windows)', () => {
  const m = computeEconomy({ model: 'Opus 4.8', windowSize: 200_000, contextTokens: null, windows: [] });
  assert.strictEqual(m.schemaVersion, SCHEMA_VERSION);
  assert.deepStrictEqual(m.windows, []);
  assert.strictEqual(m.binding, null);
  assert.strictEqual(m.clear.worthwhile, false);
  assert.strictEqual(m.context.pct, null);
});

test('is JSON-serialisable with no undefined leaks', () => {
  const m = computeEconomy(pressuredView());
  const round = JSON.parse(JSON.stringify(m));
  assert.deepStrictEqual(round, m); // every value survives JSON (no undefined/NaN holes)
});
