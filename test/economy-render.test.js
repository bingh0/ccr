// @ts-check
'use strict';
// Regression: the rendered "% used" meter must FLOOR the fractional
// `used_percentage` Claude reports, to match `/usage` and claude.ai usage
// (which truncate). Rounding read ~1pt high past the half-point — a real
// bug report against the weekly window.
//
// Since 0.6.2 this file also holds the WIDTH contract. features/economy.feature
// pins the behaviour at two named pane widths; the sweep here walks every width
// from 36 (the narrowest the row is designed to reach) to 80 and asserts the
// invariants at all of them, because the failure being guarded is arithmetic
// and arithmetic is exactly what passes at two sample points and breaks at the
// third.

const test = require('node:test');
const assert = require('node:assert');
const { renderEconomy } = require('../src/render/economy');
const { fmtMins, fit, visibleWidth } = require('../src/render/shared');

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

test('the used% column NEVER widens — inside the critical zone as well as out', () => {
  // 0.5 spent two extra columns on a decimal once a row passed 95%. 0.6.2
  // withdrew it (owner ruling): those two columns are what a 39-column sidebar
  // has to give up, and what it gave up was the reset time at the row's right
  // edge. The zone row must now read exactly like the calm one — same figure
  // width, same "% used" column, no decimal anywhere.
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
  assert.match(zone[0], / 98% used/, 'in the zone: still the whole number, still two columns');
  assert.match(zone[1], / 62% used/, 'and the sibling row is untouched by its neighbour');
  // The positive form of "no decimal": the figure is the two characters between
  // the bar and the label, and 98.7 would not fit in two.
  for (const rows of [calm, zone]) {
    for (const row of rows) assert.match(row, /[▓░] \d\d% used/, `figure is two columns: ${row}`);
    const pctCol = (/** @type {string} */ l) => l.indexOf('% used');
    assert.strictEqual(pctCol(rows[0]), pctCol(rows[1]), 'both used% figures share one column');
  }
  // Byte-for-byte: the zone row differs from the calm row only in its numbers.
  assert.strictEqual(zone[1], calm[1], 'a row nowhere near the wall is unmoved by its sibling');
});

test('a used% at or past 100 stays a whole number', () => {
  // Past the wall the figure spills into a third column, which is the one place
  // the used% is allowed to be wider than two — and it is still a whole number.
  const at = (/** @type {number} */ p) => strip(renderEconomy({
    model: 'Fable 5', windowSize: 1000000,
    windows: [{ key: 'five_hour', label: '5h', usedPct: p, minutesToReset: 120, windowMinutes: 300 }],
  }, { theme: 'plain' }));
  assert.match(at(100), /\b100% used/);
  assert.ok(!/100\.0% used/.test(at(100)), 'no decimal at 100');
  assert.match(at(103.4), /\b103% used/);
});

// --- Width: the screen fits the pane it is drawn in --------------------------

/** The Background-shaped view, plus a model-scoped bucket and a branch. */
const WIDE_VIEW = {
  model: 'Opus 4.8', windowSize: 1000000, contextTokens: 262000, cachedPct: 80,
  costUsd: 4.2, durationMin: 96, branch: 'economy-narrow-0.6.2',
  windows: [
    { key: 'five_hour', label: '5h', usedPct: 70, minutesToReset: 200, windowMinutes: 300 },
    { key: 'seven_day', label: 'weekly', usedPct: 18, minutesToReset: 7810, windowMinutes: 10080 },
    { key: 'seven_day_sonnet', label: 'weekly · Sonnet', usedPct: 40, minutesToReset: 2880, windowMinutes: 10080 },
  ],
};

test('the economy screen fits every pane width from 36 to 80 columns', () => {
  for (let cols = 36; cols <= 80; cols++) {
    const out = strip(renderEconomy(WIDE_VIEW, { theme: 'plain', cols }));
    const lines = out.split('\n');

    const over = lines.filter((l) => visibleWidth(l) > cols)
      .map((l) => `${visibleWidth(l)} cols: ${JSON.stringify(l)}`);
    assert.deepStrictEqual(over, [], `at cols=${cols} these lines overflow`);

    // Nothing sanctioned is dropped: every window still states when it resets,
    // whether on its own row or on the line below it.
    const resets = lines.filter((l) => l.includes('resets ')).join('\n');
    for (const want of ['resets 3h20m', 'resets 5d10h', 'resets 2d']) {
      assert.ok(resets.includes(want), `at cols=${cols} "${want}" is gone:\n${out}`);
    }

    // The bars stay in one column — the alignment the whole row layout exists
    // to protect, and the first thing a per-row width fix would break.
    const barCols = new Set(lines.filter((l) => /●/.test(l)).map((l) => l.search(/[▓░]/)));
    assert.strictEqual(barCols.size, 1, `at cols=${cols} the meter bars split columns:\n${out}`);

    // Wide enough, and the reset is back on the row where it has always been.
    // 61 is arithmetic, not taste: a row's first line is 32 + labelW, this
    // view's longest label ("weekly · Sonnet") is 15, and the widest reset
    // ("resets 5d10h") costs two spaces plus twelve — 32 + 15 + 2 + 12 = 61.
    if (cols >= 61) {
      const rows = lines.filter((l) => /●/.test(l));
      assert.strictEqual(rows.length, 3, `at cols=${cols} expected three wall rows`);
      for (const r of rows) {
        assert.match(r, /resets \S+$/, `at cols=${cols} this row should hold its reset: ${r}`);
      }
    }
  }
});

test('an unknown pane width renders the screen at its natural size', () => {
  // The non-TTY contract: no `cols` means no reflow, not a guessed one.
  const natural = strip(renderEconomy(WIDE_VIEW, { theme: 'plain' }));
  assert.strictEqual(natural, strip(renderEconomy(WIDE_VIEW, { theme: 'plain', cols: undefined })));
  assert.match(natural, /70% used {2}resets 3h20m/, 'the reset rides the row');
  assert.match(natural, /262K\/1\.0M {2}cached 80%/, 'the ctx line keeps its whole gloss');
  assert.match(natural, /\$4\.20 · 1h36m · economy-narrow-0\.6\.2 · F2·clear/, 'the footer keeps every field');
});

test('fit takes the first candidate that fits, the last when none does, the first when the width is unknown', () => {
  assert.strictEqual(fit(10, 'abcdefghij', 'short'), 'abcdefghij', 'exactly the budget still fits');
  assert.strictEqual(fit(9, 'abcdefghij', 'short'), 'short', 'one column over falls through');
  assert.strictEqual(fit(3, 'abcdefghij', 'medium', 'sm'), 'sm', 'it keeps falling until one fits');
  assert.strictEqual(fit(1, 'abcdefghij', 'medium', 'sm'), 'sm', 'nothing fits → the last, never nothing');
  assert.strictEqual(fit(undefined, 'abcdefghij', 'sm'), 'abcdefghij', 'unknown width → the widest form');
  assert.strictEqual(fit(NaN, 'abcdefghij', 'sm'), 'abcdefghij', 'a NaN width is unknown, not zero');
  // Columns, not characters: a wide glyph costs two, and the whole point of
  // measuring here is that a terminal will charge for it.
  assert.strictEqual(fit(4, '日本語', 'x'), 'x', 'three wide glyphs are six columns, not three');
  assert.strictEqual(fit(6, '日本語', 'x'), '日本語');
});
