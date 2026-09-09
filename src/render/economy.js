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
const { dim, bold, green, red, yellow, cyan, flash, pctColor, bar, tok, fmtMins, fmtReset, visibleWidth, fit } = require('./shared');
const { liveness } = require('../liveness');

const bandColor = { imminent: red, warn: yellow, ok: cyan };

function wallRow(/** @type {any} */ row, /** @type {any} */ L, /** @type {boolean} */ tick, /** @type {number} */ labelW, /** @type {boolean} */ stale, /** @type {number|undefined} */ cols) {
  // Truncate, don't round: Claude's own surfaces (`/usage`, claude.ai usage)
  // floor the fractional `used_percentage` (e.g. 41.6 → "41%"). Math.round here
  // read ~1pt high on values past the half-point. Display only — the burn/ROI
  // math below still uses the raw fractional `row.est.usedPct`.
  //
  // The whole number is the WHOLE story: the same figure `/usage` reports, in
  // the same two columns, at every reading. 0.5 surfaced an extra decimal in
  // the critical zone; 0.6.2 withdrew it (owner ruling) because those two
  // columns are exactly what a 39-column sidebar has to give up, and what it
  // gave up was the reset time at the row's right edge.
  const used = Math.floor(row.est.usedPct);
  const ml = row.est.minutesLeft;
  const b = band(ml);
  // Per-row colour dot: green when the window resets before you'd hit it,
  // otherwise graded by how soon it would exhaust (cyan→yellow→red, flash when
  // imminent on the binding window). The at-a-glance status signal.
  const dotColor = row.resetsFirst ? green : bandColor[b];
  const dot = (row.binding && b === 'imminent') ? flash(tick, '●') : dotColor('●');

  // Truncate as well as pad: labelW is capped, so a longer label must be cut to
  // the column rather than pushing every sibling row out of alignment.
  const labelTxt = (row.label.length > labelW ? row.label.slice(0, labelW - 1) + '…' : row.label).padEnd(labelW);
  const label = row.binding ? bold(bandColor[b](labelTxt)) : dim(labelTxt);
  // Time-to-exhaust carries no word: the sibling "resets …" is self-labelling,
  // so a bare "~8h43m" reads unambiguously as remaining budget.
  const leftTxt = (ml != null ? '~' + fmtMins(ml) : '—').padEnd(7);
  const left = row.binding ? bold(leftTxt) : dim(leftTxt);
  const resetTxt = row.reset != null ? 'resets ' + fmtReset(row.reset) : '';
  // A stale snapshot dims the figure so a number frozen between chat rounds
  // never reads as live. The bar colour stays, so the band still pops, and the
  // sidecar appends the "updated …" note that says why (see src/liveness.js).
  const numTxt = String(used).padStart(2) + '% used';
  const meter = pctColor(used)(bar(used)) + ' ' + (stale ? dim(numTxt) : numTxt);
  const head = '  ' + dot + ' ' + label + ' ' + left + ' ' + meter;
  // Measured on the plain twin, not on `head`: colour is zero-width but not
  // zero-length. Built from the same pieces, so it cannot drift from what is
  // drawn (and a wide-glyph label costs its real two columns here).
  const headW = visibleWidth('  ● ' + labelTxt + ' ' + leftTxt + ' ' + bar(used) + ' ' + numTxt);

  // ONE-LINE vs TWO-LINE. The reset rides the meter row whenever the row can
  // hold it — the form every pane wide enough has always drawn, and the form an
  // unknown width keeps. When it cannot, the reset drops to the line below
  // rather than off the pane's right edge, where `clampVisible` would cut it to
  // a bare "reset" (the reported bug). `fit` picks the tail: the reset itself,
  // or '' meaning "it does not fit up here". A row with no reset has no tail to
  // move and keeps its trailing pad exactly as before.
  const tail = resetTxt ? fit(cols == null ? undefined : cols - headW, '  ' + resetTxt, '') : '  ';
  const stacked = resetTxt !== '' && tail === '';

  let out = head + (stacked ? '' : '  ' + (resetTxt ? dim(resetTxt) : ''));
  // The binding window's "wall" call-out drops to its own indented line below —
  // so a long marker never trails off the narrow sidebar edge and wraps. A
  // stacked reset SHARES that line: the row already spent one line on the
  // marker, and a third would push a two-row screen off a short pane.
  if (row.binding) {
    const mark = '↑ ' + L.wall;
    out += '\n      ' + (b === 'imminent' ? flash(tick, mark) : bandColor[b](mark))
      + (stacked ? '  ' + dim(resetTxt) : '');
  } else if (stacked) {
    out += '\n      ' + dim(resetTxt);
  }
  return out;
}

