// @ts-check
'use strict';
// scripts/preview-economy.js
// DRAFT layout preview for the economy screen — review BEFORE it's the real
// renderer.  Run it and look at your terminal (colour + the flash only show live):
//
//     node scripts/preview-economy.js
//
// Default theme is plain + accessible ("the wall" stands alone as the idiom for
// hitting your limit). Urgency is colour-coded, and the imminent band FLASHES
// (inverse video on alternate ticks). The full CCR vocabulary is an easter egg
// gated to the debut-album anniversary.

const { windowEstimate, clearROI } = require('../src/burn');

const FIVE = 300, SEVEN = 10080;
const IMMINENT_MIN = 30;   // red + flashing
const WARN_MIN = 120;      // yellow, steady

// Creedence Clearwater Revival — self-titled debut LP, released July 5, 1968.
const CCR_DEBUT = { month: 7, day: 5 };

// Default (accessible) vs CCR easter-egg lexicon. "the wall" is shared — it works
// as the plain "hit the wall" idiom and as the Pink Floyd nod.
const THEMES = {
  plain: { wall: '⟵ the wall', within: 'within limits', imminent: 'limit imminent', looming: 'next limit', clearKey: 'F2·clear' },
  ccr:   { wall: '⟵ the wall', within: 'comfortably numb', imminent: 'bad moon rising', looming: 'up around the bend', clearKey: 'F2·wipe out' },
};
/** @param {Date} d */
function themeForDate(d) {
  return (d.getMonth() + 1 === CCR_DEBUT.month && d.getDate() === CCR_DEBUT.day) ? 'ccr' : 'plain';
}

const e = (/** @type {string} */ c, /** @type {string} */ s) => `\x1b[${c}m${s}\x1b[0m`;
const dim = (/** @type {string} */ s) => e('2', s);
const bold = (/** @type {string} */ s) => e('1', s);
const green = (/** @type {string} */ s) => e('32', s);
const red = (/** @type {string} */ s) => e('31', s);
const yellow = (/** @type {string} */ s) => e('33', s);
const cyan = (/** @type {string} */ s) => e('36', s);

// Imminent flash: inverse video on the "on" tick, plain red on the "off" tick.
const flash = (/** @type {boolean} */ tick, /** @type {string} */ s) => (tick ? e('7;1;31', ' ' + s + ' ') : e('1;31', s));

const pctColor = (/** @type {number} */ p) => (p >= 75 ? red : p >= 60 ? yellow : green);
function bar(/** @type {number} */ p, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((p / 100) * w)));
  return '▓'.repeat(f) + '░'.repeat(w - f);
}
function tok(/** @type {number} */ n) {
  if (n == null) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}
