// @ts-check
'use strict';
// src/render/economy.js — the economy screen.
//
// Shows BOTH the 5h and weekly walls, marks which one you'll hit first ("the
// wall" — only if it exhausts before it resets), states the clear decision in
// plain language, and degrades gracefully on API sessions. Pure function of a
// normalized `view`; colour/flash via opts.tick; vocabulary via opts.theme.

const { clearROI } = require('../burn');
const { classifyWindows, band } = require('../economy-model');
const { resolveTheme, lexicon } = require('../theme');
const { dim, bold, green, red, yellow, cyan, flash, pctColor, bar, tok, fmtMins, fmtReset } = require('./shared');

const bandColor = { imminent: red, warn: yellow, ok: cyan };

function wallRow(/** @type {any} */ row, /** @type {any} */ L, /** @type {boolean} */ tick, /** @type {number} */ labelW) {
  const used = Math.round(row.est.usedPct);
  const ml = row.est.minutesLeft;
  const b = band(ml);
  // Per-row colour dot: green when the window resets before you'd hit it,
  // otherwise graded by how soon it would exhaust (cyan→yellow→red, flash when
  // imminent on the binding window). The at-a-glance status signal.
  const dotColor = row.resetsFirst ? green : bandColor[b];
  const dot = (row.binding && b === 'imminent') ? flash(tick, '●') : dotColor('●');

  const labelTxt = row.label.padEnd(labelW);
  const label = row.binding ? bold(bandColor[b](labelTxt)) : dim(labelTxt);
  // Time-to-exhaust carries no word: the sibling "resets …" is self-labelling,
  // so a bare "~8h43m" reads unambiguously as remaining budget.
  const leftTxt = (ml != null ? '~' + fmtMins(ml) : '—').padEnd(7);
  const left = row.binding ? bold(leftTxt) : dim(leftTxt);
  const resets = row.reset != null ? dim('resets ' + fmtReset(row.reset)) : '';
  const meter = pctColor(used)(bar(used)) + ' ' + String(used).padStart(2) + '% used';
  const main = '  ' + dot + ' ' + label + ' ' + left + ' ' + meter + '  ' + resets;

  // The binding window's "wall" call-out drops to its own indented line below —
  // so a long marker never trails off the narrow sidebar edge and wraps.
  if (row.binding) {
    const mark = '↑ ' + L.wall;
    return main + '\n      ' + (b === 'imminent' ? flash(tick, mark) : bandColor[b](mark));
  }
  return main;
}

/**
 * @param {any} view normalized economy data
 * @param {{ theme?: 'plain'|'mary', now?: Date, tick?: boolean, env?: any }} [opts]
 * @returns {string}
 */
function renderEconomy(view, opts = {}) {
  const themeName = opts.theme || resolveTheme(opts.now, opts.env);
  const L = lexicon(themeName);
  const tick = !!opts.tick;
  const out = [bold('economy') + dim('   ' + (view.model || '')), ''];

  const { rows, next } = classifyWindows(view);
  const labelW = Math.max(8, ...rows.map((/** @type {any} */ r) => r.label.length));

  // HERO
  if (!rows.length) {
    out.push('  ' + dim('window limits are subscription-only — none reported (API session)'));
  } else if (next) {
    const b = band(next.est.minutesLeft);
    const t = '~' + fmtMins(next.est.minutesLeft);
    if (b === 'imminent') {
      out.push('  ' + flash(tick, '▲ ' + L.imminent) + dim('  ·  ') + bold(next.label) + dim(' in ') + flash(tick, t));
    } else {
      const col = bandColor[b];
      out.push('  ' + dim(L.looming) + '   ' + bold(col(next.label)) + dim(' in ') + bold(col(t)));
    }
  } else {
    out.push('  ' + green(L.within) + dim('  ·  each window resets before you reach it'));
  }
  out.push('');

  for (const r of rows) out.push(wallRow(r, L, tick, labelW));
  if (rows.length) out.push('');

  // CLEAR — plain language, framed against the binding wall, only when it looms.
  const B = view.baselineTok || 14000;
  if (next && next.est.rate != null) {
    if (view.contextTokens > B * 1.2) {
      const roi = clearROI({ rate: next.est.rate, usedPct: next.est.usedPct, contextC: view.contextTokens, baselineB: B, calib: null, resetMinutes: next.reset });
      out.push('  ' + bold('clear now') + ' → ' + green('+' + fmtMins(roi.boughtMinutes)) + ' before ' + cyan(next.label) + dim(`   (${tok(view.contextTokens)} → ${tok(B)})`));
    } else {
      out.push('  ' + dim(`context near baseline (${tok(view.contextTokens)}) — little to gain from clearing`));
    }
    out.push('');
  } else if (rows.length && view.contextTokens > B * 1.2) {
    out.push('  ' + dim(`no limit pressure · clearing ${tok(view.contextTokens)}→${tok(B)} would only trim cost`));
    out.push('');
  }

  // CONTEXT + footer
  if (view.contextTokens != null) {
    const cp = Math.round((view.contextTokens / view.windowSize) * 100);
    const cached = view.cachedPct != null ? dim(`  cached ${view.cachedPct}%`) : '';
    out.push('  ' + 'ctx'.padEnd(labelW) + ' ' + pctColor(cp)(bar(cp)) + ' ' + String(cp).padStart(2) + '%' + dim(`  ${tok(view.contextTokens)}/${tok(view.windowSize)}`) + cached);
  }
  if (view.rolling) out.push('  ' + dim(`last ${view.rolling.sessions} sessions · clears ${view.rolling.clears} · median clear @ ${Math.round(view.rolling.medClearPct * 100)}%`));
  const foot = [];
  if (view.costUsd != null) foot.push('$' + view.costUsd.toFixed(2));
  if (view.durationMin != null) foot.push(fmtMins(view.durationMin));
  if (view.branch) foot.push(view.branch);
  foot.push(L.clearKey);
  out.push('  ' + dim(foot.join(' · ')));

  return out.join('\n');
}

module.exports = { renderEconomy };
