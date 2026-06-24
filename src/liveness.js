// @ts-check
'use strict';
// src/liveness.js
// Decide how the sidecar should present session liveness.
//
// Core principle: status-line emission cadence is NOT a liveness signal. Claude
// Code does not tick during a single long operation, so an old snapshot must
// NEVER blank the dashboard. Staleness is a quiet annotation; only the explicit
// exit sentinel means the session ended.
//
// Pure function of (exited, ageMs, staleMs) — no process probing (pstree/tmux),
// which is exactly what makes naive liveness heuristics over-eager to timeout.

/** Default age before a dim freshness note appears. Annotation only, never a wipe. */
const DEFAULT_STALE_MS = 120000;

/** @returns {number | null} */
function envStaleMs() {
  const v = Number(process.env.CCR_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * @param {{ exited?: boolean, ageMs?: number, staleMs?: number }} input
 * @returns {{ mode: 'ended' | 'live', marker: string | null }}
 *   mode 'live'  → render the dashboard (optionally with a freshness marker)
 *   mode 'ended' → render the session-ended screen (sentinel-confirmed only)
 */
function liveness(input) {
  const exited = !!input.exited;
  if (exited) return { mode: 'ended', marker: null };

  const ageMs = input.ageMs ?? 0;
  const staleMs = input.staleMs ?? envStaleMs() ?? DEFAULT_STALE_MS;
  const marker = ageMs >= staleMs ? `updated ${Math.floor(ageMs / 60000)}m ago` : null;
  return { mode: 'live', marker };
}

module.exports = { liveness, DEFAULT_STALE_MS };
