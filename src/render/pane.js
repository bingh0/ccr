// @ts-check
'use strict';
// src/render/pane.js — draw one external tool pane from a VALIDATED blob.
// Contract: docs/PANE-CONTRACT.md § ccr (consumer) obligations.
//
// This renderer only ever sees output from src/pane-blob.js, so it does no
// validation and no sanitizing of its own: every string reaching it has already
// been stripped and truncated at the choke point. It does clamp to the cell,
// which is layout, not safety.
//
// The honesty rules live here, and they are the reason the pane is worth
// looking at: `dark` renders as visibly not-green, `off` renders as present-but
// -disabled, a broken blob shows its producer's message instead of stale rows,
// hidden rows collapse into a line that inherits the WORST status they carried,
// and every pane — healthy or not — carries its tool, its basis, and its age.

const { dim, bold, green, red, yellow, cyan, clampVisible } = require('./shared');
const { stripControl } = require('../sanitize');

/** Per-status marker. `dark` must never be green and never blank; `off` is dim. */
const MARKERS = {
  ok: () => green('●'),
  warn: () => yellow('●'),
  alert: () => red('●'),
  dark: () => cyan('◌'),   // hollow: "cannot tell", visibly not a light
  off: () => dim('·'),     // present, deliberately disabled
};

/** Worst-first precedence for the overflow line (contract § in-pane overflow). */
const SEVERITY = ['alert', 'dark', 'warn', 'ok', 'off'];

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * File write age on the contract's unit ladder: Xs / Xm / Xh / Xd.
 * @param {number} ms
 * @returns {string}
 */
function writeAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Normalize a row's spark to its OWN min-max (never a cross-row or cross-run
 * scale — that would make one row's shape depend on another's data).
 * @param {number[]} spark
 * @returns {string}
 */
function sparkline(spark) {
  const lo = Math.min(...spark);
  const hi = Math.max(...spark);
  const span = hi - lo;
  return spark.map((n) => {
    // A flat series has no shape to show; put it on the floor rather than
    // inventing a peak by dividing by zero.
    const idx = span === 0 ? 0 : Math.round(((n - lo) / span) * (SPARK_GLYPHS.length - 1));
    return SPARK_GLYPHS[Math.max(0, Math.min(SPARK_GLYPHS.length - 1, idx))];
  }).join('');
}

/** @param {string} status */
const marker = (status) => (MARKERS[/** @type {keyof MARKERS} */ (status)] || MARKERS.dark)();

/**
 * The chrome every pane carries, in every state. `tool` and `basis` are what
 * make a claim attributable; the age is what makes it dateable. A pane missing
 * any of them manufactures currency, which is why they are not optional even on
 * the error states.
 * @param {{ title?: string, tool?: string, basis?: any, ageMs?: number, position?: string }} p
 * @returns {string[]}
 */
function chromeLines(p) {
  const head = bold(p.title || 'pane') + (p.tool ? dim('  ' + p.tool) : '')
    + (p.position ? dim('   ' + p.position) : '');
  const lines = [head];
  const bits = [];
  // basis.at is OPAQUE — displayed verbatim, never parsed. Currency comes from
  // the file's mtime below, not from anything the producer wrote.
  if (p.basis && p.basis.label) bits.push(p.basis.label);
  if (p.basis && p.basis.at) bits.push(p.basis.at);
  if (p.ageMs != null) bits.push(`blob written ${writeAge(p.ageMs)} ago`);
  if (bits.length) lines.push('  ' + dim(bits.join(' · ')));
  return lines;
}

/**
 * Render one row: marker, label, value, then optional spark and detail.
 * @param {any} row
 * @param {number} labelW
 * @returns {string}
 */
function rowLine(row, labelW) {
  // Cut by CODE POINT: slicing UTF-16 units splits an astral character in half
  // and emits a lone surrogate — the same bug clampVisible documents fixing,
  // and this text is untrusted blob content.
  const cps = [...row.label];
  const label = cps.length > labelW ? cps.slice(0, labelW - 1).join('') + '…' : row.label;
  const body = '  ' + marker(row.status) + ' ' + label.padEnd(labelW) + '  '
    + (row.status === 'off' ? dim(row.value) : row.value);
  const spark = row.spark ? '  ' + cyan(sparkline(row.spark)) : '';
  const detail = row.detail ? dim('   ' + row.detail) : '';
  return body + spark + detail;
}