function fmtMins(/** @type {number} */ m) {
  if (m == null || !isFinite(m)) return '?';
  m = Math.max(0, Math.round(m));
  if (m >= 1440) { const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60); return hh ? `${d}d${hh}h` : `${d}d`; }
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 1) return r ? `${h}h${String(r).padStart(2, '0')}m` : `${h}h`;
  return `${m}m`;
}
function fmtReset(/** @type {number} */ min) {
  if (min == null) return '';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = Math.round(min % 60);
  if (d > 0) return `${d}d${h > 0 ? h + 'h' : ''}`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
function band(/** @type {number|null} */ min) {
  if (min == null) return 'ok';
  if (min <= IMMINENT_MIN) return 'imminent';
  if (min <= WARN_MIN) return 'warn';
  return 'ok';
}
const bandColor = { imminent: red, warn: yellow, ok: cyan };

function classify(/** @type {any} */ s) {
  const rows = [];
  if (s.fiveHour) rows.push({ key: '5h', label: '5h', est: windowEstimate({ usedPct: s.fiveHour.usedPct, rate: s.fiveHour.rate, minutesToReset: s.fiveHour.minutesToReset, windowMinutes: FIVE }), reset: s.fiveHour.minutesToReset });
  if (s.sevenDay) rows.push({ key: 'weekly', label: 'weekly', est: windowEstimate({ usedPct: s.sevenDay.usedPct, rate: s.sevenDay.rate, minutesToReset: s.sevenDay.minutesToReset, windowMinutes: SEVEN }), reset: s.sevenDay.minutesToReset });
  for (const r of rows) {
    const ml = r.est.minutesLeft;
    r.live = ml != null && r.reset != null && ml < r.reset;
    r.resetsFirst = ml != null && r.reset != null && ml >= r.reset;
  }
  const threats = rows.filter((r) => r.live).sort((a, b) => a.est.minutesLeft - b.est.minutesLeft);
  const next = threats[0] || null;
  if (next) next.binding = true;
  return { rows, next };
}

function wallRow(/** @type {any} */ row, /** @type {any} */ L, /** @type {boolean} */ tick) {
  const used = Math.round(row.est.usedPct);
  const b = row.binding ? band(row.est.minutesLeft) : null;
  const accent = b ? bandColor[b] : cyan;
  const leftRaw = row.est.minutesLeft != null ? '~' + fmtMins(row.est.minutesLeft) : '—';
  const labelTxt = row.label.padEnd(8);
  const label = row.binding
    ? (b === 'imminent' ? flash(tick, labelTxt) : bold(accent(labelTxt)))
    : dim(labelTxt);
  const left = row.binding ? bold(leftRaw.padEnd(8)) : (row.resetsFirst ? dim(leftRaw.padEnd(8)) : leftRaw.padEnd(8));
  const resets = row.reset != null ? dim('resets ' + fmtReset(row.reset)) : '';
  const tail = row.binding
    ? (b === 'imminent' ? flash(tick, L.wall) : accent('  ' + L.wall))
    : (row.resetsFirst ? dim('  · resets before you hit it') : '');
  return '  ' + label + ' ' + left + ' left  ' + pctColor(used)(bar(used)) + ' ' + String(used).padStart(2) + '%  ' + resets + tail;
}

function renderEconomy(/** @type {any} */ s, /** @type {string} */ themeName = 'plain', /** @type {boolean} */ tick = false) {
  const L = THEMES[themeName] || THEMES.plain;
  const out = [];
  out.push(bold('economy') + dim('   ' + s.model));
  out.push('');

  const { rows, next } = classify(s);

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
    out.push('  ' + green(L.within) + dim('  ·  within limits — each window resets before you reach it'));
  }
  out.push('');

  for (const r of rows) out.push(wallRow(r, L, tick));
  if (rows.length) out.push('');

  const B = s.baselineB ?? 14000;
  if (next && next.est.rate != null) {
    if (s.ctxTokens > B * 1.2) {
      const roi = clearROI({ rate: next.est.rate, usedPct: next.est.usedPct, contextC: s.ctxTokens, baselineB: B, calib: null, resetMinutes: next.reset });
      out.push('  ' + bold('clear now') + ' → ' + green('+' + fmtMins(roi.boughtMinutes)) + ' before ' + cyan(next.label) + dim(`   (${tok(s.ctxTokens)} → ${tok(B)})`));
    } else {
      out.push('  ' + dim(`context near baseline (${tok(s.ctxTokens)}) — little to gain from clearing`));
    }
    out.push('');
  } else if (rows.length && s.ctxTokens > B * 1.2) {
    out.push('  ' + dim(`no limit pressure · clearing ${tok(s.ctxTokens)}→${tok(B)} would only trim cost`));
    out.push('');
  }

  if (s.ctxTokens != null) {
    const cp = Math.round((s.ctxTokens / s.windowSize) * 100);
    const cached = s.cachedPct != null ? dim(`  cached ${s.cachedPct}%`) : '';
    out.push('  ' + 'ctx'.padEnd(8) + ' ' + pctColor(cp)(bar(cp)) + ' ' + String(cp).padStart(2) + '%' + dim(`  ${tok(s.ctxTokens)}/${tok(s.windowSize)}`) + cached);
  }
  if (s.rolling) out.push('  ' + dim(`last ${s.rolling.sessions} sessions · clears ${s.rolling.clears} · median clear @ ${Math.round(s.rolling.medClearPct * 100)}%`));
  const foot = [];
  if (s.costUsd != null) foot.push('$' + s.costUsd.toFixed(2));
  if (s.durationMin != null) foot.push(fmtMins(s.durationMin));
  if (s.branch) foot.push(s.branch);
  foot.push(L.clearKey);
  out.push('  ' + dim(foot.join(' · ')));

  return out.join('\n');
}

