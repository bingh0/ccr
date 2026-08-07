// @ts-check
'use strict';
// src/render/git-pane.js — draw the git pane from a model src/git-repo.js built.
//
// Same split as src/pane-blob.js → src/render/pane.js: the reader is the choke
// point that sanitizes and caps, so this file does no validation and no
// stripping. Every string arriving here is already printable. What it does own
// is LAYOUT, and the one layout rule the contract actually pins is that a value
// too long for the pane is shortened rather than wrapped — a wrapped line
// corrupts the sidecar's cursor-home redraw (the reason clampVisible exists).
//
// The identity line is the pane's whole point: features/git-repo-identity.feature
// exists because six tabs each labelled with an instance name say nothing about
// which repo they sit in. So it is the first row, it is always exactly one row,
// and it budgets its own space rather than letting a long branch name push the
// repo name off the end.

const {
  dim, bold, cyan, green, red, yellow, clampVisible, visibleWidth, ellipsize, charWidth,
} = require('./shared');

// Left margin, matching every other ccr surface.
const INDENT = '  ';

// Fallback width when the caller knows nothing (non-TTY, `ccr sidecar` piped).
// Same default the external pane renderer uses.
const DEFAULT_WIDTH = 48;

// The launch repo gets its OWN ROW, and this is a contract detail rather than a
// layout preference. The option the visionary chose at scoping was "Follows,
// with the launch repo pinned — shows the current repo, but ALWAYS keeps the
// launch repo visible AS A SECOND LINE, so the tab keeps a stable identity while
// the pane tracks the work" (features/OUT-OF-SCOPE.md, Roads not taken).
//
// An earlier build put it inline as "launch › current" and had to invent a rule
// for dropping it when the row got tight — which meant a repo with a long branch
// name silently lost the pinned identity the option promises to keep. A second
// row cannot be crowded out by a branch name.
const LAUNCH_PREFIX = 'launched in ';

/**
 * Lay two values out on one line: `left` at the margin, `right` flushed to the
 * end, at least `gap` columns between them. When they do not both fit, each
 * gets what it needs up to a fair half and the remainder goes to the other, so
 * a short name never costs a long one room it could have used.
 *
 * @param {string} left
 * @param {string} right
 * @param {number} avail  Columns available to left + gap + right.
 * @param {number} gap
 * @returns {{ left: string, right: string, pad: number }}
 */
function fitPair(left, right, avail, gap) {
  const room = Math.max(0, avail - gap);
  const wl = visibleWidth(left);
  const wr = visibleWidth(right);
  if (wl + wr <= room) return { left, right, pad: room - wl - wr + gap };
  const half = Math.floor(room / 2);
  let bl;
  let br;
  if (wl <= half) { bl = wl; br = room - wl; } else if (wr <= half) { br = wr; bl = room - wr; } else { bl = room - half; br = half; }
  return { left: ellipsize(left, bl), right: ellipsize(right, br), pad: gap };
}

/**
 * The identity row — one row, always, whatever the model says.
 *
 * The position marker arrives as PLAIN text and is coloured here, deliberately.
 * Passing it in pre-coloured is the obvious shape and it is wrong: visibleWidth
 * counts display characters and knows nothing about SGR, so a dimmed "  2/2"
 * measures 13 columns instead of 5 and quietly steals eight from the names.
 * That version rendered fine at 48 columns and collapsed to "c…  …" at 20 —
 * a layout bug that only appears off the demo path.
 *
 * @param {import('../git-repo').RepoIdentity} id
 * @param {number} width     Total columns the row may occupy, marker included.
 * @param {string} position  Plain cycle position, e.g. "2/3" (may be '').
 * @returns {string}
 */
function identityLine(id, width, position) {
  const markerText = position ? '  ' + position : '';
  const marker = markerText ? dim(markerText) : '';
  const avail = Math.max(1, width - visibleWidth(INDENT) - visibleWidth(markerText));

  // ONE layout for every state. The right-hand slot holds the branch when there
  // is one and the state's own sentence when there is not, so a repository whose
  // HEAD cannot be read still gets NAMED on the left — the pane's entire job.
  // An earlier version early-returned on any non-ok state and threw the name
  // away, though the model had it.
  //
  // The two failure sentences stay distinct: "not a git repository" is a fact
  // about the directory, and features/git-pane-safety.feature separately
  // requires that a repo whose data cannot be READ says so instead. Conflating
  // them would report a broken clone as a scratch directory.
  const right = id.state === 'unreadable'
    ? { text: 'git data unavailable', paint: yellow }
    : id.state !== 'ok'
      ? { text: 'not a git repository', paint: dim }
      // Before `detached`, because it is the larger fact: a bare repository has
      // no working tree, so there is no checkout for a branch name to describe
      // and nothing for the working-tree section to ever show. "bare", not
      // "empty" — `git init --bare` then push a thousand commits and it is
      // still bare, so "empty" would be a different claim, and a false one.
      : id.bare
        ? { text: 'bare repository', paint: yellow }
        : id.detached
          ? { text: 'detached', paint: yellow }
        // The `|| ''` is a type guard, not a case: readHead returns either a
        // non-empty branch or detached: true, so an ok state with a null branch
        // cannot occur. It stays because `branch` is nullable in the model and
        // strict mode is right to insist the reader handle that.
        : { text: id.branch || '', paint: cyan };

  // Nothing to name on the left — the row is the sentence alone, which is what
  // "the pane shows no branch name" pins for a plain scratch directory. The
  // launch repo, if there is one, is a separate row and does not appear here.
  if (!id.name) return INDENT + right.paint(right.text) + marker;

  const leftPlain = id.name;
  const leftColored = bold(id.name);
  const fit = fitPair(leftPlain, right.text, avail, 2);
  // Re-apply colour only when the plain text survived intact; a shortened value
  // is rebuilt from the fitted string, so the ellipsis lands inside the colour
  // run rather than after it.
  const leftOut = fit.left === leftPlain ? leftColored : bold(fit.left);
  const rightOut = fit.right === right.text ? right.paint(right.text) : right.paint(fit.right);
  return INDENT + leftOut + ' '.repeat(Math.max(1, fit.pad)) + rightOut + marker;
}