// Every line of the screen carries the same two-column left margin, so the
// budget for a line's TEXT is the pane minus that margin. Unknown stays unknown.
const INDENT = 2;
const textCols = (/** @type {number|undefined} */ cols) =>
  (typeof cols === 'number' && Number.isFinite(cols) ? cols - INDENT : undefined);

/**
 * @param {any} view normalized economy data
 * @param {{ theme?: 'plain'|'mary', now?: Date, tick?: boolean, env?: any,
 *   ageMs?: number, staleMs?: number, cols?: number }} [opts]
 *   ageMs/staleMs: how old the captured snapshot is, and the threshold past
 *   which it counts as stale. The snapshot only refreshes per chat round, so
 *   between rounds it ages — past the threshold the used figures dim, so they
 *   read as last-known rather than live. The threshold decision itself stays
 *   in src/liveness.js, which also owns the "updated …" note the sidecar
 *   appends; this renderer only asks whether the data is stale.
 *
 *   cols: the pane this screen is drawn in. UNDEFINED means unknown width, and
 *   the screen renders at its natural size exactly as it always has — the
 *   non-TTY case and every caller that has no pane. Given a width, the screen
 *   composes to fit it: the reset time moves under its row, the label column
 *   narrows, and the secondary halves of the clear/ctx/footer lines are the
 *   ones spent. NOTHING sanctioned is silently dropped — the alternative is
 *   `clampVisible` cutting whatever field happens to sit at the right edge.
 * @returns {string}
 */
