// @ts-check
'use strict';
// src/resume.js — the resume-cost ADVISOR (not a picker). Claude Code's own
// `--resume` picker is good; ccr only adds the economics it can't show, then
// hands selection back to `claude --resume`.
//
// For each recent session: how heavy is it to bring back (last turn's input-side
// tokens ≈ the context re-fed), as a share of the model's context window, and
// whether its cache is cold (stale ⇒ the first turn re-pays full cache-creation).
// We deliberately do NOT express cost as a % of the rate-limit window — ccr
// doesn't know its absolute token cap, so that would be fabricated.

const { listSessionFiles, readSession } = require('./transcripts');
const { inferWindow } = require('./burn');

const COLD_MS = 5 * 60 * 1000;   // cache TTL: older than this ⇒ cold
const SCAN_CAP = 80;             // bound work: parse at most this many files

/** Context re-fed on resume ≈ the last assistant turn's input side. @param {any} parsed */
function contextTokens(parsed) {
  const t = parsed && parsed.stats && parsed.stats.lastTurn;
  return t ? (t.input || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0) : 0;
}

/**
 * Build one advisor row from a parsed transcript + its file metadata. Pure.
 * @param {any} parsed  result of parseEvents/readSession
 * @param {{ sessionId: string, mtimeMs: number }} file
 * @param {number} now  epoch ms
 * @returns {{ sessionId: string, title: string, branch: string|null, cwd: string|null, ageMin: number, ctx: number, winPct: number, cold: boolean }}
 */
function buildRow(parsed, file, now) {
  const ctx = contextTokens(parsed);
  const win = inferWindow({ model: parsed.stats.lastModel || undefined });
  const ageMs = Math.max(0, now - file.mtimeMs);
  return {
    sessionId: file.sessionId,
    title: parsed.title || parsed.lastPrompt || '(untitled)',
    branch: parsed.meta.gitBranch,
    cwd: parsed.meta.cwd,
    ageMin: Math.round(ageMs / 60000),
    ctx,
    winPct: win ? Math.round((ctx / win) * 100) : 0,
    cold: ageMs > COLD_MS,
  };
}

/**
 * Gather recent sessions as advisor rows, newest first.
 * @param {{ limit?: number, scope?: 'cwd'|'all', cwd?: string, now?: number, files?: any[] }} [opts]
 * @returns {ReturnType<typeof buildRow>[]}
 */
function gather(opts = {}) {
  const limit = opts.limit || 12;
  const scope = opts.scope || 'cwd';
  const cwd = opts.cwd || process.cwd();
  const now = opts.now || Date.now();
  const files = opts.files || listSessionFiles();
  /** @type {ReturnType<typeof buildRow>[]} */
  const rows = [];
  let scanned = 0;
  for (const f of files) {
    if (rows.length >= limit || scanned >= SCAN_CAP) break;
    scanned++;
    const parsed = readSession(f.path);
    if (!parsed) continue;
    if (scope === 'cwd' && parsed.meta.cwd && parsed.meta.cwd !== cwd) continue;
    if (!contextTokens(parsed) && !parsed.title) continue; // skip empty/aborted
    rows.push(buildRow(parsed, f, now));
  }
  return rows;
}

module.exports = { buildRow, gather, contextTokens, COLD_MS, SCAN_CAP };
