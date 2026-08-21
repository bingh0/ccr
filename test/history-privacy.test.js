// @ts-check
'use strict';
// test/history-privacy.test.js — the FAR SIDE of the release history scan.
//
// features/design/release-history-privacy.feature holds scanHistory to
// hand-built commit chains, which say exactly what the contract is and would
// stay green if the walk drifted from what git considers reachable. This file
// closes that hole with real git as the oracle, on real repositories:
//
//   1. `git rev-list published..tip` is the truth about WHICH commits a
//      release would newly publish — the reachability arithmetic is the part
//      most likely to be subtly wrong, and it is the part that decides whether
//      a leaking commit is examined at all.
//   2. `git grep <pattern> $(git rev-list ...)` is the truth about WHICH of
//      them carry a string. This is the exact command that caught the 0.4.0
//      near-miss by hand; the scanner has to agree with it, including on the
//      "same blob, many commits" attribution the first implementation got
//      wrong (it named 2 commits where git named 14).
//
// Skips cleanly where git is absent, like the other far-side files.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanHistory, unpublishedCommits, loadPrivatePatterns } = require('../src/history-privacy');

const HAVE_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** Identity and config from here, never the machine's. See the same block in
 * test/git-working-tree.test.js for why '/dev/null' is a literal. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@ccr.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@ccr.invalid',
};

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A repository real git built: `published` commits, then `unpublished` more,
 * with `secret` written into a file that survives from the commit named by
 * `from` onward — the shape that made the 0.4.0 history dangerous.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ published: number, unpublished: number, secret: string, from: number }} spec
 */
function buildRepo(t, spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);

  let n = 0;
  // `seq.txt` changes every commit so git always has something to record;
  // `notes.md` is what carries the secret and stays BYTE-IDENTICAL while it
  // does. That is the shape the attribution has to get right — one blob, many
  // commits — and it is what a naive fixture (rewriting the secret file each
  // time) would accidentally avoid by giving every commit its own blob.
  const commit = (/** @type {string} */ body) => {
    n += 1;
    fs.writeFileSync(path.join(dir, 'notes.md'), body);
    fs.writeFileSync(path.join(dir, 'seq.txt'), String(n));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `commit ${n}`]);
  };

  for (let i = 0; i < spec.published; i += 1) commit(`clean ${i}`);
  const publishedTip = git(dir, ['rev-parse', 'HEAD']).trim();
  for (let i = 0; i < spec.unpublished; i += 1) {
    commit(i + 1 >= spec.from ? `carrying ${spec.secret}` : `clean later ${i}`);
  }
  const tip = git(dir, ['rev-parse', 'HEAD']).trim();

  return { dir, gitDir: path.join(dir, '.git'), publishedTip, tip };
}

test('the unpublished set is exactly git rev-list published..tip',
  { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
    const r = buildRepo(t, { published: 3, unpublished: 5, secret: 'x', from: 99 });

    const oracle = git(r.dir, ['rev-list', `${r.publishedTip}..${r.tip}`])
      .split('\n').filter(Boolean).sort();
    const ours = unpublishedCommits(r.gitDir, r.tip, r.publishedTip).commits.sort();

    assert.deepStrictEqual(ours, oracle);
  });

