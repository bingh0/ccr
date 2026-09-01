// @ts-check
'use strict';
// src/render/subagents.js — the S2 roster view: who is working inside this
// session, what each last said, and what each has spent.
//
// Shape S2 was chosen at scoping over an auto-picked detail zone and over a
// bare roster (features/subagents-view.feature's header records both
// rejections): ONE block per agent, activity inline, no detail zone and no
// navigation keys. So this file draws exactly two rows per agent —
//
//   ● explore  map auth flow                        3m  18K
//     grepping src/auth  0m
//
// — the first carrying the facts a glance wants (type, Claude's own dispatch
// words, age, tokens) and the second carrying what the agent is actually doing.
//
// Same split as src/render/git-pane.js: the reader is the choke point that
// sanitizes and caps (src/subagents.js passes every producer string through
// `stripControl` at CAPTURE, the way parseEvents does), so this file owns
// LAYOUT. It nevertheless treats every string it is handed as hostile — one
// more `stripControl`, a hard cap before any measurement, no interpolation into
// an escape sequence, and no padding whose length is not bounded by the pane
// width. R21 says pane text renders inert and never wedges the redraw, and a
// renderer that relies on an upstream promise for that has moved the guarantee
// somewhere a future refactor can drop it.
//
// This file is PURE: a function of the `rosterView` result (src/subagents.js),
// which is where the display POLICY lives — retirement, live-first slotting,
// newest-finishes ordering, overflow, staleness. Both doors call that policy so
// the pane and `ccr subagents` cannot disagree; what is here is wording and
// columns, and nothing else.

const { stripControl } = require('../sanitize');
const { fmtAge } = require('../liveness');
const {
  dim, bold, green, red, yellow, tok, clampVisible, visibleWidth, ellipsize,
} = require('./shared');

/** Left margin, matching every other ccr surface. */
const INDENT = '  ';

/** The activity row sits under its block's head row, indented past the glyph. */
const ACT_INDENT = '    ';

/** Fallbacks when the caller knows nothing (non-TTY, `ccr sidecar` piped). */
const DEFAULT_WIDTH = 48;
const DEFAULT_ROWS = 24;

/**
 * Two rows per agent — the head row and its activity row — which is what shape
 * S2 IS. Exported because the slot arithmetic is a fact about this layout, and
 * composeFrame must not restate it as a number that can drift from the file
 * that draws the rows.
 */
const ROWS_PER_BLOCK = 2;

/**
 * Rows this view spends on things that are not blocks: the instance-name line
 * composeFrame prepends to every frame, this view's own header, the overflow
 * line and the stale marker. The last two are conditional, so reserving them
 * unconditionally costs at most one block and buys a roster that never grows a
 * line past the pane's last row — which is the soft wrap that corrupts the
 * cursor-home redraw (see clampVisible's header).
 */
const CHROME_ROWS = 4;

/**
 * How many agents the pane's row budget fits. THE seam between the row budget
 * and `rosterView`'s `slots`: composeFrame calls this, and so do the steps that
 * check a scenario's "4 roster slots" against the height they render at, so a
 * changed layout cannot leave the two disagreeing in silence.
 * @param {number} [rows]
 * @returns {number}
 */
function slotsForRows(rows) {
  const r = (typeof rows === 'number' && rows > 0) ? Math.trunc(rows) : DEFAULT_ROWS;
  return Math.max(1, Math.floor((r - CHROME_ROWS) / ROWS_PER_BLOCK));
}

/**
 * State glyphs. `✓` is the DONE glyph specifically — R17 requires a failure to
 * render AS a failure and never to carry it, so the three are kept distinct
 * here rather than collapsed into "finished".
 */
const GLYPH = { live: '●', done: '✓', failed: '✗' };

/** The lineage prefix a nested agent's block carries (R39: display only). */
const NEST = '└ ';

/** The activity row of an agent that has produced nothing observable yet. */
const QUIET = '…';

/**
 * The hard cap on any single producer string before it is measured or cut.
 * src/subagents.js already caps at 512; this is the renderer refusing to
 * measure an unbounded string even if that ever stops being true.
 */
const TEXT_CAP = 512;

/**
 * Every producer string passes through here before it touches a line: coerced,
 * control-stripped a second time, and bounded. The strip is deliberately
 * redundant with the capture-time one in src/subagents.js — "the panel redraws
 * normally afterwards" (R21) must not depend on a promise made in another file.
 * @param {any} s
 * @returns {string}
 */
function text(s) {
  const clean = stripControl(s == null ? '' : s);
  return clean.length > TEXT_CAP ? clean.slice(0, TEXT_CAP) : clean;
}

/**
 * Pad to `avail` columns, never further. The bound matters: the pad width is
 * derived from a producer string's measured width, and an unbounded `repeat`
 * driven by producer text is a denial of service dressed as alignment.
 * @param {number} used
 * @param {number} avail
 * @returns {string}
 */
function pad(used, avail) {
  return ' '.repeat(Math.max(0, Math.min(avail, avail - used)));
}

