// @ts-check
'use strict';
// test/git-working-tree.test.js — the FAR SIDE of the working-tree section.
//
// The feature and design tiers hold the readers to hand-built fixtures, which
// state exactly which bytes each parser is held to — and would happily stay
// green if those bytes drifted from what git actually writes. This file closes
// that hole from both directions, with real git as the oracle:
//
//   1. ccr reads repositories REAL git built — including after `git repack`,
//      so the pack path runs against genuine packs and deltas, not just the
//      hand-assembled ones.
//   2. Real git reads ccr's HAND-BUILT fixtures back (`git status`,
//      `git ls-files --stage`), so a fixture format error cannot hide behind
//      a parser that shares it.
//
// Skips cleanly where git is absent, exactly like test/git-repo.test.js. Git
// runs with global and system config disabled: the product reader deliberately
// ignores the user's global excludesFile (features/design/
// git-working-tree-rules.feature records the limit), so the oracle must too.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeWorkingTree } = require('../src/git-working-tree');
const { readIndex } = require('../src/git-index');
const { buildWorkRepo } = require('./steps/_git-fixture');

const HAVE_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** The isolated environment every oracle git call runs in — the machine's
 * global and system config disabled, identity from the environment. */
const GIT_ENV = {
  ...process.env,
  // The LITERAL '/dev/null', NOT os.devNull: git special-cases this exact
  // string on every platform (Git for Windows included), while Windows'
  // own device path \\.\nul makes git fail with 'unable to access'.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'oracle', GIT_AUTHOR_EMAIL: 'oracle@ccr.invalid',
  GIT_COMMITTER_NAME: 'oracle', GIT_COMMITTER_EMAIL: 'oracle@ccr.invalid',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
};