test('a merge commit does not smuggle its side branch past the walk',
  { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
    const r = buildRepo(t, { published: 2, unpublished: 1, secret: 'x', from: 99 });
    // A side branch off the PUBLISHED tip, merged into the tip. Its commits
    // are unpublished too, and a first-parent-only walk would miss them.
    git(r.dir, ['checkout', '-q', '-b', 'side', r.publishedTip]);
    fs.writeFileSync(path.join(r.dir, 'side.md'), 'side work');
    git(r.dir, ['add', '-A']);
    git(r.dir, ['commit', '-q', '-m', 'side']);
    git(r.dir, ['checkout', '-q', 'main']);
    git(r.dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    const tip = git(r.dir, ['rev-parse', 'HEAD']).trim();

    const oracle = git(r.dir, ['rev-list', `${r.publishedTip}..${tip}`])
      .split('\n').filter(Boolean).sort();
    const ours = unpublishedCommits(r.gitDir, tip, r.publishedTip).commits.sort();

    assert.deepStrictEqual(ours, oracle);
  });

test('every commit git grep names is a commit the scan names',
  { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
    // The secret enters at the 2nd unpublished commit and survives to the tip,
    // so one identical blob is reachable from four commits. Naming fewer than
    // all four is the bug this test exists for.
    const secret = 'lineage-widgetworks';
    const r = buildRepo(t, { published: 2, unpublished: 5, secret, from: 2 });

    const revs = git(r.dir, ['rev-list', `${r.publishedTip}..${r.tip}`]).split('\n').filter(Boolean);
    const grep = spawnSync('git', ['grep', '-l', secret, ...revs],
      { cwd: r.dir, encoding: 'utf8', env: GIT_ENV });
    const oracle = [...new Set(grep.stdout.split('\n').filter(Boolean)
      .map((line) => line.split(':')[0]))].sort();

    const result = scanHistory(r.gitDir, {
      tip: r.tip,
      published: r.publishedTip,
      privatePatterns: [new RegExp(secret, 'i')],
    });
    const ours = [...new Set(result.hits
      .filter((h) => h.kind === 'private-pattern')
      .map((h) => h.commit))].sort();

    assert.strictEqual(result.state, 'hits');
    assert.strictEqual(oracle.length, 4, 'the fixture should leak through four commits');
    assert.deepStrictEqual(ours, oracle);
  });

test('a secret confined to already-published commits is not reported',
  { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hp-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'carrying lineage-widgetworks');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'published, and leaking']);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'scrubbed');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'scrub']);
    const publishedTip = git(dir, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'still scrubbed');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'more work']);
    const tip = git(dir, ['rev-parse', 'HEAD']).trim();

    const result = scanHistory(path.join(dir, '.git'), {
      tip, published: publishedTip,
      privatePatterns: [/lineage-widgetworks/i],
    });

    // The leak is real but it is behind the published ref: this release does
    // not publish it, and a gate that refused here would never clear again.
    assert.strictEqual(result.state, 'clean');
  });

test('a packed repository scans the same as a loose one',
  { skip: !HAVE_GIT && 'git is not installed' }, (t) => {
    const secret = 'lineage-widgetworks';
    const r = buildRepo(t, { published: 2, unpublished: 3, secret, from: 2 });
    const opts = { tip: r.tip, published: r.publishedTip, privatePatterns: [new RegExp(secret, 'i')] };

    const loose = scanHistory(r.gitDir, opts);
    git(r.dir, ['repack', '-a', '-d', '-q']);
    const packed = scanHistory(r.gitDir, opts);

    assert.strictEqual(loose.state, 'hits');
    assert.deepStrictEqual(
      packed.hits.map((h) => `${h.commit}:${h.path}`).sort(),
      loose.hits.map((h) => `${h.commit}:${h.path}`).sort());
  });

test('the private supplement is read from an explicit file, comments and all', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'patterns');
  fs.writeFileSync(file, '# a comment\nwidgetworks\n\nacme[0-9]+\n');

  const loaded = loadPrivatePatterns({
    env: { CCR_PRIVATE_PATTERNS_FILE: file },
    homedir: () => dir,
  });

  assert.strictEqual(loaded.configured, true);
  assert.deepStrictEqual(loaded.patterns.map((p) => p.source), ['widgetworks', 'acme[0-9]+']);
  assert.deepStrictEqual(loaded.invalid, []);
});

test('an unparseable private pattern is reported, not silently dropped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'patterns');
  fs.writeFileSync(file, 'widgetworks\n[unclosed\n');

  const loaded = loadPrivatePatterns({
    env: { CCR_PRIVATE_PATTERNS_FILE: file },
    homedir: () => dir,
  });

  // A pattern that failed to compile has stopped protecting anything. The gate
  // refuses on this rather than scanning with a quietly shorter list.
  assert.deepStrictEqual(loaded.invalid, ['[unclosed']);
});

test('every fixture-register entry is still needed, and still fake', () => {
  const { FIXTURE_LITERALS } = require('./privacy-fixtures');
  const { DETECTORS } = require('../src/history-privacy');
  const root = path.join(__dirname, '..');

  for (const f of FIXTURE_LITERALS) {
    // Ratcheted like test/wip-register.js: an entry whose string is gone has
    // stopped excusing anything and starts hiding the next one instead.
    const text = fs.readFileSync(path.join(root, f.where), 'utf8');
    assert.ok(text.includes(f.literal),
      `${f.where} no longer contains ${f.literal} — drop the register entry`);

    // And an entry that no detector would have flagged is not an exception to
    // anything, so it should not be granted one.
    const flagged = DETECTORS.some((d) => d.extract(f.literal).length > 0);
    assert.ok(flagged,
      `${f.literal} is not flagged by any detector — the register entry is dead weight`);
  }
});

test('no configured supplement is reported as unconfigured, not as empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const loaded = loadPrivatePatterns({
    env: { CCR_PRIVATE_PATTERNS_FILE: path.join(dir, 'absent') },
    homedir: () => dir,
  });

  assert.strictEqual(loaded.configured, false);
  assert.deepStrictEqual(loaded.patterns, []);
});
