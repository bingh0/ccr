// @ts-check
'use strict';
// src/normalize.js — map Claude Code's status-line JSON to the renderer's view.
// Rate-limit buckets are DISCOVERED (not hardcoded) so any plan's bucket set —
// grandfathered Pro, current Pro, Max, model-scoped "Sonnet only" — is handled.

const { discoverWindows } = require('./rate-limits');
const { stripControl } = require('./sanitize');

/**
 * A finite number, or null. The snapshot is a JSON file on disk: it chooses its
 * own value types, and a `!= null` check accepts the string "1.5" as happily as
 * 1.5. Downstream does arithmetic and calls `.toFixed()`, so one wrong type is
 * a TypeError inside the draw loop — which the sidecar catches, but only by
 * replacing the whole economy panel with an error line, every tick, until the
 * file changes. Type-check at ingestion; a bad field costs itself and nothing
 * else. (NaN/Infinity are excluded too — they render as "NaN%" meters.)
 * @param {any} v
 * @returns {number|null}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {any} state CC status-line JSON
 * @param {number} [nowSec] override for testing
 * @returns {any} view consumed by renderEconomy
 */
function normalizeStatus(state, nowSec) {
  const rl = (state && state.rate_limits) || {};
  const cw = (state && state.context_window) || {};
  const cost = (state && state.cost) || {};
  const durationMs = num(cost.total_duration_ms);
  return {
    model: stripControl((state && state.model && state.model.display_name) || null),
    // Must be positive: it is a divisor for the ctx meter, and `?? ` (unlike the
    // `||` this replaced) would let a literal 0 through to divide by zero.
    windowSize: (num(cw.context_window_size) || 0) > 0 ? cw.context_window_size : 200000,
    windows: discoverWindows(rl, nowSec),
    contextTokens: num(cw.total_input_tokens)
      ?? num(cw.current_usage && cw.current_usage.cache_read_input_tokens),
    cachedPct: null,
    baselineTok: 14000,
    costUsd: num(cost.total_cost_usd),
    durationMin: durationMs != null ? durationMs / 60000 : null,
    branch: null,
  };
}

module.exports = { normalizeStatus };
