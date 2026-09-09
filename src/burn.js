// @ts-check
'use strict';
// src/burn.js
// Burn-rate and clear-ROI math, scoped to subscription plans.
//
// Key design points:
//  - Rate is derived from the plan's own percentage meter (du/dt), so it is
//    correct on Pro and Max without knowing the absolute token cap.
//  - Rate is scoped to the active model — a prior model's samples must not
//    pollute it.
//  - BOTH the 5h and weekly windows are modelled; the binding (smaller) horizon
//    is what "time to limit" reports. On Max the weekly window often binds.
//  - clear-ROI is bounded: floored projected burn + capped at the nearest reset.

const FIVE_HOUR_MIN = 5 * 60;        // 300
const SEVEN_DAY_MIN = 7 * 24 * 60;   // 10080
const WINDOW_TIERS = [200000, 400000, 512000, 1000000];

// Pricing-ratio fallback for w(C) when no empirical calibration exists.
const READ_WEIGHT = 0.1;
const K_TAIL = 3000;

/**
 * Best-effort window from a model id alone — the ONLY thing a historical
 * transcript offers when it reports no context_window_size. It is an id table
 * and nothing more: no premium knee, no pricing band, WINDOW_TIERS untouched.
 * A miss here is not a wrong answer, only a weaker one — inferWindow falls
 * through to the observed-tier lower bound.
 *
 * Claude 5 (2026-09): `claude-fable-5-1` was observed carrying a 704,101-token
 * context, which no 200K/400K/512K tier can hold, and Claude Code's own status
 * label reads "Opus 5 (1M context)". Without these two rows `ccr resume` sized
 * every Claude 5 session at 200K and printed context percentages in the
 * hundreds. Sonnet 5 is deliberately ABSENT: nothing on this machine has
 * measured one, and a guessed 1M would be a fabricated fact rather than a
 * missing one — the tier fallback is the honest answer until a session says
 * otherwise. `opus-5` is matched as its own string so it can never catch
 * `opus-4-6`/`-4-7`/`-4-8`, which are three different windows.
 * @param {string} [model]
 */
function modelWindowGuess(model) {
  if (!model) return 0;
  const m = model.toLowerCase();
  if (m.includes('fable')) return 1000000;
  if (m.includes('opus-5')) return 1000000;
  if (m.includes('opus-4-8')) return 1000000;
  if (m.includes('opus-4-6') || m.includes('opus-4-7')) return 200000;
  if (m.includes('haiku')) return 200000;
  return 0; // unknown → fall back to the observed-tier lower bound
}

/** @param {number} maxCtx */
function inferWindowFromMax(maxCtx) {
  for (const t of WINDOW_TIERS) if (maxCtx <= t) return t;
  return 1000000;
}

/**
 * Effective window for normalizing context to "% of window". Prefer the live
 * reported size when present; otherwise best-effort from model name + observed max.
 * @param {{ model?: string, maxCtx?: number, reportedWindowSize?: number }} input
 * @returns {number}
 */
function inferWindow(input) {
  if (input.reportedWindowSize) return input.reportedWindowSize;
  return Math.max(modelWindowGuess(input.model), inferWindowFromMax(input.maxCtx || 0)) || 200000;
}

/**
 * Accept a reset value as epoch seconds (number or numeric string) OR an ISO
 * string, returning epoch seconds. Robust to CC changing the field's format.
 * @param {number | string | null | undefined} value
 * @returns {number | null}
 */
function parseResetsAt(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Model-scoped burn rate from a sample buffer. Uses only the contiguous tail of
 * samples on the active model (since the last model switch).
 * @param {{ t: number, u: number, m?: string }[]} samples  t in minutes, u = used %
 * @param {string} activeModel
 * @returns {{ rate: number | null, switched: boolean, count: number }}
 */
function rateFromSamples(samples, activeModel) {
  let start = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    if ((samples[i].m || '') !== activeModel) { start = i + 1; break; }
  }
  const tail = samples.slice(start);
  let rate = null;
  if (tail.length >= 2) {
    const dt = tail[tail.length - 1].t - tail[0].t;
    const du = tail[tail.length - 1].u - tail[0].u;
    if (dt > 0 && du >= 0) rate = du / dt;
  }
  return { rate, switched: tail.length < samples.length, count: tail.length };
}

/**
 * Estimate one window's burn + minutes-left. If no live `rate` is given, derive
 * the average burn over the window so far: used% / elapsed, where elapsed is the
 * window length minus the time remaining until it resets.
 * @param {{ usedPct: number, minutesToReset?: number, windowMinutes?: number, rate?: number }} w
 * @returns {{ usedPct: number, rate: number | null, minutesLeft: number | null, minutesToReset: number | null }}
 */
