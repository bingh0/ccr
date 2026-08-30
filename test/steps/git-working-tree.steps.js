// @ts-check
'use strict';
// Step definitions for features/git-working-tree.feature.
//
// Same discipline as git-repo-identity.steps.js: the REAL path end to end. The
// repositories are real bytes on disk — a v2 index, loose commit and tree
// objects, worktree files with the cached stats each scenario means — built by
// test/steps/_git-fixture.js, and the pane renders through composeFrame with
// the product's own knobs (view index, columns, rows) and nothing else.
// test/git-working-tree.test.js holds these fixtures against real git.
//
// The one derived knob: "the pane has room for 8 file rows" is a fact about
// the pane's ROW BUDGET, so the step derives the pane height from the same
// exported formula the renderer budgets with (fileRowBudget), rather than
// duplicating the arithmetic and drifting when it changes.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame } = require('../../src/sidecar');
const { fileRowBudget } = require('../../src/render/git-pane');
const { visibleWidth } = require('../../src/render/shared');
const { buildWorkRepo } = require('./_git-fixture');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The view index the git pane occupies (economy is 0). */
const GIT_VIEW = 1;

// Tall enough that nothing in the ordinary scenarios is capped; the long-list
// scenario overrides it through its own Given.
const DEFAULT_ROWS = 40;

