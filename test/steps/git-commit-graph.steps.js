// @ts-check
'use strict';
// Step definitions for features/git-commit-graph.feature.
//
// Same discipline as the other git-pane step files: real bytes (commits and
// refs written by test/steps/_git-fixture.js in git's own formats), rendered
// through composeFrame with the product's knobs only. The far side is
// test/git-working-tree.test.js's graph cases, where the same walker reads
// history REAL git built.
//
// Graph rows are parsed positively: a row is only counted as a commit row when
// it carries lane cells, a short hash, a subject and an age in their places —
// so "drawn in 2 lanes" can never be satisfied by an error line that happens
// to be two characters wide.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame } = require('../../src/sidecar');
const { laneBudget } = require('../../src/render/git-pane');
const { visibleWidth } = require('../../src/render/shared');
const { writeTrees, writeCommit } = require('./_git-fixture');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The view index the git pane occupies (economy is 0). */
const GIT_VIEW = 1;

/** A commit row: margin, lane cells, short hash, subject, trailing age. */
const GRAPH_ROW = /^\s{2}([●│╮ ]+) ([0-9a-f]{7}) (.+?)\s+(now|\d+[mhd])$/;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitCommitGraphSteps(reg) {
  const world = (/** @type {Record<string, any>} */ w) => {
    if (!w.root) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-graph-'));
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
      w.stateDir = path.join(w.root, 'state');
      fs.mkdirSync(w.stateDir, { recursive: true });
      w.repo = path.join(w.root, 'repo');
      w.gitDir = path.join(w.repo, '.git');
      fs.mkdirSync(path.join(w.gitDir, 'objects'), { recursive: true });
      fs.mkdirSync(path.join(w.gitDir, 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(w.gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    }
    return w;
  };

  /** All graph commits carry the empty tree: history scenarios are about
   * structure, and a non-empty tree would drag working-tree marks into the
   * frame these steps parse. */
  const emptyTree = (/** @type {Record<string, any>} */ w) => {
    if (!w.treeOid) w.treeOid = writeTrees(w.gitDir, new Map());
    return w.treeOid;
  };

  /** One commit, timestamped so date-order is exactly the order given. */
  const commit = (/** @type {Record<string, any>} */ w, /** @type {string} */ subject, /** @type {string[]} */ parents, /** @type {number} */ when) =>
    writeCommit(world(w).gitDir, emptyTree(w), { parents, message: subject, when });

  const setRef = (/** @type {Record<string, any>} */ w, /** @type {string} */ branch, /** @type {string} */ oid) => {
    fs.writeFileSync(path.join(w.gitDir, 'refs', 'heads', branch), oid + '\n');
  };

  // A fixed recent base keeps ages in the hours-to-days band whatever the
  // wall clock says at run time.
  const T0 = Math.floor(Date.now() / 1000) - 5 * 86400;

  // ── Given: the history on disk ────────────────────────────────────────────

  reg.define(/^the pane is (\d+) columns wide$/, (w, n) => { world(w).cols = Number(n); });

  reg.define(/^the pane has room for (\d+) lanes$/, (w, n) => {
    for (let cols = 20; cols <= 200; cols += 1) {
      if (laneBudget(cols) === Number(n)) { world(w).cols = cols; return; }
    }
    assert.fail(`no pane width gives a ${n}-lane budget (laneBudget never returns ${n})`);
  });

  reg.define(/^the branch "([^"]+)" has (\d+) commits and no merges$/, (w, branch, n) => {
    world(w);
    /** @type {string[]} */
    let parents = [];
    let tip = '';
    for (let i = 1; i <= Number(n); i += 1) {
      tip = commit(w, `commit ${i} of ${n}`, parents, T0 + i * 3600);
      parents = [tip];
    }
    setRef(w, branch, tip);
    w.newest = tip;
    w.commitCount = Number(n);
  });

  reg.define(/^the branch "([^"]+)" has a side branch merged into it$/, (w, branch) => {
    world(w);
    const base = commit(w, 'base', [], T0);
    const side = commit(w, 'side work', [base], T0 + 3600);
    const tip = commit(w, 'main work', [base], T0 + 7200);
    const merge = commit(w, 'merge side into main', [tip, side], T0 + 10800);
    setRef(w, branch, merge);
    w.newest = merge;
    w.merge = merge;
  });

  reg.define(/^the repo has no commits$/, (w) => {
    // Exactly `git init`: a symbolic HEAD with nothing behind it.
    world(w);
  });

  reg.define(/^the history has (\d+) concurrent branches$/, (w, n) => {
    world(w);
    const base = commit(w, 'shared base', [], T0);
    let newest = '';
    for (let i = 1; i <= Number(n); i += 1) {
      newest = commit(w, `tip of branch ${i}`, [base], T0 + i * 3600);
      setRef(w, `branch-${i}`, newest);
    }
    // HEAD tracks the newest branch, as a checkout would leave it.
    fs.writeFileSync(path.join(w.gitDir, 'HEAD'), `ref: refs/heads/branch-${n}\n`);
    w.newest = newest;
  });

  reg.define(/^the newest commit's subject is "([^"]+)"$/, (w, subject) => {
    world(w);
    const tip = commit(w, subject, [], T0 + 3600);
    setRef(w, 'main', tip);
    w.newest = tip;
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the git pane renders$/, (w) => {
    world(w);
    fs.writeFileSync(path.join(w.stateDir, 'launch-cwd'), w.repo + '\n');
    fs.writeFileSync(path.join(w.stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      workspace: { current_dir: w.repo, project_dir: w.repo },
      cwd: w.repo,
      rate_limits: {},
    }));
    w.frame = composeFrame(w.stateDir, {
      now: Date.now(), view: GIT_VIEW, cols: w.cols || 48, rows: 40, panes: [],
    });
    w.plain = plain(w.frame);
    w.lines = w.plain.split('\n').filter((/** @type {string} */ l, /** @type {number} */ i, /** @type {string[]} */ a) => !(i === a.length - 1 && l === ''));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  /**
   * @param {Record<string, any>} w
   * @returns {Array<{ cells: string, hash: string, subject: string, age: string, row: string }>}
   */
  const graphRows = (w) => {
    /** @type {Array<{ cells: string, hash: string, subject: string, age: string, row: string }>} */
    const out = [];
    for (const l of w.lines) {
      const m = GRAPH_ROW.exec(l);
      if (m) out.push({ cells: m[1], hash: m[2], subject: m[3], age: m[4], row: m[0] });
    }
    return out;
  };

  reg.define(/^the commits are drawn in (\d+) lanes?$/, (w, n) => {
    const rows = graphRows(w);
    assert.ok(rows.length > 0, `no commit rows in:\n${w.plain}`);
    const span = Math.max(...rows.map((r) => r.cells.length));
    assert.strictEqual(span, Number(n),
      `expected ${n} lane(s), the widest cell region spans ${span}:\n${rows.map((r) => JSON.stringify(r.cells)).join('\n')}`);
  });

  reg.define(/^the newest commit is on the first row$/, (w) => {
    const rows = graphRows(w);
    assert.ok(rows.length > 0, `no commit rows in:\n${w.plain}`);
    assert.strictEqual(rows[0].hash, w.newest.slice(0, 7),
      `the first row holds ${rows[0].hash}, the newest commit is ${w.newest.slice(0, 7)}`);
  });

  reg.define(/^each commit row shows a short hash, a subject and a relative age$/, (w) => {
    // GRAPH_ROW only matches rows that carry all three, so the claim reduces
    // to: every commit made it to a row, and nothing else pretends to be one.
    const rows = graphRows(w);
    assert.strictEqual(rows.length, w.commitCount,
      `${w.commitCount} commits should render as ${w.commitCount} full rows; matched ${rows.length}:\n${w.plain}`);
    for (const r of rows) {
      assert.ok(r.subject.trim().length > 0, `a row has no subject: "${r.row}"`);
    }
  });

  reg.define(/^the merge commit joins the two lanes$/, (w) => {
    const row = graphRows(w).find((r) => r.hash === w.merge.slice(0, 7));
    assert.ok(row, `the merge commit ${w.merge.slice(0, 7)} has no row:\n${w.plain}`);
    assert.ok(row.cells.includes('●') && row.cells.includes('╮'),
      `the merge row's cells ${JSON.stringify(row.cells)} do not join a second lane`);
  });

  reg.define(/^the pane shows "([^"]+)"$/, (w, text) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.trim() === text),
      `no row reads "${text}" in:\n${w.plain}`);
  });

  reg.define(/^the pane draws no lanes$/, (w) => {
    assert.deepStrictEqual(graphRows(w), [],
      `expected no commit rows, got:\n${graphRows(w).map((/** @type {any} */ r) => r.row).join('\n')}`);
    assert.ok(!w.lines.some((/** @type {string} */ l) => /[●│]/.test(l)),
      `lane glyphs appear outside commit rows:\n${w.plain}`);
  });

  reg.define(/^the commit row is at most (\d+) columns wide$/, (w, n) => {
    const rows = graphRows(w);
    assert.strictEqual(rows.length, 1, `expected exactly one commit row, got:\n${w.plain}`);
    const width = visibleWidth(rows[0].row);
    assert.ok(width <= Number(n),
      `the commit row is ${width} columns, over the ${n}-column pane: "${rows[0].row}"`);
  });

  reg.define(/^the commit row contains "([^"]+)"$/, (w, text) => {
    const rows = graphRows(w);
    assert.strictEqual(rows.length, 1, `expected exactly one commit row, got:\n${w.plain}`);
    assert.ok(rows[0].row.includes(text),
      `"${text}" is missing from the commit row "${rows[0].row}"`);
  });
};
