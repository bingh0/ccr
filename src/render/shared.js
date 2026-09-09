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

// The critical zone: at/above this used%, the wall is close enough that the
// figure is worth spending a beat of the status line on. It no longer means
// "surface a decimal" — 0.6.2 withdrew that (the extra two columns cost the
// reset time on a narrow pane); it means the zone in which the one-line status
// summary earns a used% AT ALL. The economy screen always shows one.
const CRIT_PCT = 95;

function bar(/** @type {number} */ p, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((p / 100) * w)));
  return '▓'.repeat(f) + '░'.repeat(w - f);
}

// Code-point ranges a terminal renders two columns wide (East Asian Wide and
// Fullwidth, per UAX #11), condensed to the blocks that actually turn up in a
// file path, a model name, or a tool argument: CJK, Hangul, Kana, fullwidth
// forms, and the emoji planes. Not exhaustive — it does not need to be. Every
// range here converts a "counted 1, occupies 2" error, which overflows the pane
// and soft-wraps, into a correct count.
const WIDE_RANGES = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols/punctuation
  [0x3041, 0x33ff],   // Kana, Bopomofo, Hangul Compat Jamo, CJK compat
  [0x3400, 0x4dbf],   // CJK Ext A
  [0x4e00, 0x9fff],   // CJK Unified
  [0xa000, 0xa4cf],   // Yi
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compat ideographs
  [0xfe30, 0xfe6f],   // CJK compat forms, small form variants
  [0xff00, 0xff60],   // Fullwidth forms
  [0xffe0, 0xffe6],   // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: symbols/pictographs, emoticons
  [0x1f900, 0x1f9ff], // Supplemental symbols/pictographs
  [0x20000, 0x3fffd], // CJK Ext B+ (SIP)
];

/**
 * Terminal columns occupied by one code point: 2 for East Asian Wide/Fullwidth,
 * 0 for combining marks (they stack onto the previous glyph), else 1.
 * @param {number} cp
 * @returns {0|1|2}
 */
function charWidth(cp) {
  // Combining diacriticals, and the Hebrew/Arabic/Devanagari combining blocks
  // most likely to appear in fetched text. Zero-width formatting characters are
  // already gone by here (src/sanitize.js strips them at ingestion).
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0483 && cp <= 0x0489)
    || (cp >= 0x0591 && cp <= 0x05bd) || (cp >= 0x0610 && cp <= 0x061a)
    || (cp >= 0x064b && cp <= 0x065f) || (cp >= 0x0900 && cp <= 0x0903)
    || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20f0)
    || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;   // incl. variation selectors
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/**
 * Clamp one line to `cols` visible COLUMNS: SGR escapes (`\x1b[…m`) pass through
 * with zero width; every other character counts for the columns a terminal will
 * actually give it (see charWidth). Appends a reset if it had to cut, so a
 * severed colour run doesn't bleed into the cleared tail. Prevents the soft wrap
 * that corrupts the sidecar's cursor-home redraw in a narrow pane. A
 * non-positive `cols` (e.g. a non-TTY where columns is undefined) is a no-op.
 *
 * Iterates by CODE POINT, not by UTF-16 unit: the old per-unit walk counted a
 * CJK glyph as one column (so 8 of them filled a 16-column pane and wrapped —
 * the exact corruption this function exists to prevent) and could cut an astral
 * character in half, emitting a lone surrogate.
 *
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
    const cp = /** @type {number} */ (line.codePointAt(i));
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    // Cut BEFORE a character that would not fit whole — a wide glyph straddling
    // the last column is what wraps the line.
    if (width + w > cols) return out + '\x1b[0m';
    out += ch;
    width += w;
    i += ch.length;
  }
  return out;
}

function tok(/** @type {number|null} */ n) {
  if (n == null || !Number.isFinite(n)) return '?';
  // 999_500 rounds to 1000K, which is a unit the scale never uses — promote it
  // to 1.0M rather than printing a fourth digit.
  if (n >= 999500) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function fmtMins(/** @type {number|null} */ m) {
  if (m == null || !isFinite(m)) return '?';
  m = Math.max(0, Math.round(m));
  if (m >= 1440) {
    const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60);
    // A 100+ day horizon is a near-zero-burn artifact (100−used%)/rate with a
    // tiny rate). Its hours are noise, and a wide value like "1000d5h" would
    // overflow the sidebar's fixed 7-col time column and shove the meter bar out
    // of vertical line with the sibling row (the 5h/weekly bars must align). Cap
    // it so the string never exceeds 6 visible columns — compact and honest.
    if (d >= 1000) return '>999d';
    if (d >= 100) return `${d}d`;
    return hh ? `${d}d${hh}h` : `${d}d`;
  }
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

/**
 * Terminal columns a PLAIN string occupies — the same accounting `clampVisible`
 * does, exposed for the callers that must budget space before they build a line
 * rather than clamp one afterwards. No SGR handling: the strings measured here
 * are display text before any colour is applied.
 * @param {string} s
 * @returns {number}
 */
function visibleWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(/** @type {number} */ (ch.codePointAt(0)));
  return w;
}

/**
 * Fit plain text into `cols` columns, marking the cut with an ellipsis so a
 * shortened value never reads as a complete one. Cutting is by code point and
 * by COLUMN (a wide glyph costs two), and the ellipsis is inside the budget —
 * the result is never wider than `cols`.
 *
 * Distinct from `clampVisible`, which is the hard safety net applied to a
 * finished line: this one is composition, so the caller can lay out around a
 * value it knows will fit. Returns '' for a non-positive budget.
 *
 * @param {string} s
 * @param {number} cols
 * @returns {string}
 */
function ellipsize(s, cols) {
  if (!(typeof cols === 'number' && cols > 0)) return '';
  if (visibleWidth(s) <= cols) return s;
  // One column is spent on the ellipsis, so the text gets cols-1. At cols === 1
  // that leaves nothing, and the ellipsis alone is the honest answer.
  const budget = cols - 1;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(/** @type {number} */ (ch.codePointAt(0)));
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * Choose the widest form of a line that still fits: the FIRST candidate whose
 * visible width is within `cols`, the LAST one if none is, or the first when
 * `cols` is unknown. Candidates are PLAIN strings (pre-colour) — colour is
 * zero-width but not zero-length, so a budget must be measured before it.
 *
 * The house rule this encodes: nothing sanctioned is dropped silently by the
 * terminal. `clampVisible` is the safety net and it cuts the RIGHTMOST field,
 * which on the economy row was the reset time — the field a narrow sidebar user
 * most needs. Deciding here, in the renderer, means the pane loses the field
 * ccr chose to give up rather than the one the cut happened to land on.
 *
 * "Unknown" is any non-finite `cols` (undefined on a non-TTY). A known budget
 * of zero or less is a real answer, not an unknown one: nothing fits, so the
 * last (shortest) candidate stands.
 *
 * @param {number|undefined} cols
 * @param {...string} candidates widest first, narrowest last
 * @returns {string}
 */
function fit(cols, ...candidates) {
  if (typeof cols !== 'number' || !Number.isFinite(cols)) return candidates[0];
  for (const c of candidates) if (visibleWidth(c) <= cols) return c;
  return candidates[candidates.length - 1];
}

module.exports = {
  e, dim, bold, green, red, yellow, cyan, flash, pctColor, CRIT_PCT, bar, clampVisible, tok, fmtMins, fmtReset,
  charWidth, visibleWidth, ellipsize, fit,
};