// ── The working-tree section ────────────────────────────────────────────────
//
// Sits between the identity rows and the commit graph, which is why its row
// budget is a stated formula rather than "whatever fits": the flat file list
// and the graph compete for the same rows (features/git-working-tree.feature's
// header says so), and the cap is the contract's answer to that competition.

// Rows always reserved for the commit graph below the list, so a long file
// list can never starve history off the pane entirely.
const GRAPH_RESERVE = 8;

// The section's own chrome: the counts row, the possible rebase row, the
// possible "N more" row, and the blank line above the section.
const WT_CHROME = 4;

// A ceiling regardless of pane height: past this many file rows the list stops
// informing and starts scrolling the reader.
const WT_MAX_FILE_ROWS = 16;

/**
 * How many file rows the working-tree list may use in a pane `rows` tall.
 * Exported because it IS the contract the long-list scenario names ("the pane
 * has room for 8 file rows") — the steps derive the pane height from this
 * formula rather than duplicating the arithmetic.
 * @param {number} rows
 * @returns {number}
 */
function fileRowBudget(rows) {
  return Math.max(2, Math.min(WT_MAX_FILE_ROWS, Math.trunc(rows) - GRAPH_RESERVE - WT_CHROME));
}

/**
 * Shorten from the FRONT, keeping the tail — the working-tree list's rule,
 * because the tail is the file name and the file name is the answer ("A path
 * too long for the pane keeps its file name"). The mirror of ellipsize.
 * @param {string} s
 * @param {number} cols
 * @returns {string}
 */
function ellipsizeStart(s, cols) {
  if (cols <= 0) return '';
  if (visibleWidth(s) <= cols) return s;
  if (cols === 1) return '…';
  const cps = [...s];
  let used = 1; // the ellipsis
  let start = cps.length;
  while (start > 0) {
    const w = charWidth(/** @type {number} */(cps[start - 1].codePointAt(0)));
    if (used + w > cols) break;
    used += w;
    start -= 1;
  }
  return '…' + cps.slice(start).join('');
}

/** @type {Record<import('../git-working-tree').ChangeMark, (s: string) => string>} */
const MARK_PAINT = { '!': red, '+': green, M: yellow, '?': dim };

/**
 * The working-tree rows: counts, the capped file list, the remainder.
 *
 * @param {import('../git-working-tree').WorkingTree} wt
 * @param {{ width: number, rows: number }} opts
 * @returns {string[]}
 */
function workingTreeLines(wt, opts) {
  const { width } = opts;
  if (wt.state !== 'ok') return [INDENT + yellow('git data unavailable')];

  /** @type {string[]} */
  const lines = [];
  // The rebase banner leads: it is the state that explains every "!" below it.
  if (wt.rebase) lines.push(INDENT + yellow('rebase in progress'));

  const total = wt.entries.length;
  if (total === 0) {
    if (!wt.rebase) lines.push(INDENT + dim('clean'));
    return lines;
  }
  // `truncated` means the untracked walk hit its visit budget, so `total` is a
  // floor rather than the count; the "+" keeps the headline honest.
  lines.push(INDENT + (total === 1 && !wt.truncated ? '1 change' : `${total}${wt.truncated ? '+' : ''} changes`));

  const budget = fileRowBudget(opts.rows);
  const listed = wt.entries.slice(0, budget);
  // Columns for the path: margin, one mark column, one space.
  const pathCols = Math.max(1, width - visibleWidth(INDENT) - 2);
  for (const e of listed) {
    lines.push(INDENT + MARK_PAINT[e.mark](e.mark) + ' ' + ellipsizeStart(e.path, pathCols));
  }
  const rest = total - listed.length;
  if (rest > 0) lines.push(INDENT + dim(`${rest}${wt.truncated ? '+' : ''} more`));
  return lines;
}

// ── The commit graph ────────────────────────────────────────────────────────

