// @ts-check
'use strict';
// src/render/shared.js — ANSI + formatting helpers shared by renderers.

const e = (/** @type {string} */ c, /** @type {string} */ s) => `\x1b[${c}m${s}\x1b[0m`;
const dim = (/** @type {string} */ s) => e('2', s);
const bold = (/** @type {string} */ s) => e('1', s);
const green = (/** @type {string} */ s) => e('32', s);
const red = (/** @type {string} */ s) => e('31', s);
const yellow = (/** @type {string} */ s) => e('33', s);
const cyan = (/** @type {string} */ s) => e('36', s);

// Imminent flash: inverse video on the "on" tick, solid red on the "off" tick.
// Width is preserved (no padding) so rows don't shift between frames.
const flash = (/** @type {boolean} */ tick, /** @type {string} */ s) => (tick ? e('7;1;31', s) : e('1;31', s));

const pctColor = (/** @type {number} */ p) => (p >= 75 ? red : p >= 60 ? yellow : green);

function bar(/** @type {number} */ p, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((p / 100) * w)));
  return '▓'.repeat(f) + '░'.repeat(w - f);
}

/**
 * Clamp one line to `cols` visible columns: SGR escapes (`\x1b[…m`) pass through
 * with zero width, printable chars count as 1. Appends a reset if it had to cut,
 * so a severed colour run doesn't bleed into the cleared tail. Prevents the soft
 * wrap that corrupts the sidecar's cursor-home redraw in a narrow pane. A
 * non-positive `cols` (e.g. a non-TTY where columns is undefined) is a no-op.
 * @param {string} line
 * @param {number} [cols]
 * @returns {string}
 */
function clampVisible(line, cols) {
  if (!(typeof cols === 'number' && cols > 0)) return line;
  const sgr = /\x1b\[[0-9;]*m/y;
  let out = '';
  let width = 0;
  let i = 0;
  while (i < line.length) {
    sgr.lastIndex = i;
    const m = sgr.exec(line);
    if (m) { out += m[0]; i = sgr.lastIndex; continue; }
    if (width >= cols) return out + '\x1b[0m';
    out += line[i];
    width += 1;
    i += 1;
  }
  return out;
}

function tok(/** @type {number|null} */ n) {
  if (n == null) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function fmtMins(/** @type {number|null} */ m) {
  if (m == null || !isFinite(m)) return '?';
  m = Math.max(0, Math.round(m));
  if (m >= 1440) { const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60); return hh ? `${d}d${hh}h` : `${d}d`; }
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 1) return r ? `${h}h${String(r).padStart(2, '0')}m` : `${h}h`;
  return `${m}m`;
}

function fmtReset(/** @type {number|null} */ min) {
  if (min == null) return '';
  min = Math.round(min); // round to whole minutes FIRST so 239.97 → 240 → 4h, not 3h60m
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return `${d}d${h > 0 ? h + 'h' : ''}`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

module.exports = { e, dim, bold, green, red, yellow, cyan, flash, pctColor, bar, clampVisible, tok, fmtMins, fmtReset };