function windowEstimate(w) {
  let rate = w.rate ?? null;
  if (rate == null && w.minutesToReset != null && w.windowMinutes != null) {
    const elapsed = w.windowMinutes - w.minutesToReset;
    if (elapsed > 0) rate = w.usedPct / elapsed;
  }
  const minutesLeft = (rate != null && rate > 0) ? (100 - w.usedPct) / rate : null;
  return { usedPct: w.usedPct, rate, minutesLeft, minutesToReset: w.minutesToReset ?? null };
}

/**
 * Pick the binding window — the one you'll hit first (smallest minutes-left) —
 * from an arbitrary set of buckets (5h, weekly, model-scoped, monthly, …).
 * Tolerates any plan shape without blanking; returns null for no windows.
 * @param {{ key: string, est: any, reset?: number|null }[]} windows
 * @returns {{ window: string, minutesLeft: number | null, all: any[] } | null}
 */
function binding(windows) {
  if (!Array.isArray(windows) || !windows.length) return null;
  /** @param {any} w */
  const ml = (w) => {
    const m = w && w.est && w.est.minutesLeft;
    return (m == null || !isFinite(m)) ? Infinity : m;
  };
  const sorted = [...windows].sort((a, b) => ml(a) - ml(b));
  const top = sorted[0];
  return { window: top.key, minutesLeft: top.est ? top.est.minutesLeft : null, all: windows };
}

/**
 * Minutes of budget a /clear would buy. Floors the projected post-clear burn and
 * caps the gain at the nearest reset horizon, so it can never explode.
 * @param {{ rate: number | null, usedPct: number, contextC: number, baselineB: number, calib?: {a:number,b:number} | null, resetMinutes?: number }} o
 * @returns {{ boughtMinutes: number, projectedBurn: number | null }}
 */
function clearROI(o) {
  if (o.rate == null || !(o.contextC > o.baselineB * 1.2)) {
    return { boughtMinutes: 0, projectedBurn: o.rate };
  }
  let ratio;
  // Bind the calibration outside the closure: narrowing does not survive into a
  // function body (the callback could in principle run after o.calib changed),
  // and binding it also means the reader need not reason about reentrancy.
  const calib = o.calib;
  if (calib) {
    const w = (/** @type {number} */ x) => Math.max(calib.a * x + calib.b, 1e-9);
    ratio = w(o.baselineB) / w(o.contextC);
  } else {
    const w = (/** @type {number} */ x) => READ_WEIGHT * x + K_TAIL;
    ratio = w(o.baselineB) / w(o.contextC);
  }
  // A clear can't shed the output/write tail or the retained baseline, so burn
  // can't realistically drop below ~5% of current (or an absolute 0.01%/min).
  const rNew = Math.max(o.rate * ratio, o.rate * 0.05, 0.01);
  const remaining = 100 - o.usedPct;
  const horizon = (o.resetMinutes != null && isFinite(o.resetMinutes)) ? o.resetMinutes : Infinity;
  const lifeOld = Math.min(remaining / o.rate, horizon);
  const lifeNew = Math.min(remaining / rNew, horizon);
  return { boughtMinutes: Math.max(lifeNew - lifeOld, 0), projectedBurn: rNew };
}

/**
 * Interpretable burn-rate estimate: an EWMA of recent per-interval rates, scoped
 * to the active model. "A running average of your recent burn, weighting the last
 * few minutes most." Chosen over Kalman/window after backtesting real transcripts
 * (scripts/backtest-burn.js): trend overfits, raw-instantaneous jitters ~5x more,
 * and a recency-weighted average is as accurate while far steadier — and any
 * reviewer can verify the calculation. Forecast the sustained rate, not the tick.
 * @param {{ t: number, u: number, m?: string }[]} samples  t in minutes, u = used %
 * @param {string} activeModel
 * @param {number} [alpha] smoothing in (0,1]; higher = more responsive. Default 0.3.
 * @returns {{ rate: number | null, samples: number, switched: boolean }}
 */
function smoothedRate(samples, activeModel, alpha = 0.3) {
  let start = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    if ((samples[i].m || '') !== activeModel) { start = i + 1; break; }
  }
  const tail = samples.slice(start);
  let ewma = NaN;                               // NaN = "no rate yet" (avoids null typing)
  for (let i = 1; i < tail.length; i++) {
    const dt = tail[i].t - tail[i - 1].t;
    const du = tail[i].u - tail[i - 1].u;
    if (dt <= 0 || du < 0) continue;            // skip idle gaps / meter resets
    const r = du / dt;
    ewma = isNaN(ewma) ? r : alpha * r + (1 - alpha) * ewma;
  }
  return { rate: isNaN(ewma) ? null : ewma, samples: tail.length, switched: tail.length < samples.length };
}

module.exports = {
  FIVE_HOUR_MIN, SEVEN_DAY_MIN,
  inferWindow, parseResetsAt, rateFromSamples, smoothedRate, windowEstimate, binding, clearROI,
};
