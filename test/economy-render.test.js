// @ts-check
'use strict';
// Regression: the rendered "% used" meter must FLOOR the fractional
// `used_percentage` Claude reports, to match `/usage` and claude.ai usage
// (which truncate). Rounding read ~1pt high past the half-point — a real
// bug report against the weekly window.

const test = require('node:test');
const assert = require('node:assert');
const { renderEconomy } = require('../src/render/economy');
const { fmtMins } = require('../src/render/shared');

const strip = (/** @type {string} */ s) => s.replace(/\[[0-9;]*m/g, '');

function meterFor(usedPct) {
  const view = {
    model: 'Opus 4.8',
    windowSize: 1_000_000,
    windows: [{ key: 'seven_day', label: 'weekly', usedPct, minutesToReset: 5000, windowMinutes: 10080 }],
  };
  return strip(renderEconomy(view, { theme: 'plain' }));
}

test('weekly meter floors a fractional used_percentage (matches /usage), never rounds up', () => {
  // Past the half-point: round would show 42%, /usage shows 41%.
  assert.match(meterFor(41.6), /\b41% used/);
  assert.ok(!/\b42% used/.test(meterFor(41.6)), 'must not round 41.6 up to 42');
  // Just under: both floor and round agree, but assert the floored figure.
  assert.match(meterFor(41.2), /\b41% used/);
  // A whole number is unchanged.
  assert.match(meterFor(11), /\b11% used/);
});

test('fmtMins caps an absurd time-to-exhaust so the sidebar time column never overflows', () => {
  // A barely-used window → near-zero rate → minutesLeft explodes. The prior
  // "665d12h" (8 cols with the leading ~) overflowed the fixed 7-col field.
  assert.strictEqual(fmtMins(958320), '665d');          // ≥100d: hours dropped
  assert.strictEqual(fmtMins(100 * 1440 + 300), '100d');
  assert.strictEqual(fmtMins(99 * 1440 + 23 * 60), '99d23h'); // <100d keeps precision
  assert.strictEqual(fmtMins(5000 * 1440), '>999d');    // 4-digit days → compact cap
  // The invariant that keeps the meter bars aligned: '~' + fmtMins ≤ 7 columns.
  for (const m of [59, 600, 1441, 958320, 99999999]) {
    assert.ok(('~' + fmtMins(m)).length <= 7, `~${fmtMins(m)} must fit the 7-col field`);
  }
});

test('the 5h and weekly meter bars stay vertically aligned at an absurd time-to-exhaust', () => {
  // Regression: the weekly window barely moves (usedPct 1, near-zero rate) so its
  // time-to-exhaust was "~665d12h" — 8 cols — which shoved its meter one column
  // right of the 5h bar. The two bars must share a column.
  const view = {
    model: 'Fable 5', windowSize: 1000000,
    windows: [
      { key: 'five_hour', label: '5h', usedPct: 78, minutesToReset: 90, windowMinutes: 300 },
      { key: 'seven_day', label: 'weekly', usedPct: 1, minutesToReset: 400, windowMinutes: 10080 },
    ],
  };
  const rows = strip(renderEconomy(view, { theme: 'plain' })).split('\n').filter((l) => /●/.test(l));
  assert.strictEqual(rows.length, 2, 'both wall rows rendered');
  const barCol = (/** @type {string} */ l) => l.search(/[▓░]/);
  assert.strictEqual(barCol(rows[0]), barCol(rows[1]), 'both meter bars share one column');
});
