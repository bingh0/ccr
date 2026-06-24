// @ts-check
'use strict';
// src/normalize.js — map Claude Code's status-line JSON to the renderer's view.
// Rate-limit buckets are DISCOVERED (not hardcoded) so any plan's bucket set —
// grandfathered Pro, current Pro, Max, model-scoped "Sonnet only" — is handled.

const { discoverWindows } = require('./rate-limits');
const { stripControl } = require('./sanitize');

/**
 * @param {any} state CC status-line JSON
 * @param {number} [nowSec] override for testing
 * @returns {any} view consumed by renderEconomy
 */
function normalizeStatus(state, nowSec) {
  const rl = (state && state.rate_limits) || {};
  const cw = (state && state.context_window) || {};
  return {
    model: stripControl((state && state.model && state.model.display_name) || null),
    windowSize: cw.context_window_size || 200000,
    windows: discoverWindows(rl, nowSec),
    contextTokens: cw.total_input_tokens
      ?? (cw.current_usage && cw.current_usage.cache_read_input_tokens) ?? null,
    cachedPct: null,
    baselineTok: 14000,
    costUsd: state && state.cost && state.cost.total_cost_usd != null ? state.cost.total_cost_usd : null,
    durationMin: state && state.cost && state.cost.total_duration_ms != null ? state.cost.total_duration_ms / 60000 : null,
    branch: null,
  };
}

module.exports = { normalizeStatus };
