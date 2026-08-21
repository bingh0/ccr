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

function meterFor(/** @type {number} */ usedPct) {
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

test('the used% column widens only when a row is actually in the critical zone', () => {
  // The decimal is a salience cue, so it must not cost two columns of a narrow
  // sidebar for the whole time nothing is near the wall. Below the zone the
  // meter row is byte-identical to what it was before precision existed.
  const view = (/** @type {number} */ fivePct) => ({
    model: 'Fable 5', windowSize: 1000000,
    windows: [
      { key: 'five_hour', label: '5h', usedPct: fivePct, minutesToReset: 120, windowMinutes: 300 },
      { key: 'seven_day', label: 'weekly', usedPct: 62.3, minutesToReset: 4000, windowMinutes: 10080 },
    ],
  });
  const meters = (/** @type {number} */ p) =>
    strip(renderEconomy(view(p), { theme: 'plain' })).split('\n').filter((l) => /[▓░]/.test(l));

  const calm = meters(80.4);
  assert.match(calm[0], / 80% used/, 'below the zone: whole number, single space');
  assert.match(calm[1], / 62% used/, 'the sibling row keeps its narrow column too');

  const zone = meters(98.76);
  assert.match(zone[0], / 98\.7% used/, 'in the zone: one truncated decimal');
  assert.match(zone[1], /   62% used/, 'the sibling row pads so both align on the %');

  // The alignment invariant holds in both states: the "% used" labels line up.
  for (const rows of [calm, zone]) {
    const pctCol = (/** @type {string} */ l) => l.indexOf('% used');
    assert.strictEqual(pctCol(rows[0]), pctCol(rows[1]), 'both used% figures share one column');
  }
});

test('a used% at or past 100 stays a whole number', () => {
  // usedLabel's upper guard: "100.0% used" would be a wider column for a value
  // whose extra digit says nothing — you are past the wall either way.
  const at = (/** @type {number} */ p) => strip(renderEconomy({
    model: 'Fable 5', windowSize: 1000000,
    windows: [{ key: 'five_hour', label: '5h', usedPct: p, minutesToReset: 120, windowMinutes: 300 }],
  }, { theme: 'plain' }));
  assert.match(at(100), /\b100% used/);
  assert.ok(!/100\.0% used/.test(at(100)), 'no decimal at 100');
  assert.match(at(103.4), /\b103% used/);
});
