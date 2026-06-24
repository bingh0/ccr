// @ts-check
'use strict';
// Unit test for src/rate-limits.js — bucket discovery across plan shapes.

const test = require('node:test');
const assert = require('node:assert');
const { discoverWindows } = require('../src/rate-limits');

test('discovers and labels known, model-scoped, and monthly buckets', () => {
  const now = 1_000_000; // seconds
  const ws = discoverWindows({
    five_hour: { used_percentage: 30, resets_at: now + 3600 },
    seven_day: { used_percentage: 18, resets_at: now + 7 * 86400 },
    seven_day_sonnet: { used_percentage: 60, resets_at: now + 2 * 86400 },
    monthly: { used_percentage: 5, resets_at: now + 30 * 86400 },
  }, now);

  assert.strictEqual(ws.length, 4);
  // sorted shortest-window first
  assert.strictEqual(ws[0].key, 'five_hour');
  assert.strictEqual(ws[0].label, '5h');
  assert.strictEqual(ws[0].windowMinutes, 300);

  const byKey = Object.fromEntries(ws.map((w) => [w.key, w]));
  assert.strictEqual(byKey.seven_day.label, 'weekly');
  assert.strictEqual(byKey.seven_day.windowMinutes, 10080);
  assert.strictEqual(byKey.seven_day_sonnet.label, 'weekly · Sonnet');
  assert.strictEqual(byKey.seven_day_sonnet.modelScope, 'Sonnet');
  assert.strictEqual(byKey.seven_day_sonnet.windowMinutes, 10080);
  assert.strictEqual(byKey.monthly.label, 'monthly');
  assert.strictEqual(byKey.monthly.windowMinutes, 43200);

  assert.ok(ws.every((w) => w.minutesToReset > 0), 'all reset times finite + positive');
});

test('returns [] for an API session (no buckets)', () => {
  assert.deepStrictEqual(discoverWindows({}, 1000), []);
  assert.deepStrictEqual(discoverWindows(null, 1000), []);
});

test('skips buckets with no used_percentage', () => {
  assert.strictEqual(discoverWindows({ five_hour: { resets_at: 123 } }, 1000).length, 0);
});

test('an unknown bucket still surfaces (renders even without an inferable window)', () => {
  const ws = discoverWindows({ mystery_pool: { used_percentage: 50 } }, 1000);
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].label, 'mystery pool');
  assert.strictEqual(ws[0].windowMinutes, null);
  assert.strictEqual(ws[0].minutesToReset, null);
});