// One column per lane; the rest of a graph row is margin, hash, subject, age.
// Reserving this much keeps a readable subject at every lane count the budget
// can return.
const LANE_RESERVE = 26;
const MAX_LANES = 6;

/**
 * How many lanes a pane `width` columns wide may draw. Exported for the same
 * reason as fileRowBudget: "the pane has room for 3 lanes" is a fact about
 * THIS formula, and the steps derive the width from it.
 * @param {number} width
 * @returns {number}
 */
function laneBudget(width) {
  return Math.max(1, Math.min(MAX_LANES, Math.trunc(width) - LANE_RESERVE));
}

/**
 * A relative age: "now", then minutes, hours, days. Coarse on purpose — the
 * scenario pins that an age is SHOWN, and a graph is not a clock.
 * @param {number} whenSec
 * @param {number} nowMs
 * @returns {string}
 */
function fmtAge(whenSec, nowMs) {
  const s = Math.max(0, Math.floor(nowMs / 1000) - whenSec);
  if (s < 90) return 'now';
  if (s < 90 * 60) return Math.round(s / 60) + 'm';
  if (s < 36 * 3600) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/**
 * The graph rows: lane cells, short hash, subject, age — plus the overflow
 * count when branches outnumber lanes.
 *
 * @param {import('../git-history').History} history
 * @param {{ width: number, maxRows: number, now: number }} opts
 * @returns {string[]}
 */
function commitGraphLines(history, opts) {
  const { width } = opts;
  if (history.state === 'unavailable') return [INDENT + yellow('git data unavailable')];
  if (history.state === 'empty') return [INDENT + dim('no commits yet')];

  /** @type {string[]} */
  const lines = [];
  const span = Math.max(1, history.laneCount);
  for (const row of history.rows.slice(0, Math.max(1, opts.maxRows))) {
    let cells = '';
    for (let i = 0; i < span; i += 1) {
      if (i === row.lane) cells += '●';
      else if (row.joinLanes && row.joinLanes.includes(i)) cells += '╮';
      else cells += (row.activeMask && row.activeMask[i]) ? '│' : ' ';
    }
    const age = fmtAge(row.when, opts.now);
    // Margin + cells + space + hash + space + subject + gap + age = width.
    const subjCols = Math.max(1,
      width - visibleWidth(INDENT) - span - 1 - row.shortHash.length - 1 - 2 - visibleWidth(age));
    const subject = ellipsize(row.subject, subjCols);
    lines.push(INDENT + cyan(cells) + ' ' + dim(row.shortHash) + ' ' + subject
      + '  ' + dim(age));
  }
  if (history.droppedBranches > 0) {
    lines.push(INDENT + dim(`${history.droppedBranches} more branches`));
  }
  return lines;
}

/**
 * Render the whole git pane.
 *
 * @param {{ identity: import('../git-repo').RepoIdentity,
 *           workingTree?: import('../git-working-tree').WorkingTree,
 *           history?: import('../git-history').History }} model
 * @param {{ width?: number, position?: string, rows?: number, now?: number }} [opts]
 * @returns {string}
 */
function renderGitPane(model, opts = {}) {
  const width = opts.width && opts.width > 0 ? opts.width : DEFAULT_WIDTH;
  const rows = opts.rows && opts.rows > 0 ? opts.rows : 24;
  const id = model.identity;
  const lines = [identityLine(id, width, opts.position || '')];
  // The pinned launch repo: its own row, shown only when it differs from the
  // repo the session is in — a tab that names the same repo twice has told the
  // reader nothing, and the row costs vertical space the graph wants.
  if (id.launchName) {
    lines.push(INDENT + dim(ellipsize(LAUNCH_PREFIX + id.launchName, Math.max(1, width - visibleWidth(INDENT)))));
  }
  // The body sections render only where a working tree can exist: a located,
  // readable, non-bare repository. Everywhere else the identity row already
  // carries the pane's whole sentence.
  const bodied = id.state === 'ok' && !id.bare;
  if (model.workingTree && bodied) {
    lines.push('');
    lines.push(...workingTreeLines(model.workingTree, { width, rows }));
  }
  // The graph sits below the list — and is skipped when the working tree
  // already degraded, so "git data unavailable" is said once, not twice from
  // two sections that failed to read the same store.
  if (model.history && bodied && (!model.workingTree || model.workingTree.state === 'ok')) {
    lines.push('');
    lines.push(...commitGraphLines(model.history, {
      width,
      maxRows: Math.max(3, rows - lines.length - 1),
      now: opts.now != null ? opts.now : 0,
    }));
  }
  // clampVisible is the net, not the mechanism: identityLine already budgets to
  // `width`. It stays because a layout bug must cost a truncated line, never
  // the wrap that corrupts the redraw.
  return lines.map((l) => clampVisible(l, width)).join('\n');
}

module.exports = {
  renderGitPane, identityLine, fitPair, workingTreeLines, commitGraphLines,
  fileRowBudget, laneBudget, ellipsizeStart, fmtAge,
  GRAPH_RESERVE, WT_MAX_FILE_ROWS, MAX_LANES,
};
