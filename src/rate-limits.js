// @ts-check
'use strict';
// src/rate-limits.js — discover whatever rate-limit buckets a plan exposes.
//
// Subscription tiers differ: a grandfathered Pro account, a current Pro account,
// and Max all report DIFFERENT buckets under `rate_limits` (5h, weekly, a
// separate model-scoped "Sonnet only" weekly, possibly a monthly one). Rather
// than hardcode key names, we read every bucket present and derive a label +
// window length heuristically, so any current or future bucket is handled
// gracefully. Unknown buckets still render (used % + reset); they just can't
// project a time-to-limit until we know (or learn) their window length.

const { parseResetsAt } = require('./burn');
const { stripControl } = require('./sanitize');

const FIVE = 300, WEEK = 10080, MONTH = 43200;

// Known keys get exact labels/windows; everything else falls back to heuristics.
const KNOWN = {
  five_hour: { label: '5h', windowMinutes: FIVE },
  seven_day: { label: 'weekly', windowMinutes: WEEK },
};

/** @param {string} key → 'Sonnet' | 'Opus' | 'Haiku' | null */
function modelScope(key) {
  if (/sonnet/i.test(key)) return 'Sonnet';
  if (/opus/i.test(key)) return 'Opus';
  if (/haiku/i.test(key)) return 'Haiku';
  return null;
}

/** @param {string} key → window length in minutes, or null if not inferable */
function inferWindowMinutes(key) {
  const h = key.match(/(\d+)\s*_?\s*hour/i); if (h) return Number(h[1]) * 60;
  if (/month/i.test(key)) return MONTH;
  if (/week|seven[_-]?day|7[_-]?day/i.test(key)) return WEEK;
  const d = key.match(/(\d+)\s*_?\s*day/i); if (d) return Number(d[1]) * 1440;
  if (/hour/i.test(key)) return FIVE;   // bare "hour" → the 5h window
  if (/day/i.test(key)) return 1440;
  return null;
}

/** @param {string} key → human label (scope appended when present) */
function labelFor(key) {
  let base;
  if (KNOWN[key]) base = KNOWN[key].label;
  else if (/week|seven[_-]?day|7[_-]?day/i.test(key)) base = 'weekly';
  else if (/month/i.test(key)) base = 'monthly';
  else {
    const h = key.match(/(\d+)\s*_?\s*hour/i);
    const d = key.match(/(\d+)\s*_?\s*day/i);
    base = h ? `${h[1]}h` : d ? `${d[1]}d` : key.replace(/_/g, ' ');
  }
  const scope = modelScope(key);
  // Unknown keys flow into the label verbatim (`key.replace(...)`), so sanitize
  // before it reaches the terminal.
  return stripControl(scope ? `${base} · ${scope}` : base);
}

/**
 * @param {any} rateLimits the status JSON `rate_limits` object
 * @param {number} [nowSec]
 * @returns {{ key:string, label:string, usedPct:number, minutesToReset:number|null, windowMinutes:number|null, modelScope:string|null }[]}
 */
function discoverWindows(rateLimits, nowSec) {
  /** @type {any[]} */
  const out = [];
  if (!rateLimits || typeof rateLimits !== 'object') return out;
  const now = nowSec != null ? nowSec : Date.now() / 1000;
  for (const key of Object.keys(rateLimits)) {
    const r = rateLimits[key];
    if (!r || typeof r !== 'object' || r.used_percentage == null) continue;
    const at = r.resets_at != null ? parseResetsAt(r.resets_at) : null;
    out.push({
      key,
      label: labelFor(key),
      usedPct: r.used_percentage,
      minutesToReset: at != null ? Math.max(0, (at - now) / 60) : null,
      windowMinutes: KNOWN[key] ? KNOWN[key].windowMinutes : inferWindowMinutes(key),
      modelScope: modelScope(key),
    });
  }
  // Shortest window first (5h → weekly → monthly); buckets with no inferable
  // window sort last.
  out.sort((a, b) => (a.windowMinutes || 1e9) - (b.windowMinutes || 1e9));
  return out;
}

module.exports = { discoverWindows, labelFor, inferWindowMinutes, modelScope };