function renderEconomy(view, opts = {}) {
  const themeName = opts.theme || resolveTheme(opts.now, opts.env);
  const L = lexicon(themeName);
  const tick = !!opts.tick;
  const cols = opts.cols;
  const stale = !!liveness({ ageMs: opts.ageMs ?? 0, staleMs: opts.staleMs }).marker;
  const out = [bold('economy') + dim('   ' + (view.model || '')), ''];

  const { rows, next } = classifyWindows(view);
  // Cap the label column. `labelW` multiplies: every row pads to it, so cost is
  // rows × longest-label, and BOTH come from the snapshot's rate_limits keys. A
  // planted file with many buckets and one very long key built a string large
  // enough to throw RangeError and blank the panel — an amplifier, not a leak,
  // but it costs the whole display. 18 columns fits every real bucket name.
  const LABEL_MAX = 18;
  // The pane's own cap. A wall row's first line is 32 + labelW columns (margin,
  // dot, label, the 7-col time field, the 10-col bar, "nn% used"), so the label
  // column is the one part of it that can give — and it is the right part to
  // give, because a label is recoverable from context and a meter is not. The
  // floor of 4 keeps the row itself fitting down to 36 columns; below that the
  // `…` truncation in wallRow does the rest. `ctx` pads to the same labelW, so
  // its bar stays in the wall rows' column.
  const paneCap = typeof cols === 'number' && Number.isFinite(cols) ? Math.max(4, cols - 32) : LABEL_MAX;
  const labelW = Math.min(LABEL_MAX, paneCap, Math.max(8, ...rows.map((/** @type {any} */ r) => r.label.length)));

  // HERO. The verdict is the line — "limit imminent", "next limit", "within
  // limits" — and it is never spent. What a narrow pane gives up is the room
  // around it: the wide "  ·  " and triple-space separators shrink to single
  // spaces, and the "each window resets before you reach it" gloss goes. Each
  // form is chosen on its plain text (colour is zero-width but not zero-length)
  // and then drawn in colour.
  const T = textCols(cols);
  if (!rows.length) {
    out.push('  ' + dim(fit(T,
      'window limits are subscription-only — none reported (API session)',
      'window limits are subscription-only',
      'subscription-only')));
  } else if (next) {
    const b = band(next.est.minutesLeft);
    const t = '~' + fmtMins(next.est.minutesLeft);
    if (b === 'imminent') {
      const wide = fit(T, `▲ ${L.imminent}  ·  ${next.label} in ${t}`, `▲ ${L.imminent} · ${next.label} in ${t}`);
      const sep = wide.includes('  ·  ') ? '  ·  ' : ' · ';
      out.push('  ' + flash(tick, '▲ ' + L.imminent) + dim(sep) + bold(next.label) + dim(' in ') + flash(tick, t));
    } else {
      const col = bandColor[b];
      // Third form: the window and its time alone. "weekly · Sonnet in ~14h"
      // still says what is next; the looming word is the one part that can go.
      const bare = `${next.label} in ${t}`;
      const wide = fit(T, `${L.looming}   ${bare}`, `${L.looming} ${bare}`, bare);
      const lead = wide === bare ? '' : dim(L.looming) + (wide.includes('   ') ? '   ' : ' ');
      out.push('  ' + lead + bold(col(next.label)) + dim(' in ') + bold(col(t)));
    }
  } else {
    const gloss = '  ·  each window resets before you reach it';
    out.push('  ' + green(L.within) + (fit(T, L.within + gloss, L.within) === L.within ? '' : dim(gloss)));
  }
  out.push('');

  for (const r of rows) out.push(wallRow(r, L, tick, labelW, stale, cols));
  if (rows.length) out.push('');

  // CLEAR — plain language, framed against the binding wall, only when it looms.
  // Each form keeps its ANSWER and spends its evidence: the minutes bought, the
  // "little to gain" verdict and the "no limit pressure" reading are what the
  // reader came for; the token arithmetic behind them is what a narrow pane
  // gives up. `fit` chooses on the plain text, and the branch it picked is then
  // drawn in colour (the colour escapes are zero-width but not zero-length, so
  // they can never be what is measured).
  const B = view.baselineTok || 14000;
  if (next && next.est.rate != null) {
    if (view.contextTokens > B * 1.2) {
      const roi = clearROI({ rate: next.est.rate, usedPct: next.est.usedPct, contextC: view.contextTokens, baselineB: B, calib: null, resetMinutes: next.reset });
      const drop = `   (${tok(view.contextTokens)} → ${tok(B)})`;
      const decision = `clear now → +${fmtMins(roi.boughtMinutes)} before ${next.label}`;
      const line = bold('clear now') + ' → ' + green('+' + fmtMins(roi.boughtMinutes)) + ' before ' + cyan(next.label);
      out.push('  ' + line + (fit(T, decision + drop, decision) === decision ? '' : dim(drop)));
    } else {
      out.push('  ' + dim(fit(T,
        `context near baseline (${tok(view.contextTokens)}) — little to gain from clearing`,
        'near baseline · little to gain')));
    }
    out.push('');
  } else if (rows.length && view.contextTokens > B * 1.2) {
    out.push('  ' + dim(fit(T,
      `no limit pressure · clearing ${tok(view.contextTokens)}→${tok(B)} would only trim cost`,
      'no limit pressure · clearing only trims cost',
      'no limit pressure')));
    out.push('');
  }

  // CONTEXT + footer
  if (view.contextTokens != null) {
    const cp = Math.round((view.contextTokens / view.windowSize) * 100);
    // The meter is the point; the token counts and the cache reading are the
    // gloss, so they are what a narrow pane spends — cache first, since "how
    // full is my context" is answered by the bar and the percentage alone.
    const base = 'ctx'.padEnd(labelW) + ' ' + bar(cp) + ' ' + String(cp).padStart(2) + '%';
    const figure = `  ${tok(view.contextTokens)}/${tok(view.windowSize)}`;
    const cachedTxt = view.cachedPct != null ? `  cached ${view.cachedPct}%` : '';
    const chosen = fit(T, base + figure + cachedTxt, base + figure, base);
    out.push('  ' + 'ctx'.padEnd(labelW) + ' ' + pctColor(cp)(bar(cp)) + ' ' + String(cp).padStart(2) + '%'
      + (chosen === base ? '' : dim(figure))
      + (cachedTxt && chosen === base + figure + cachedTxt ? dim(cachedTxt) : ''));
  }
  if (view.rolling) out.push('  ' + dim(`last ${view.rolling.sessions} sessions · clears ${view.rolling.clears} · median clear @ ${Math.round(view.rolling.medClearPct * 100)}%`));
  // The footer's survivors are the cost and the clear key: one is the session's
  // running total, the other is the only keystroke this screen asks for. The
  // branch goes first (the terminal's own prompt usually says it) and the
  // duration next.
  const cost = view.costUsd != null ? ['$' + view.costUsd.toFixed(2)] : [];
  const dur = view.durationMin != null ? [fmtMins(view.durationMin)] : [];
  const branch = view.branch ? [view.branch] : [];
  const foot = fit(T,
    [...cost, ...dur, ...branch, L.clearKey].join(' · '),
    [...cost, ...dur, L.clearKey].join(' · '),
    [...cost, L.clearKey].join(' · '));
  out.push('  ' + dim(foot));

  return out.join('\n');
}

module.exports = { renderEconomy };
