// @ts-check
'use strict';
// Design-tier steps for features/design/git-working-tree-rules.feature: the
// modified-check's stat-vs-content rule, the ignore subset, the walk budget,
// and the renderer's row-budget arithmetic, driven directly.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeWorkingTree } = require('../../src/git-working-tree');
const { fileRowBudget, workingTreeLines } = require('../../src/render/git-pane');
const { buildWorkRepo, writeIndex, writeTrees, writeCommit, blobOid } = require('../steps/_git-fixture');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitWorkingTreeRulesSteps(reg) {
  const world = (/** @type {Record<string, any>} */ w) => {
    if (!w.repo) {
      w.repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-wtr-'));
      w.defer(() => fs.rmSync(w.repo, { recursive: true, force: true }));
      w.gitDir = path.join(w.repo, '.git');
    }
    return w;
  };

  /** An empty-but-real repository: HEAD on an unborn main, no index yet. */
  const bareBones = (/** @type {Record<string, any>} */ w) => {
    world(w);
    if (!fs.existsSync(w.gitDir)) {
      fs.mkdirSync(path.join(w.gitDir, 'objects'), { recursive: true });
      fs.mkdirSync(path.join(w.gitDir, 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(w.gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    }
    return w;
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^a repo whose committed file "([^"]+)" holds "([^"]+)"$/, (w, p, content) => {
    world(w);
    buildWorkRepo(w.repo, { committed: { [p]: content } });
  });

  reg.define(/^the working copy of "([^"]+)" was edited to "([^"]+)" at a new timestamp$/, (w, p, content) => {
    // Same byte count as the committed form, fresh mtime: the stat shortcut
    // sees a matching size and a changed time, and only the content hash can
    // answer. The scenario fails if the sizes accidentally diverge, because
    // then it would no longer be testing what it names.
    const file = path.join(w.repo, p);
    assert.strictEqual(Buffer.byteLength(content), fs.statSync(file).size,
      'fixture: the edit must keep the size, or the stat path answers first');
    fs.writeFileSync(file, content);
  });

  reg.define(/^the working copy of "([^"]+)" was touched without changing it$/, (w, p) => {
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(w.repo, p), now, now);
  });

  reg.define(/^a repo ignoring "([^"]+)"$/, (w, pattern) => {
    world(w);
    buildWorkRepo(w.repo, { committed: { 'README.md': 'hello\n' } });
    fs.writeFileSync(path.join(w.repo, '.gitignore'), pattern + '\n');
    // The ignore file itself is untracked; track it so the scenarios below
    // count only the files they name.
    trackGitignore(w);
  });

  reg.define(/^a repo ignoring "([^"]+)" except "([^"]+)"$/, (w, pattern, keep) => {
    world(w);
    buildWorkRepo(w.repo, { committed: { 'README.md': 'hello\n' } });
    fs.writeFileSync(path.join(w.repo, '.gitignore'), pattern + '\n!' + keep + '\n');
    trackGitignore(w);
  });

  reg.define(/^the directory "([^"]+)" re-includes "([^"]+)" in its own \.gitignore$/, (w, dir, pattern) => {
    const sub = path.join(w.repo, dir);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.gitignore'), '!' + pattern + '\n');
    // Deliberately untracked and unignored: it shows as "?", and the Thens
    // name their paths explicitly, so it cannot be mistaken for the subject.
  });

  reg.define(/^a repo whose exclude file ignores "([^"]+)"$/, (w, pattern) => {
    world(w);
    buildWorkRepo(w.repo, { committed: { 'README.md': 'hello\n' } });
    fs.mkdirSync(path.join(w.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(w.gitDir, 'info', 'exclude'), pattern + '\n');
  });

  reg.define(/^the working tree holds the file "([^"]+)"$/, (w, p) => {
    const abs = path.join(world(w).repo, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `content of ${p}\n`);
  });

  reg.define(/^a repo whose committed file "([^"]+)" is staged for deletion$/, (w, p) => {
    // `git rm` leaves: the path in HEAD's tree, absent from the index, absent
    // from the working tree. Assembled from the primitives because it is the
    // one shape the high-level builder deliberately cannot express.
    bareBones(w);
    const oid = blobOid(`content of ${p}\n`);
    const commit = writeCommit(w.gitDir, writeTrees(w.gitDir, new Map([[p, { oid, mode: 0o100644 }]])));
    fs.writeFileSync(path.join(w.gitDir, 'refs', 'heads', 'main'), commit + '\n');
    writeIndex(w.gitDir, []);
  });

  reg.define(/^a repo holding more untracked files than a 10-entry walk budget$/, (w) => {
    world(w);
    buildWorkRepo(w.repo, { committed: { 'README.md': 'hello\n' } });
    for (let i = 1; i <= 30; i += 1) {
      fs.writeFileSync(path.join(w.repo, `file-${String(i).padStart(2, '0')}.txt`), 'x\n');
    }
  });

  reg.define(/^a pane (\d+) rows tall$/, (w, rows) => { w.rows = Number(rows); });

  reg.define(/^a working tree of (\d+) modified entries$/, (w, n) => {
    w.model = {
      state: 'ok',
      rebase: false,
      truncated: false,
      entries: Array.from({ length: Number(n) }, (_, i) => ({
        path: `src/file-${String(i + 1).padStart(3, '0')}.js`, mark: 'M',
      })),
    };
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the working tree is computed$/, (w) => {
    w.wt = computeWorkingTree({ root: w.repo, gitDir: w.gitDir });
    assert.strictEqual(w.wt.state, 'ok', 'the working tree came back unavailable');
  });

  reg.define(/^the working tree is computed with that budget$/, (w) => {
    w.wt = computeWorkingTree({ root: w.repo, gitDir: w.gitDir }, { maxVisited: 10 });
    assert.strictEqual(w.wt.state, 'ok', 'the working tree came back unavailable');
  });

  reg.define(/^the file-row budget is computed$/, (w) => {
    w.budget = fileRowBudget(w.rows);
  });

  reg.define(/^the working-tree lines are rendered$/, (w) => {
    w.lines = workingTreeLines(w.model, { width: 48, rows: w.rows })
      .map((/** @type {string} */ l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  const marksOf = (/** @type {Record<string, any>} */ w) =>
    w.wt.entries.map((/** @type {any} */ e) => `${e.mark} ${e.path}`);

  reg.define(/^"([^"]+)" is marked "(.)"$/, (w, p, mark) => {
    assert.ok(marksOf(w).includes(`${mark} ${p}`),
      `"${mark} ${p}" is not among: ${marksOf(w).join(', ') || '(nothing marked)'}`);
  });

  reg.define(/^"([^"]+)" is not listed$/, (w, p) => {
    assert.ok(!w.wt.entries.some((/** @type {any} */ e) => e.path === p),
      `"${p}" should not be listed; got: ${marksOf(w).join(', ')}`);
  });

  reg.define(/^nothing is marked$/, (w) => {
    assert.deepStrictEqual(marksOf(w), [],
      `expected a clean tree, got: ${marksOf(w).join(', ')}`);
  });

  reg.define(/^the result is marked truncated$/, (w) => {
    assert.strictEqual(w.wt.truncated, true,
      `the walk should have admitted stopping; it listed ${w.wt.entries.length} entries`);
  });

  reg.define(/^the list may use (\d+) rows$/, (w, n) => {
    assert.strictEqual(w.budget, Number(n));
  });

  reg.define(/^(\d+) file rows are rendered$/, (w, n) => {
    const rows = w.lines.filter((/** @type {string} */ l) => /^\s{2}[!+M?] \S/.test(l));
    assert.strictEqual(rows.length, Number(n),
      `expected ${n} file rows, got ${rows.length}`);
  });

  reg.define(/^a rendered row says "([^"]+)"$/, (w, text) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.trim() === text),
      `no row reads "${text}"; rows:\n${w.lines.join('\n')}`);
  });
};

/**
 * Commit the just-written .gitignore into the index so it does not appear as
 * an untracked file of its own — the ignore scenarios count only the files
 * they name.
 * @param {Record<string, any>} w
 */
function trackGitignore(w) {
  const gi = path.join(w.repo, '.gitignore');
  const content = fs.readFileSync(gi, 'utf8');
  const past = Math.floor(Date.now() / 1000) - 900;
  fs.utimesSync(gi, past, past);
  const oid = blobOid(content);
  const readmeOid = blobOid('hello\n');
  const files = new Map([
    ['.gitignore', { oid, mode: 0o100644 }],
    ['README.md', { oid: readmeOid, mode: 0o100644 }],
  ]);
  const commit = writeCommit(w.gitDir, writeTrees(w.gitDir, files));
  fs.writeFileSync(path.join(w.gitDir, 'refs', 'heads', 'main'), commit + '\n');
  writeIndex(w.gitDir, [
    { path: '.gitignore', oid, size: Buffer.byteLength(content), mtimeSec: past },
    { path: 'README.md', oid: readmeOid, size: 6, mtimeSec: past },
  ]);
}