function box(/** @type {string} */ title, /** @type {string} */ body, w = 60) {
  process.stdout.write('\n' + dim('┌─ ' + title + ' ' + '─'.repeat(Math.max(0, w - title.length - 4)) + '┐') + '\n\n');
  process.stdout.write(body + '\n');
  process.stdout.write('\n' + dim('└' + '─'.repeat(w) + '┘') + '\n');
}

const FRESH = { model: 'Opus 4.8', fiveHour: { usedPct: 72, rate: 0.6, minutesToReset: 95 }, sevenDay: { usedPct: 12, rate: 0.02, minutesToReset: 8640 }, ctxTokens: 180000, windowSize: 200000, cachedPct: 76, rolling: { sessions: 8, clears: 5, medClearPct: 0.55 }, costUsd: 1.10, durationMin: 64, branch: 'main' };
const ENDWEEK = { model: 'Opus 4.8', fiveHour: { usedPct: 30, rate: 0.3, minutesToReset: 200 }, sevenDay: { usedPct: 96, rate: 0.05, minutesToReset: 1200 }, ctxTokens: 262000, windowSize: 1000000, cachedPct: 88, rolling: { sessions: 10, clears: 3, medClearPct: 0.42 }, costUsd: 4.20, durationMin: 38, branch: 'main' };
const WITHIN = { model: 'Sonnet 4.6', fiveHour: { usedPct: 55, rate: 0.25, minutesToReset: 140 }, sevenDay: null, ctxTokens: 120000, windowSize: 200000, cachedPct: 70, rolling: { sessions: 6, clears: 2, medClearPct: 0.48 }, costUsd: 0.80, durationMin: 30, branch: 'feature/x' };
const IMMINENT = { model: 'Opus 4.8', fiveHour: { usedPct: 88, rate: 0.7, minutesToReset: 60 }, sevenDay: { usedPct: 40, rate: 0.03, minutesToReset: 5000 }, ctxTokens: 185000, windowSize: 200000, cachedPct: 80, rolling: { sessions: 9, clears: 4, medClearPct: 0.5 }, costUsd: 3.10, durationMin: 50, branch: 'main' };
const API = { model: 'Opus 4.8 (API)', fiveHour: null, sevenDay: null, ctxTokens: 90000, windowSize: 200000, cachedPct: 71, rolling: null, costUsd: 2.10, durationMin: 22, branch: 'main' };

process.stdout.write(bold('\n══ DEFAULT THEME (accessible) ══') + dim(`   today resolves to: ${themeForDate(new Date())}`) + '\n');
box('Fresh week — 5h looms (cyan)', renderEconomy(FRESH, 'plain'));
box('End of week — weekly is the wall (cyan)', renderEconomy(ENDWEEK, 'plain'));
box('Within limits (green)', renderEconomy(WITHIN, 'plain'));
box('Imminent — FLASH frame A (inverse)', renderEconomy(IMMINENT, 'plain', true));
box('Imminent — FLASH frame B (red)', renderEconomy(IMMINENT, 'plain', false));
box('API — graceful degrade', renderEconomy(API, 'plain'));

process.stdout.write(bold('\n══ CCR EASTER EGG (debut-album anniversary) ══') + '\n');
box('Imminent — bad moon rising', renderEconomy(IMMINENT, 'ccr', false));
box('Within — comfortably numb', renderEconomy(WITHIN, 'ccr'));
