// @ts-check
'use strict';
// src/render/statusline.js — compact one-line economy summary for CC's status bar.
// Plain text (no ANSI) so it renders cleanly wherever the status line appears.

const { windowEstimate, binding } = require('../burn');
const { fmtMins } = require('./shared');

/**
 * @param {any} view normalized economy data
 * @returns {string} one line, e.g. "Sonnet 4.6 · weekly · Sonnet ~5h · ctx 15% · $2.50"
 */
function renderStatusline(view) {
  const parts = [];
  if (view.model) parts.push(view.model);

  const windows = Array.isArray(view.windows) ? view.windows : [];
  if (!windows.length) {
    parts.push('API · no limits');
  } else {
    const rows = windows.map((/** @type {any} */ wd) => ({
      key: wd.key,
      label: wd.label || wd.key,
      est: windowEstimate({ usedPct: wd.usedPct, rate: wd.rate, minutesToReset: wd.minutesToReset, windowMinutes: wd.windowMinutes }),
      reset: wd.minutesToReset,
    }));
    const live = rows
      .filter((r) => r.est.minutesLeft != null && r.reset != null && r.est.minutesLeft < r.reset)
      .map((r) => ({ key: r.key, est: r.est, reset: r.reset }));
    const b = binding(live);
    if (b && b.minutesLeft != null) {
      const row = rows.find((r) => r.key === b.window);
      const imminent = b.minutesLeft <= 30 ? '⚠ ' : '';
      parts.push(`${imminent}${row ? row.label : b.window} ~${fmtMins(b.minutesLeft)}`);
    } else {
      parts.push('within limits');
    }
  }

  if (view.contextTokens != null && view.windowSize) {
    parts.push(`ctx ${Math.round((view.contextTokens / view.windowSize) * 100)}%`);
  }
  if (view.costUsd != null) parts.push('$' + view.costUsd.toFixed(2));

  return parts.join(' · ');
}

module.exports = { renderStatusline };
