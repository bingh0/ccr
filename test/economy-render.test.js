// @ts-check
'use strict';
// Regression: the rendered "% used" meter must FLOOR the fractional
// `used_percentage` Claude reports, to match `/usage` and claude.ai usage
// (which truncate). Rounding read ~1pt high past the half-point — a real
// bug report against the weekly window.

const test = require('node:test');
const assert = require('node:assert');
const { renderEconomy } = require('../src/render/economy');

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