/** A file row: two-space margin, one mark, one space, a path. */
const FILE_ROW = /^\s{2}[!+M?] \S/;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitWorkingTreeSteps(reg) {
  /** Lazily create the sandbox: a scratch root plus the sidecar's state dir. */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (!w.root) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-wt-'));
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
      w.stateDir = path.join(w.root, 'state');
      fs.mkdirSync(w.stateDir, { recursive: true });
      /** @type {import('./_git-fixture').RepoSpec} */
      w.spec = {};
    }
    return w;
  };

  /** Accumulate into the scenario's repository spec; built at the When. */
  const spec = (/** @type {Record<string, any>} */ w) => world(w).spec;

  // Contents sized so a modified file differs from its committed form in SIZE,
  // exercising the cheap stat path; the same-size content path is pinned by
  // the design tier, where a byte-level criterion belongs.
  const COMMITTED = 'committed content\n';
  const EDITED = 'edited since the last commit\n';

  // ── Given: the world on disk ──────────────────────────────────────────────

  reg.define(/^the pane is (\d+) columns wide$/, (w, n) => { world(w).cols = Number(n); });

  reg.define(/^the pane has room for (\d+) file rows$/, (w, n) => {
    // Derived through the renderer's own exported budget: the smallest pane
    // height whose file-row allowance is exactly n. Failing to find one means
    // the Given asks for a budget the product cannot be configured to have —
    // a contract change, and it should fail here, loudly.
    for (let rows = 1; rows <= 200; rows += 1) {
      if (fileRowBudget(rows) === Number(n)) { world(w).rows = rows; return; }
    }
    assert.fail(`no pane height gives a ${n}-file-row budget (fileRowBudget never returns ${n})`);
  });

  reg.define(/^the repo has the staged file "([^"]+)"$/, (w, p) => {
    spec(w).staged = { ...spec(w).staged, [String(p)]: `staged content of ${p}\n` };
  });

  reg.define(/^the repo has the modified file "([^"]+)"$/, (w, p) => {
    spec(w).modified = { ...spec(w).modified, [String(p)]: [COMMITTED, EDITED] };
  });

  reg.define(/^the repo has the untracked file "([^"]+)"$/, (w, p) => {
    spec(w).untracked = { ...spec(w).untracked, [String(p)]: `untracked content of ${p}\n` };
  });

  reg.define(/^the repo has no staged, modified or untracked files$/, (w) => {
    // Not an empty repository — a repository with HISTORY and nothing in
    // flight, which is what "clean" claims. An empty repo would let a pane
    // that shows "clean" whenever it fails to read anything pass.
    spec(w).committed = { 'README.md': COMMITTED, 'src/main.js': COMMITTED };
  });

  reg.define(/^the repo has (\d+) modified files$/, (w, n) => {
    /** @type {Record<string, [string, string]>} */
    const m = { ...spec(w).modified };
    for (let i = 1; i <= Number(n); i += 1) {
      m[`src/file-${String(i).padStart(3, '0')}.js`] = [COMMITTED, EDITED];
    }
    spec(w).modified = m;
  });

  reg.define(/^the repo is part-way through a rebase$/, (w) => { spec(w).rebase = true; });

  reg.define(/^the repo has the conflicted file "([^"]+)"$/, (w, p) => {
    spec(w).conflicted = [...(spec(w).conflicted || []), p];
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the git pane renders$/, (w) => {
    world(w);
    const repo = buildWorkRepo(path.join(w.root, 'repo'), w.spec);
    fs.writeFileSync(path.join(w.stateDir, 'launch-cwd'), repo + '\n');
    fs.writeFileSync(path.join(w.stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      workspace: { current_dir: repo, project_dir: repo },
      cwd: repo,
      rate_limits: {},
    }));
    // `panes: []` pins the external-pane list so the developer's own config
    // cannot change what this scenario renders.
    w.frame = composeFrame(w.stateDir, {
      now: Date.now(), view: GIT_VIEW, cols: w.cols || 48, rows: w.rows || DEFAULT_ROWS, panes: [],
    });
    w.plain = plain(w.frame);
    w.lines = w.plain.split('\n').filter((/** @type {string} */ l, /** @type {number} */ i, /** @type {string[]} */ a) => !(i === a.length - 1 && l === ''));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  const fileRows = (/** @type {Record<string, any>} */ w) =>
    w.lines.filter((/** @type {string} */ l) => FILE_ROW.test(l));

  reg.define(/^the pane shows (\d+) changes? in total$/, (w, n) => {
    const want = Number(n) === 1 ? '1 change' : `${n} changes`;
    assert.ok(w.lines.some((/** @type {string} */ l) => l.trim() === want),
      `no "${want}" row in:\n${w.plain}`);
  });

  reg.define(/^"([^"]+)" is listed with "(.)"$/, (w, p, mark) => {
    const want = `${mark} ${p}`;
    assert.ok(fileRows(w).some((/** @type {string} */ l) => l.trim() === want),
      `no row "${want}" among:\n${fileRows(w).join('\n') || '(no file rows)'}\nfull pane:\n${w.plain}`);
  });

  reg.define(/^the pane shows "([^"]+)"$/, (w, text) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.trim() === text || l.includes(String(text))),
      `"${text}" is missing from:\n${w.plain}`);
  });

  reg.define(/^the pane lists no file paths$/, (w) => {
    assert.deepStrictEqual(fileRows(w), [],
      `expected no file rows, got:\n${fileRows(w).join('\n')}`);
  });

  reg.define(/^the pane lists (\d+) file paths$/, (w, n) => {
    assert.strictEqual(fileRows(w).length, Number(n),
      `expected ${n} file rows, got ${fileRows(w).length}:\n${fileRows(w).join('\n')}`);
  });

  reg.define(/^the file row is at most (\d+) columns wide$/, (w, n) => {
    const rows = fileRows(w);
    assert.strictEqual(rows.length, 1, `expected exactly one file row, got:\n${rows.join('\n')}`);
    const width = visibleWidth(rows[0]);
    assert.ok(width <= Number(n),
      `the file row is ${width} columns, over the ${n}-column pane: "${rows[0]}"`);
  });

  reg.define(/^the file row ends with "([^"]+)"$/, (w, tail) => {
    const rows = fileRows(w);
    assert.strictEqual(rows.length, 1, `expected exactly one file row, got:\n${rows.join('\n')}`);
    assert.ok(rows[0].trimEnd().endsWith(tail),
      `"${rows[0].trimEnd()}" should end with "${tail}"`);
  });

  reg.define(/^the commit graph is still drawn below the list$/, (w) => {
    // A commit row in full: lane cells, short hash, subject, age. Anything
    // less (an error line, a stray glyph) does not count as "drawn".
    const isCommitRow = (/** @type {string} */ l) => /^\s{2}[●│╮ ]+ [0-9a-f]{7} .+\s(now|\d+[mhd])$/.test(l);
    const lastFile = w.lines.reduce(
      (/** @type {number} */ acc, /** @type {string} */ l, /** @type {number} */ i) => (FILE_ROW.test(l) ? i : acc), -1);
    assert.ok(lastFile !== -1, `no file rows to be below:\n${w.plain}`);
    assert.ok(w.lines.slice(lastFile + 1).some(isCommitRow),
      `no commit row below the file list:\n${w.plain}`);
  });
};