/**
 * Silence, in the units it is measured in. The stale threshold is 30 seconds
 * (src/subagents.js STALE_MS), and `fmtAge` — which floors to whole minutes
 * because it was written for a snapshot that ages over hours — would render
 * exactly that as "0m". R22 asks the view to state HOW stale it is, so under a
 * minute it says seconds and above one it defers to the house wording.
 * @param {number} ms
 * @returns {string}
 */
function fmtSilence(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : fmtAge(ms);
}

/**
 * An age marker, or '?' when upstream stamped no timestamp to measure from. The
 * wording is `src/liveness.js`'s, shared rather than re-invented so one pane
 * cannot start saying "4 min" while the other says "4m".
 * @param {number|null} ms
 * @returns {string}
 */
function age(ms) {
  return ms == null ? '?' : fmtAge(Math.max(0, ms));
}

/**
 * The header row: the view's name, what it is counting, and the cycle position.
 *
 * The position arrives PLAIN and is coloured here for the reason
 * src/render/git-pane.js states at identityLine — `visibleWidth` knows nothing
 * about SGR, so a pre-dimmed "2/5" measures 12 columns and steals seven from
 * the counts.
 *
 * "finished" rather than "done": a failed agent is finished, and calling it
 * done would be the very conflation R17 exists to prevent.
 *
 * @param {import('../subagents').RosterViewResult|null} view
 * @param {number} width
 * @param {string} position
 * @returns {string}
 */
function headerLine(view, width, position) {
  const markerText = position ? '  ' + position : '';
  const avail = Math.max(1, width - visibleWidth(INDENT) - visibleWidth(markerText));
  const label = ellipsize('subagents', avail);
  let used = visibleWidth(label);
  let out = INDENT + bold(label);

  /** @type {string[]} */
  const bits = [];
  if (view) {
    if (view.live > 0) bits.push(`${view.live} live`);
    if (view.finished > 0) bits.push(`${view.finished} finished`);
  }
  const stats = bits.length ? '  ' + bits.join(' · ') : '';
  if (stats && avail - used > 2) {
    const shown = ellipsize(stats, avail - used);
    out += dim(shown);
    used += visibleWidth(shown);
  }
  return out + pad(used, avail) + (markerText ? dim(markerText) : '');
}

/**
 * The head row of one block: state glyph, type, Claude's own dispatch words,
 * age and tokens — on ONE row, always (R19).
 *
 * The task is the dispatch PROMPT, cut HEAD-FIRST (R10/R18/R19): the head of a
 * prompt says what the agent was sent to do, and a 2000-character brief that
 * wrapped would cost the pane four rows and the redraw its cursor-home
 * invariant. An empty prompt leaves the type alone carrying the row (R18) —
 * there is nothing to shorten, so nothing pretends there is.
 *
 * The type is capped at half the free columns so a long type name
 * ("general-purpose") cannot crowd the task out entirely, and a short one
 * ("explore") never costs the task room it could have used.
 *
 * @param {import('../subagents').RosterViewAgent} a
 * @param {number} width
 * @returns {string}
 */
function headRow(a, width) {
  const state = a.state === 'done' ? 'done' : a.state === 'failed' ? 'failed' : 'live';
  const paint = state === 'live' ? green : state === 'failed' ? red : dim;
  const glyph = GLYPH[state];
  // R39: nesting is a flat roster with a lineage prefix, display only. `depth`
  // is 1 for an agent the session itself dispatched.
  const nest = a.depth > 1 ? NEST : '';

  const right = `${age(a.ageMs)}  ${tok(a.tokens)}`;
  const rightText = '  ' + right;
  const lead = visibleWidth(INDENT) + visibleWidth(nest) + 2; // glyph + its space
  const avail = Math.max(1, width - lead - visibleWidth(rightText));

  const typeShown = ellipsize(text(a.type) || 'agent', Math.max(4, Math.floor(avail / 2)));
  let body = typeShown;
  const taskRoom = avail - visibleWidth(typeShown) - 2;
  const task = text(a.task);
  if (task && taskRoom > 0) body += '  ' + ellipsize(task, taskRoom);

  const used = visibleWidth(body);
  return INDENT + dim(nest) + paint(glyph) + ' ' + body + pad(used, avail) + dim(rightText);
}

/**
 * The activity row: the ladder R11 and R20 ruled, in order.
 *
 *   1. A FAILURE outranks everything (R17). The block must carry what Claude
 *      Code surfaced, and an agent that died mid-sentence still has words —
 *      showing those instead would report the death as ordinary progress.
 *   2. The latest WORDS, with an age marker beside them (R11 final, plus the
 *      objection-3 ruling that added the marker). Words freeze rather than
 *      erase when the feed goes quiet (R22), which needs nothing here: a frozen
 *      word is simply the newest one the model still holds, and its marker ages
 *      on its own.
 *   3. Else the latest TOOL CALL, named (R20). Never invented words.
 *   4. Else the quiet placeholder. An agent 5 seconds old has produced nothing
 *      observable, and saying so is the honest row.
 *
 * @param {import('../subagents').RosterViewAgent} a
 * @param {number} width
 * @returns {string}
 */