/**
 * Render a validated pane blob, or a named non-healthy state, as a whole pane.
 *
 * Error states name the configured PATH and nothing else — never file bytes,
 * never a parser message, because a parser message quotes the input that caused
 * it and the input is exactly what must not reach the terminal.
 *
 * @param {{ state: string, blob?: any, version?: number|null, reason?: string, ageMs?: number }} res
 *   the verifier's result for this pane
 * @param {{ source: string, position?: string, width?: number, maxRows?: number }} opts
 *   `source` is the path AS THE USER WROTE IT in config — error states quote
 *   their config, not ccr's resolution of it.
 * @returns {string}
 */
function renderPane(res, opts) {
  const width = opts.width && opts.width > 0 ? opts.width : 48;
  const src = opts.source;
  /** @type {string[]} */
  let lines;

  if (res.state === 'ok' && res.blob) {
    const b = res.blob;
    lines = chromeLines({ title: b.title, tool: b.tool, basis: b.basis, ageMs: res.ageMs, position: opts.position });
    lines.push('');

    if (b.status === 'broken') {
      // Confession, not stale health: the message, prominently, with the chrome.
      // Rows are ignored — showing them would present data the producer has just
      // told us it could not stand behind.
      lines.push('  ' + red(bold('broken')));
      lines.push('  ' + (b.message || ''));
    } else if (!b.rows.length) {
      lines.push('  ' + dim('no rows reported'));
    } else {
      const labelW = Math.min(20, Math.max(6, ...b.rows.map((/** @type {any} */ r) => r.label.length)));
      // Reserve a line for the overflow notice only when one is actually needed.
      const budget = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : b.rows.length;
      const overflow = b.rows.length > budget;
      const shownCount = overflow ? Math.max(0, budget - 1) : b.rows.length;
      for (const r of b.rows.slice(0, shownCount)) lines.push(rowLine(r, labelW));
      if (overflow) {
        const hidden = b.rows.slice(shownCount);
        // The collapsed line inherits the WORST hidden status, so a hidden
        // `dark` row still reads as darkness rather than vanishing into a count.
        const worst = SEVERITY.find((s) => hidden.some((/** @type {any} */ r) => r.status === s)) || 'off';
        lines.push('  ' + marker(worst) + ' ' + dim(`+${hidden.length} more`));
      }
    }
  } else {
    /** @type {Record<string, string>} */
    const named = {
      waiting: 'waiting for first blob',
      unreadable: 'blob unreadable',
      invalid: 'blob invalid',
      oversized: 'blob oversized',
      'cannot-read': `cannot read blob${res.reason ? ' (' + res.reason + ')' : ''}`,
      unsupported: `unsupported blob version ${res.version == null ? '?' : res.version}`,
    };
    // Age chrome belongs on the error states too. A pane stuck on `invalid` for
    // three days must not look like one that broke a second ago — that is the
    // "manufactures currency" failure obligation 3 names, and dropping the age
    // here contradicted this file's own docstring. `waiting`/`cannot-read` have
    // no readable file and so legitimately have no age.
    lines = chromeLines({ title: 'pane', position: opts.position, ageMs: res.ageMs });
    lines.push('');
    lines.push('  ' + (res.state === 'waiting' ? dim(named.waiting) : yellow(named[res.state] || 'blob unavailable')));
    // The configured path is USER-authored, not blob-authored — but it is still
    // text from a file on disk, and a config carrying an escape sequence would
    // otherwise put it straight on the terminal from six different states.
    lines.push('  ' + dim(String(stripControl(src) ?? '')));
  }

  return lines.map((l) => clampVisible(l, width)).join('\n');
}

module.exports = { renderPane, writeAge, sparkline, SEVERITY, MARKERS };