/** Run git in a repo, isolated from the machine's configuration. */
function git(/** @type {string} */ cwd, /** @type {string[]} */ args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(res.status, 0,
    `git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

const tmp = (/** @type {import('node:test').TestContext} */ t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-oracle-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Our marks, as a sorted "mark path" list. */
const ours = (/** @type {string} */ repo, /** @type {{maxwait?: number}} */ _ = {}) => {
  const wt = computeWorkingTree({ root: repo, gitDir: path.join(repo, '.git') });
  assert.strictEqual(wt.state, 'ok', 'computeWorkingTree degraded on a healthy repo');
  return wt.entries.map((e) => `${e.mark} ${e.path}`).sort();
};

/**
 * git status --porcelain, folded to the pane's four marks: unmerged → "!",
 * a worktree-side difference → "M", an index-side one → "+", untracked → "?".
 */
const theirs = (/** @type {string} */ repo) => git(repo, ['status', '--porcelain'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const x = line[0];
    const y = line[1];
    const p = line.slice(3);
    if (x === '?' ) return `? ${p}`;
    if ('UDA'.includes(x) && 'UDA'.includes(y) && (x === 'U' || y === 'U' || x === y)) return `! ${p}`;
    if (y !== ' ') return `M ${p}`;
    return `+ ${p}`;
  })
  .sort();

test('real git status agrees with computeWorkingTree', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'kept.js'), 'kept\n');
  fs.writeFileSync(path.join(repo, 'src', 'edited.js'), 'original\n');
  fs.writeFileSync(path.join(repo, 'src', 'gone.js'), 'doomed\n');
  fs.writeFileSync(path.join(repo, 'src', 'rm-staged.js'), 'leaving\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);

  fs.writeFileSync(path.join(repo, 'src', 'edited.js'), 'changed since commit\n');   //  M
  fs.rmSync(path.join(repo, 'src', 'gone.js'));                                     //  D → M
  git(repo, ['rm', '-q', 'src/rm-staged.js']);                                      // D  → +
  fs.writeFileSync(path.join(repo, 'staged-new.js'), 'brand new\n');
  git(repo, ['add', 'staged-new.js']);                                              // A  → +
  fs.writeFileSync(path.join(repo, 'untracked.js'), 'loose\n');                     // ??
  fs.writeFileSync(path.join(repo, 'debug.log'), 'ignored\n');                      // (ignored)

  assert.deepStrictEqual(ours(repo), theirs(repo));
});

test('a conflicted merge shows as "!"', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  git(repo, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'side\n');
  git(repo, ['commit', '-q', '-am', 'side']);
  git(repo, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'main\n');
  git(repo, ['commit', '-q', '-am', 'main']);
  // Same isolated env as every other call — an earlier version ran this bare,
  // and the merge aborted on "committer identity unknown" BEFORE conflicting,
  // which the not-zero assertion happily accepted. Requiring the conflict
  // sentence pins the failure to the failure this test is about.
  const merge = spawnSync('git', ['merge', 'side'], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
  assert.notStrictEqual(merge.status, 0, 'the merge was supposed to conflict');
  assert.match(merge.stdout + merge.stderr, /CONFLICT/,
    `the merge failed, but not by conflicting:\n${merge.stderr || merge.stdout}`);

  assert.deepStrictEqual(ours(repo), ['! clash.txt']);
  assert.deepStrictEqual(ours(repo), theirs(repo));
});

test('a packed repository reads the same as a loose one', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  // Similar sizeable files across two commits, so repack has real deltas to
  // make — the point is to run OUR delta path against git's own output.
  const bulk = 'line of filler text\n'.repeat(400);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(repo, `bulk-${i}.txt`), bulk + `tail ${i}\n`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'one']);
  for (let i = 0; i < 6; i += 1) {
    fs.appendFileSync(path.join(repo, `bulk-${i}.txt`), `appended ${i}\n`);
  }
  git(repo, ['commit', '-q', '-am', 'two']);
  const before = ours(repo);
  git(repo, ['repack', '-adq']);
  const loose = fs.readdirSync(path.join(repo, '.git', 'objects'))
    .filter((d) => /^[0-9a-f]{2}$/.test(d));
  assert.deepStrictEqual(loose, [], 'repack -ad should have left no loose object dirs');

  assert.deepStrictEqual(ours(repo), before);
  assert.deepStrictEqual(ours(repo), theirs(repo));
});

test('real git reads the hand-built fixture the way ccr means it', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = buildWorkRepo(path.join(tmp(t), 'fixture'), {
    committed: { 'README.md': 'hello\n', 'src/kept.js': 'kept\n' },
    staged: { 'staged-new.js': 'brand new\n' },
    modified: { 'src/edited.js': ['original\n', 'changed since commit\n'] },
    untracked: { 'untracked.js': 'loose\n' },
  });
  // The stage table: git reads our index byte-for-byte.
  const stages = git(repo, ['ls-files', '--stage']).trim().split('\n').sort();
  assert.deepStrictEqual(stages.map((l) => l.split(/\s+/).slice(3).join(' ')).sort(),
    ['README.md', 'src/edited.js', 'src/kept.js', 'staged-new.js'].sort());
  // The verdicts: git status on our fixture agrees with our own model.
  assert.deepStrictEqual(ours(repo), theirs(repo));
});

test('a v4 index real git wrote reads back path-perfect', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'deep', 'one.js'), '1\n');
  fs.writeFileSync(path.join(repo, 'src', 'deep', 'two.js'), '2\n');
  fs.writeFileSync(path.join(repo, 'top.txt'), 'top\n');
  git(repo, ['add', '-A']);
  git(repo, ['update-index', '--index-version', '4']);
  const idx = readIndex(path.join(repo, '.git'));
  assert.ok(idx, 'the v4 index came back unreadable');
  assert.strictEqual(idx.version, 4);
  assert.deepStrictEqual(idx.entries.map((e) => e.path),
    git(repo, ['ls-files']).trim().split('\n'));
});
