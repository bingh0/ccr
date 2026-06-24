// @ts-check
'use strict';
// src/render/resume.js — renders the resume-cost advisor. Pure function of
// advisor rows (see src/resume.js); selection stays with `claude --resume`.

const { dim, bold, green, yellow, red, cyan, tok } = require('./shared');

/** @param {number} m minutes → coarse age */
function fmtAge(m) {
  if (m >= 1440) return Math.round(m / 1440) + 'd';
  if (m >= 60) return Math.round(m / 60) + 'h';
  return Math.max(0, m) + 'm';
}
/** @param {string} s @param {number} n */
function trunc(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'; }

/**
 * @param {{ sessionId: string, title: string, branch: string|null, ageMin: number, ctx: number, winPct: number, cold: boolean }[]} rows
 * @param {{ scope?: 'cwd'|'all' }} [opts]
 * @returns {string}
 */
function renderResume(rows, opts = {}) {
  const scopeLabel = opts.scope === 'all' ? 'all projects' : 'this project';
  if (!rows.length) {
    let s = '  ' + dim(`no resumable sessions in ${scopeLabel}.`);
    if (opts.scope !== 'all') s += '\n  ' + dim('try ') + cyan('ccr resume all');
    return s;
  }

  const out = [bold('recent sessions') + dim('  ·  ' + scopeLabel), ''];
  const cols = ['age'.padStart(5), 'ctx'.padStart(5), 'win%'.padStart(5), 'cache'.padEnd(4), 'title'];
  out.push('  ' + dim(cols.join('  ')));

  for (const r of rows) {
    const age = fmtAge(r.ageMin).padStart(5);
    const ctx = tok(r.ctx).padStart(5);
    const winS = (r.winPct + '%').padStart(5);
    const winCol = r.winPct >= 80 ? red : r.winPct >= 50 ? yellow : green;
    const cache = (r.cold ? yellow : green)((r.cold ? 'cold' : 'warm').padEnd(4));
    const title = trunc(r.title, 40);
    const branch = r.branch ? dim('  ' + r.branch) : '';
    const nearClear = r.winPct >= 80 ? red(' ⚠ near /clear') : '';
    out.push('  ' + dim(age) + '  ' + ctx + '  ' + winCol(winS) + '  ' + cache + '  ' + title + branch + nearClear);
  }

  out.push('');
  out.push('  ' + dim('cold = first turn re-pays full context · select with ') + cyan('claude --resume'));
  return out.join('\n');
}

module.exports = { renderResume, fmtAge };
