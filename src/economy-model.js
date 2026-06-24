// @ts-check
'use strict';
// src/economy-model.js — the computed economy model.
//
// This is the SINGLE SOURCE OF TRUTH for window classification, the binding
// window, the status band, and clear-ROI. Both consumers read from it:
//   - the text panel (src/render/economy.js) renders it
//   - `ccr economy --json` serialises it (the stable machine-readable contract)
// so the panel and the JSON can never disagree about which window binds.
//
// Pure function of a normalized `view` (see src/normalize.js). All numbers are
// raw (unrounded) — consumers format. Units: pct = percent, rate = %/min,
// minutes* = minutes, tokens = count, costUsd = US dollars.

const { windowEstimate, clearROI, binding } = require('./burn');

// Bump on any BREAKING change (renamed/removed field, changed semantics).
// Additive changes (new fields) do NOT bump it — consumers must ignore unknowns.
const SCHEMA_VERSION = 1;

const IMMINENT_MIN = 30; // status band: red / flashing in the panel
const WARN_MIN = 120;    // status band: yellow

/** @param {number|null} min minutes-to-exhaust → at-a-glance status band */
function band(min) {
  if (min == null) return 'ok';
  if (min <= IMMINENT_MIN) return 'imminent';
  if (min <= WARN_MIN) return 'warn';
  return 'ok';
}

/**
 * Classify each rate-limit window: burn estimate, whether it binds (would
 * exhaust BEFORE it resets), and which one you hit first. Tolerates any plan
 * shape (5h, weekly, model-scoped, monthly, …); returns `next = null` for an
 * API session with no reported windows.
 * @param {any} view
 * @returns {{ rows: any[], next: any }}
 */
function classifyWindows(view) {
  const windows = Array.isArray(view.windows) ? view.windows : [];
  const rows = windows.map((/** @type {any} */ wd) => {
    const est = windowEstimate({ usedPct: wd.usedPct, rate: wd.rate, minutesToReset: wd.minutesToReset, windowMinutes: wd.windowMinutes });
    const ml = est.minutesLeft;
    return {
      key: wd.key,
      label: wd.label || wd.key,
      est,
      reset: wd.minutesToReset,
      binding: false,
      live: ml != null && wd.minutesToReset != null && ml < wd.minutesToReset,
      resetsFirst: ml != null && wd.minutesToReset != null && ml >= wd.minutesToReset,
    };
  });
  const live = rows.filter((r) => r.live).map((r) => ({ key: r.key, est: r.est, reset: r.reset }));
  const b = binding(live);
  const next = b ? rows.find((r) => r.key === b.window) : null;
  if (next) next.binding = true;
  return { rows, next };
}

/**
 * Build the full economy model — the contract behind `ccr economy --json`.
 * @param {any} view normalized economy data (see normalizeStatus)
 * @returns {{
 *   schemaVersion: number, model: string|null,
 *   context: { tokens: number|null, windowSize: number|null, pct: number|null, cachedPct: number|null },
 *   windows: Array<{ key:string, label:string, usedPct:number, rate:number|null, minutesLeft:number|null, minutesToReset:number|null, band:string, binding:boolean, resetsBeforeHit:boolean }>,
 *   binding: { key:string, label:string, minutesLeft:number|null, band:string }|null,
 *   clear: { worthwhile:boolean, boughtMinutes:number, contextTokens:number|null, baselineTokens:number },
 *   session: { costUsd:number|null, durationMin:number|null, branch:string|null }
 * }}
 */
function computeEconomy(view) {
  const { rows, next } = classifyWindows(view);
  const baselineTokens = view.baselineTok || 14000;
  const ctxTokens = view.contextTokens ?? null;
  const windowSize = view.windowSize ?? null;

  const windows = rows.map((r) => ({
    key: r.key,
    label: r.label,
    usedPct: r.est.usedPct,
    rate: r.est.rate,
    minutesLeft: r.est.minutesLeft,
    minutesToReset: r.reset,
    band: band(r.est.minutesLeft),
    binding: r.binding,
    resetsBeforeHit: r.resetsFirst,
  }));

  // Mirrors the panel's clear gate: only meaningful when a window binds, a rate
  // is known, and context sits >20% above the post-clear baseline.
  let clear = { worthwhile: false, boughtMinutes: 0, contextTokens: ctxTokens, baselineTokens };
  if (next && next.est.rate != null && ctxTokens != null && ctxTokens > baselineTokens * 1.2) {
    const roi = clearROI({ rate: next.est.rate, usedPct: next.est.usedPct, contextC: ctxTokens, baselineB: baselineTokens, calib: null, resetMinutes: next.reset });
    clear = { worthwhile: roi.boughtMinutes > 0, boughtMinutes: roi.boughtMinutes, contextTokens: ctxTokens, baselineTokens };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    model: view.model ?? null,
    context: {
      tokens: ctxTokens,
      windowSize,
      pct: (ctxTokens != null && windowSize) ? (ctxTokens / windowSize) * 100 : null,
      cachedPct: view.cachedPct ?? null,
    },
    windows,
    binding: next
      ? { key: next.key, label: next.label, minutesLeft: next.est.minutesLeft, band: band(next.est.minutesLeft) }
      : null,
    clear,
    session: {
      costUsd: view.costUsd ?? null,
      durationMin: view.durationMin ?? null,
      branch: view.branch ?? null,
    },
  };
}

module.exports = { computeEconomy, classifyWindows, band, SCHEMA_VERSION };
