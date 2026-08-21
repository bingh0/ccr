// @ts-check
'use strict';
// src/render/statusline.js — compact one-line economy summary for CC's status bar.
// Plain text (no ANSI) so it renders cleanly wherever the status line appears.

const { windowEstimate, binding } = require('../burn');
const { fmtMins, usedLabel, CRIT_PCT } = require('./shared');

/**
 * Deterministic middle ellipsis: the same input shortens the same way at
 * every glance — the anti-marquee rule. (Animation was rejected outright:
 * Claude re-renders this line per turn, not on a clock, so anything animated
 * freezes exactly when the user is idle and orienting.)
 * @param {string} s @param {number} max
 */
function midEllipsis(s, max) {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(-tail) : '');
}

/**
 * @param {any} view normalized economy data
 * @param {{ name?: string|null, location?: string|null, cols?: number }} [identity]
 *   The instance identity, shown FIRST so terminal end-truncation eats meters,
 *   never orientation. The location half is LIVE (follows a mid-session cd)
 *   and appears only when it differs from the name — "notes @ notes" says
 *   nothing twice. `cols` bounds the identity: the location stays whole, the
 *   name takes the ellipsis.
 * @returns {string} one line, e.g. "a-is-awesome @ ccr · Opus 4.8 · 5h ~2h · ctx 15% · $2.50"
 */
function renderStatusline(view, identity = {}) {
  const parts = [];
  const name = identity.name || null;
  const loc = identity.location || null;
  if (name) {
    const withLoc = loc && loc !== name;
    let shownName = name;
    if (identity.cols && withLoc) {
      const budget = identity.cols - (' @ '.length + (loc ? loc.length : 0));
      if (name.length > budget) shownName = midEllipsis(name, Math.max(5, budget));
    } else if (identity.cols && name.length > identity.cols) {
      shownName = midEllipsis(name, Math.max(5, identity.cols));
    }
    parts.push(withLoc ? `${shownName} @ ${loc}` : shownName);
  }
  if (view.model) parts.push(view.model);

  // Annotated because Array.isArray does not narrow an `any`: without this the
  // whole chain below decays to `any` and the row callbacks lose their types.
  /** @type {any[]} */
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
      const label = row ? row.label : b.window;
      // Progressive disclosure: the one-line summary earns the precise used%
      // ONLY in the critical zone, and truncated, so floor() still matches
      // /usage. Below the zone the line stays a single glanceable beat — the
      // time-to-limit already answers "am I near the wall?", and a percentage
      // that is always present stops being a signal when it starts to matter.
      const pct = row && row.est.usedPct >= CRIT_PCT ? ` ${usedLabel(row.est.usedPct)}%` : '';
      if (b.minutesLeft <= 30) {
        // "About to hit the wall" outranks orientation for the next thing the
        // user types: the warning jumps ahead of everything, identity included.
        parts.unshift(`⚠ ${label}${pct} ~${fmtMins(b.minutesLeft)}`);
      } else {
        parts.push(`${label}${pct} ~${fmtMins(b.minutesLeft)}`);
      }
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
