// @ts-check
'use strict';
// src/instrument.js — minimal LOCAL meter-sample logging for OFFLINE analysis.
//
// Data collection, NOT machine learning. The transcripts don't store the meter
// %, so this is the only way to backtest the estimator on the real target (feed
// scripts/backtest-burn.js). It captures EVERY rate-limit bucket the plan
// exposes verbatim — so we learn each tier's real schema (5h, weekly, a
// model-scoped "Sonnet only" weekly, a monthly one) rather than assuming two.
// Append-only, size-capped, under ~/.ccr, never transmitted; a no-op when
// CCR_NO_INSTRUMENT is set.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ensureSecureDir } = require('./state-dir');

const CAP_BYTES = 2_000_000; // halve the log when it exceeds this

function capFile(/** @type {string} */ file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
}

/**
 * Append one sample if this is a subscription session (≥1 rate-limit bucket).
 * Never throws — logging must not break the status line.
 * @param {any} state CC status-line JSON
 * @param {{ dir?: string, now?: number }} [opts]
 * @returns {boolean} whether a sample was written
 */
function logMeterSample(state, opts = {}) {
  if (process.env.CCR_NO_INSTRUMENT) return false;
  const rl = (state && state.rate_limits) || {};
  /** @type {Record<string, { used: number, resets_at: any }>} */
  const limits = {};
  for (const k of Object.keys(rl)) {
    const r = rl[k];
    if (r && typeof r === 'object' && r.used_percentage != null) {
      limits[k] = { used: r.used_percentage, resets_at: r.resets_at ?? null };
    }
  }
  if (!Object.keys(limits).length) return false; // API session — nothing to log

  const dir = opts.dir || path.join(os.homedir(), '.ccr');
  const sid = String(state.session_id || 'default').replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(dir, `burnlog-${sid}.jsonl`);
  const cw = state.context_window || {};
  const rec = {
    t: opts.now != null ? opts.now : Date.now(),
    model: (state.model && state.model.id) || null,
    ctx: cw.total_input_tokens ?? (cw.current_usage && cw.current_usage.cache_read_input_tokens) ?? null,
    limits,
  };
  try {
    ensureSecureDir(dir);
    try { if (fs.statSync(file).size > CAP_BYTES) capFile(file); } catch { /* new file */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { logMeterSample };