function activityRow(a, width) {
  const avail = Math.max(1, width - visibleWidth(ACT_INDENT));

  const failure = text(a.failure);
  if (a.state === 'failed') {
    // The surfaced text, or a bare marker when upstream named no reason — the
    // state is the fact, and an empty quote would read as a successful finish.
    const body = failure || 'failed';
    return ACT_INDENT + red('! ') + ellipsize(body, Math.max(1, avail - 2));
  }

  const words = text(a.words);
  if (words) {
    const marker = '  ' + age(a.wordsAgeMs);
    const room = Math.max(1, avail - visibleWidth(marker));
    return ACT_INDENT + ellipsize(words, room) + dim(marker);
  }

  const tool = text(a.lastTool);
  if (tool) {
    const marker = '  ' + age(a.toolAgeMs);
    const room = Math.max(1, avail - visibleWidth(marker) - 2);
    const arg = text(a.lastToolArg);
    const call = arg ? `${tool} ${arg}` : tool;
    return ACT_INDENT + dim('↳ ') + ellipsize(call, room) + dim(marker);
  }

  return ACT_INDENT + dim(QUIET);
}

/**
 * The overflow line's roll-call. R36 (adversarial) upgraded the line from a
 * count to a count that NAMES the live work beyond the cap, because a bare
 * number is exactly the blindness the visionary's own FOMO standard convicted.
 *
 * Types are grouped in first-seen order and repeats collapse to `×N`, so four
 * agents beyond the slots read "review, migrate, explore ×2" rather than
 * spending the row on the same word twice. Names are added while they fit and
 * then stop — the count has already said how many there are, so a truncated
 * roll-call under-claims rather than lying.
 *
 * @param {string[]} names
 * @param {number} budget
 * @returns {string}
 */
function overflowNamesLabel(names, budget) {
  /** @type {{ type: string, n: number }[]} */
  const groups = [];
  // Null-prototype: the keys are subagent TYPES out of a transcript, so a type
  // called "constructor" or "__proto__" would otherwise read back an inherited
  // function or vanish into a prototype write (the rule src/sidecar.js states
  // at resetFeedState).
  /** @type {Record<string, number>} */
  const index = Object.create(null);
  for (const raw of names) {
    const t = text(raw) || 'agent';
    if (index[t] == null) { index[t] = groups.length; groups.push({ type: t, n: 0 }); }
    groups[index[t]].n += 1;
  }
  let out = '';
  for (const g of groups) {
    const piece = g.n > 1 ? `${g.type} ×${g.n}` : g.type;
    const next = out ? `${out}, ${piece}` : piece;
    if (visibleWidth(next) > budget) break;
    out = next;
  }
  return out;
}

/**
 * Draw the whole view.
 *
 * `view` is a `rosterView` result, or NULL when no session transcript is known
 * yet. The two are different facts and the view says so: "no subagents" is a
 * statement about a session ccr can read, and printing it while ccr has nothing
 * to read at all would be an invented answer.
 *
 * @param {import('../subagents').RosterViewResult|null} view
 * @param {{ width?: number, position?: string }} [opts]
 * @returns {string}
 */
function renderSubagents(view, opts = {}) {
  const width = opts.width && opts.width > 0 ? Math.trunc(opts.width) : DEFAULT_WIDTH;
  const lines = [headerLine(view, width, opts.position || '')];
  const bodyAvail = Math.max(1, width - visibleWidth(INDENT));

  if (!view) {
    lines.push(INDENT + dim(ellipsize('waiting for this session\'s transcript…', bodyAvail)));
    return lines.map((l) => clampVisible(l, width)).join('\n');
  }

  if (view.empty) {
    lines.push(INDENT + dim(ellipsize('no subagents', bodyAvail)));
  } else {
    for (const a of view.agents) {
      lines.push(headRow(a, width));
      lines.push(activityRow(a, width));
    }
  }

  if (view.overflow > 0) {
    const count = `+${view.overflow} more`;
    const names = overflowNamesLabel(view.overflowNames || [], Math.max(0, bodyAvail - visibleWidth(count) - 3));
    lines.push(INDENT + yellow(count) + (names ? dim(' · ' + names) : ''));
  }

  if (view.stale) {
    // R22: whole-transcript silence while the session lives, stating HOW stale.
    // A marker that only said "stale" would leave the reader unable to tell a
    // half-minute pause from an abandoned session.
    const how = view.staleForMs == null ? '?' : fmtSilence(view.staleForMs);
    lines.push(INDENT + yellow(ellipsize(`stale · nothing new for ${how}`, bodyAvail)));
  }

  // clampVisible is the net, not the mechanism: every line above budgets to
  // `width` already. It stays because a layout bug must cost a truncated line,
  // never the wrap that corrupts the sidecar's cursor-home redraw.
  return lines.map((l) => clampVisible(l, width)).join('\n');
}

module.exports = {
  renderSubagents, slotsForRows,
  headerLine, headRow, activityRow, overflowNamesLabel, fmtSilence,
  ROWS_PER_BLOCK, CHROME_ROWS, GLYPH, NEST, QUIET,
};
