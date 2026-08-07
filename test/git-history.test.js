// @ts-check
'use strict';
// test/git-history.test.js — the FAR SIDE of the commit graph, and the
// cino:assertion answer for phase 4: the feature steps hold the graph to
// hand-built fixtures, so the assertions themselves must be held to something
// that is not us. Real git is the oracle — the walker's commit set, order,
// hashes and subjects are compared against `git log`, on histories git itself
// built, loose and packed.
//
// Lane GEOMETRY is deliberately not oracled against `git log --graph`: the
// pane draws a bounded simplification (the contract pins lane counts and the
// merge join, which the feature scenarios assert), and diffing ASCII art
// against git's painter would pin presentation this pane never promised.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readHistory } = require('../src/git-history');

const HAVE_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

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
};

/** Run git with a controlled commit clock: each call may set its own date. */
function git(/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {string[]} */ dates = []) {
  const date = dates[0];
  const env = date
    ? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : GIT_ENV;
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

const tmp = (/** @type {import('node:test').TestContext} */ t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hist-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const gitDirOf = (/** @type {string} */ repo) => path.join(repo, '.git');

test('a linear history matches git log: order, hashes, subjects', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(path.join(repo, 'f.txt'), `v${i}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `step ${i}`], [`2024-01-0${i}T12:00:00Z`]);
  }
  const h = readHistory(gitDirOf(repo));
  assert.strictEqual(h.state, 'ok');
  assert.strictEqual(h.laneCount, 1, 'a merge-free history is one lane');
  const logged = git(repo, ['log', '--format=%H %s']).trim().split('\n');
  assert.deepStrictEqual(h.rows.map((r) => `${r.oid} ${r.subject}`), logged,
    'the walker and git log disagree on order, hashes or subjects');
  for (const r of h.rows) {
    assert.strictEqual(r.shortHash, r.oid.slice(0, 7));
  }
});

test('a merged side branch matches git log --all and joins two lanes', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base'], ['2024-01-01T12:00:00Z']);
  git(repo, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 's.txt'), 'side\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'side work'], ['2024-01-02T12:00:00Z']);
  git(repo, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repo, 'm.txt'), 'main\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'main work'], ['2024-01-03T12:00:00Z']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], ['2024-01-04T12:00:00Z']);

  const h = readHistory(gitDirOf(repo));
  assert.strictEqual(h.state, 'ok');
  assert.strictEqual(h.laneCount, 2, 'one merged side branch is two lanes');
  const ours = h.rows.map((r) => r.oid).sort();
  const theirs = git(repo, ['log', '--all', '--format=%H']).trim().split('\n').sort();
  assert.deepStrictEqual(ours, theirs, 'the walker missed or invented commits');
  const mergeOid = git(repo, ['rev-parse', 'main']).trim();
  const mergeRow = h.rows.find((r) => r.oid === mergeOid);
  assert.ok(mergeRow && mergeRow.joinLanes.length > 0, 'the merge row joins no lane');
});

test('branch tips beyond the lane budget are counted, newest kept', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base'], ['2024-01-01T12:00:00Z']);
  for (let i = 1; i <= 9; i += 1) {
    git(repo, ['checkout', '-q', '-b', `topic-${i}`, 'main']);
    fs.writeFileSync(path.join(repo, `t${i}.txt`), `t${i}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `tip ${i}`], [`2024-01-${String(i + 10).padStart(2, '0')}T12:00:00Z`]);
  }
  const h = readHistory(gitDirOf(repo), { maxLanes: 3 });
  assert.strictEqual(h.state, 'ok');
  // 10 tips (main + 9 topics), 3 lanes: 7 branches are counted, not dropped.
  assert.strictEqual(h.droppedBranches, 7);
  const newest = git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(objectname)', 'refs/heads'])
    .trim().split('\n').slice(0, 3);
  for (const tip of newest) {
    assert.ok(h.rows.some((r) => r.oid === tip),
      `the newest tips keep their lanes; ${tip.slice(0, 7)} is missing`);
  }
});

test('a packed history reads the same as a loose one', { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
  const repo = tmp(t);
  git(repo, ['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 4; i += 1) {
    fs.writeFileSync(path.join(repo, 'f.txt'), 'filler\n'.repeat(100) + i);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `step ${i}`], [`2024-02-0${i}T12:00:00Z`]);
  }
  const before = readHistory(gitDirOf(repo));
  git(repo, ['repack', '-adq']);
  git(repo, ['pack-refs', '--all']);
  const after = readHistory(gitDirOf(repo));
  assert.strictEqual(after.state, 'ok');
  assert.deepStrictEqual(
    after.rows.map((r) => `${r.oid} ${r.subject}`),
    before.rows.map((r) => `${r.oid} ${r.subject}`),
    'repack (objects and refs) changed what the walker sees');
});
