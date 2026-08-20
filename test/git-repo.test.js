// @ts-check
'use strict';
// test/git-repo.test.js — the .git reader against layouts real git produces,
// and the launch-repo leg end to end.
//
// WHY THIS FILE EXISTS. An adversarial review addressed at `cino:code` measured
// coverage of src/git-repo.js and found two regions never executed: the
// `.git`-is-a-FILE branch (linked worktrees and submodules) and the `unreadable`
// return. Both regions turned out to contain a defect, which is the whole
// argument for the file — the feature scenarios drove one layout only (a `.git`
// directory holding a loose ref) from fixtures the steps write by hand.
//
// The far-side rule applies here and shapes the design: ground truth must not be
// an artifact the system under test wrote. So the fixtures are built by REAL
// git and the expected answers come from `git rev-parse`, not from this file's
// idea of what git writes. The product may never run a command; a test may, and
// this is exactly what that freedom is for.
//
// Everything git-dependent skips cleanly where git is absent, so the suite still
// passes on a machine without it — which is why these live here rather than in
// the product's own scenarios.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readGitRepo, discoverRepo, MAX_WALK, NAME_MAX } = require('../src/git-repo');
const { renderGitPane } = require('../src/render/git-pane');
const { recordLaunchDir } = require('../src/state-dir');
// features/design/test-link-fixtures.feature — a symlink to a FILE cannot be
// planted unprivileged on Windows, and no substitute preserves the property
// under test, so this one skips by name there.
const { plantFileLink, skipWithoutFileSymlinks } = require('./_links');

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const HAS_GIT = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A scratch directory, removed after the test. */
function tmp(/** @type {any} */ t) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gitrepo-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Run git in `cwd`, with an identity so commits work on a bare CI machine. */
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ccr', GIT_AUTHOR_EMAIL: 'ccr@example.invalid',
      GIT_COMMITTER_NAME: 'ccr', GIT_COMMITTER_EMAIL: 'ccr@example.invalid',
      // The LITERAL '/dev/null', NOT os.devNull: git special-cases this exact
      // string on every platform (Git for Windows included), while Windows'
      // own device path \\.\nul makes git fail with 'unable to access'.
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();

/** A repo with one commit on `main`. */
function repoWithCommit(/** @type {string} */ dir, /** @type {string[]} */ initArgs = []) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch=main', ...initArgs, '.']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-qm', 'first']);
  return dir;
}

/** What git itself says the branch is — the far-side answer. */
const gitBranch = (/** @type {string} */ dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
// path.resolve: git prints the toplevel with forward slashes on every
// platform, ccr's walk answers in the host's separators — the comparison is
// about the LOCATION, so both sides go through the host's own normalizer.
const gitRoot = (/** @type {string} */ dir) => path.resolve(git(dir, ['rev-parse', '--show-toplevel']));

// ── Layouts real git produces ────────────────────────────────────────────────

test('a linked worktree, where .git is a FILE, is named like any other repo', { skip: !HAS_GIT }, (t) => {
  const root = tmp(t);
  const main = repoWithCommit(path.join(root, 'main'));
  const wt = path.join(root, 'wt');
  git(main, ['worktree', 'add', '-q', '-b', 'side', wt]);

  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'fixture: a worktree .git must be a file');
  const id = readGitRepo({ currentDir: wt, launchDir: wt });
  assert.strictEqual(id.state, 'ok');
  assert.strictEqual(id.name, 'wt');
  assert.strictEqual(id.branch, gitBranch(wt), 'the branch must match what git reports');
});

test('a submodule, also a .git file, names the submodule and its own branch', { skip: !HAS_GIT }, (t) => {
  const root = tmp(t);
  const child = repoWithCommit(path.join(root, 'child'));
  const parent = repoWithCommit(path.join(root, 'parent'));
  try {
    git(parent, ['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', child, 'sub']);
  } catch {
    t.skip('this git refuses local-path submodules');
    return;
  }
  const sub = path.join(parent, 'sub');
  const id = readGitRepo({ currentDir: sub, launchDir: sub });
  assert.strictEqual(id.state, 'ok');
  assert.strictEqual(id.name, 'sub');
  assert.strictEqual(id.root, gitRoot(sub));
});

test('a repo whose git dir lives elsewhere is still named', { skip: !HAS_GIT }, (t) => {
  const root = tmp(t);
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '--initial-branch=main', `--separate-git-dir=${path.join(root, 'elsewhere.git')}`, '.']);
  const id = readGitRepo({ currentDir: work, launchDir: work });
  assert.strictEqual(id.state, 'ok');
  assert.strictEqual(id.name, 'work');
  assert.strictEqual(id.branch, 'main');
});

test('packed refs, a deep subdirectory, and a detached HEAD all agree with git', { skip: !HAS_GIT }, (t) => {
  const root = tmp(t);
  const repo = repoWithCommit(path.join(root, 'packed'));
  git(repo, ['pack-refs', '--all']);
  const deep = path.join(repo, 'a', 'b', 'c', 'd');
  fs.mkdirSync(deep, { recursive: true });

  const fromDeep = readGitRepo({ currentDir: deep, launchDir: repo });
  assert.strictEqual(fromDeep.state, 'ok', 'packed refs must not read as unreadable');
  assert.strictEqual(fromDeep.name, 'packed');
  assert.strictEqual(fromDeep.branch, gitBranch(repo));
  assert.strictEqual(fromDeep.launchName, null, 'the same repo is not worth naming twice');

  git(repo, ['checkout', '-q', '--detach']);
  const det = readGitRepo({ currentDir: repo, launchDir: repo });
  assert.strictEqual(det.detached, true, 'a real detached checkout reads as detached');
  assert.strictEqual(det.branch, null);
});

test('a repository with no commits yet is a repository, on its unborn branch', { skip: !HAS_GIT }, (t) => {
  const dir = path.join(tmp(t), 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch=main', '.']);
  const id = readGitRepo({ currentDir: dir, launchDir: dir });
  assert.strictEqual(id.state, 'ok', 'an empty repo is not an unreadable one');
  assert.strictEqual(id.branch, 'main');
});

test('a sha-256 repository is read, not refused for its hash format', { skip: !HAS_GIT }, (t) => {
  const dir = path.join(tmp(t), 'sha256');
  fs.mkdirSync(dir, { recursive: true });
  try {
    git(dir, ['init', '-q', '--initial-branch=main', '--object-format=sha256', '.']);
  } catch {
    t.skip('this git has no sha256 support');
    return;
  }
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-qm', 'first']);
  git(dir, ['checkout', '-q', '--detach']);
  const id = readGitRepo({ currentDir: dir, launchDir: dir });
  assert.strictEqual(id.state, 'ok');
  assert.strictEqual(id.detached, true, 'a 64-hex HEAD is a detached HEAD, not garbage');
});

// ── The launch-repo leg ──────────────────────────────────────────────────────

test('before the first status tick the pane names the repo the tab was launched in', { skip: !HAS_GIT }, (t) => {
  // The state EVERY TAB STARTS IN: the launcher has written launch-cwd, and
  // Claude has not yet emitted a status line, so there is no session directory.
  // Reporting "not a git repository" here was a false claim about the world,
  // made while the file naming the repository sat unread in the same directory.
  const repo = repoWithCommit(path.join(tmp(t), 'ccr'));
  const id = readGitRepo({ currentDir: null, launchDir: repo });
  assert.strictEqual(id.state, 'ok', 'an unknown session directory is not evidence of no repository');
  assert.strictEqual(id.name, 'ccr');
  assert.strictEqual(id.branch, gitBranch(repo));
  assert.match(plain(renderGitPane({ identity: id }, { width: 48 })), /ccr/);
});

test('a session outside any repo still shows which repo the tab belongs to', { skip: !HAS_GIT }, (t) => {
  const root = tmp(t);
  const repo = repoWithCommit(path.join(root, 'ccr'));
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });

  const id = readGitRepo({ currentDir: scratch, launchDir: repo });
  assert.strictEqual(id.state, 'not-a-repo');
  assert.strictEqual(id.launchName, 'ccr', 'the launch repo survives a session that wandered off');
  const out = plain(renderGitPane({ identity: id }, { width: 48 }));
  assert.match(out, /launched in ccr/, `the tab keeps its identity: "${out}"`);
  assert.match(out, /not a git repository/, `and the session state is still stated: "${out}"`);
});

test('a repo whose HEAD cannot be read is still NAMED', (t) => {
  // Hand-built: the point is a located repo with an unreadable HEAD, which git
  // will not produce on request.
  const dir = path.join(tmp(t), 'broken-clone');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });   // no HEAD inside
  const id = readGitRepo({ currentDir: dir, launchDir: dir });
  assert.strictEqual(id.state, 'unreadable');
  assert.strictEqual(id.name, 'broken-clone', 'the model has the name');
  const out = plain(renderGitPane({ identity: id }, { width: 48 }));
  assert.match(out, /broken-clone/, `and the pane must print it: "${out}"`);
  assert.match(out, /git data unavailable/);
});

test('giving up on the walk degrades to unreadable, never to "not a repository"', (t) => {
  // A tree deeper than MAX_WALK is healthy; the reader simply stopped looking.
  // Claiming there is no repository up there is a false statement, and the one
  // the user would act on.
  const root = tmp(t);
  const deep = path.join(root, ...Array.from({ length: MAX_WALK + 6 }, (_, i) => `d${i}`));
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const loc = discoverRepo(deep);
  assert.strictEqual(loc.found, false);
  assert.strictEqual(loc.exhausted, true, 'the walk must report that it gave up');
  assert.strictEqual(readGitRepo({ currentDir: deep }).state, 'unreadable');
});

test('an overlong name is cut by code point and marked as cut', (t) => {
  // A UTF-16 slice at NAME_MAX can sever a surrogate pair and put a lone
  // surrogate on the terminal — the hazard clampVisible's header names.
  const root = tmp(t);
  const long = 'c'.repeat(NAME_MAX + 20) + '😀tail';
  const dir = path.join(root, long);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const id = readGitRepo({ currentDir: dir, launchDir: dir });
  const name = id.name || '';
  assert.ok(name.endsWith('…'), 'a shortened name says so');
  assert.ok([...name].length <= NAME_MAX, 'and stays inside the cap, counted by code point');
  assert.ok(!/[\uD800-\uDFFF]/.test(name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
    'no lone surrogate survives the cut');
});

// ── recordLaunchDir writes safely ────────────────────────────────────────────

test('recordLaunchDir refuses to write through a planted symlink', { skip: skipWithoutFileSymlinks() }, (t) => {
  const dir = tmp(t);
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'ORIGINAL\n');
  plantFileLink(victim, path.join(dir, 'launch-cwd'));

  recordLaunchDir(dir, '/home/me/anything');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n',
    'a symlink at launch-cwd must not become an arbitrary-file overwrite');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'launch-cwd'), 'utf8'), '/home/me/anything\n');
});

test('recordLaunchDir does not block on a planted fifo', { skip: process.platform === 'win32' && 'Windows has no mkfifo — NTFS cannot hold the fixture' }, (t) => {
  const dir = tmp(t);
  try {
    execFileSync('mkfifo', [path.join(dir, 'launch-cwd')], { stdio: 'ignore' });
  } catch {
    t.skip('no mkfifo here');
    return;
  }
  // Unguarded, this call never returns: opening a fifo for write blocks until a
  // reader appears, and all three launchers make it BEFORE Claude is spawned —
  // so `ccr` would hang with no output at all.
  const started = Date.now();
  recordLaunchDir(dir, '/home/me/repo');
  assert.ok(Date.now() - started < 2000, 'the write must not block the launcher');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'launch-cwd'), 'utf8'), '/home/me/repo\n');
});

test('every launcher records the launch directory', () => {
  const root = path.join(__dirname, '..');
  const sh = fs.readFileSync(path.join(root, 'scripts', 'launch.sh'), 'utf8');
  const shCode = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(shCode, /launch-cwd/, 'the tmux launcher records it');
  assert.match(shCode, /rm -f "\$STATE\/launch-cwd"/,
    'and clears the path first, so a fifo cannot hang the launcher here either');
  for (const f of ['launch-win.js', 'launch-vscode.js']) {
    const src = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.match(src, /d\.recordLaunchDir\(st\.stateDir, process\.cwd\(\)\)/, `${f} records it`);
  }
});

test('a bare repository is named as one, and git agrees it is bare', { skip: !HAS_GIT }, (t) => {
  const d = tmp(t);
  const bare = path.join(d, 'mirror.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);

  // The far side: git's own verdict on the same directory, not this file's.
  const isBare = execFileSync('git', ['-C', bare, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim();
  assert.strictEqual(isBare, 'true', 'fixture invalid: git does not consider this bare');

  const id = readGitRepo({ currentDir: bare, launchDir: bare });
  assert.strictEqual(id.state, 'ok', 'a bare repository IS a repository');
  assert.strictEqual(id.bare, true);
  assert.strictEqual(id.name, 'mirror.git');
  assert.match(plain(renderGitPane({ identity: id }, { width: 44 })), /bare repository/);
});

test('an ordinary clone is never mistaken for bare, at any depth', { skip: !HAS_GIT }, (t) => {
  const d = tmp(t);
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'commit', '-q', '--allow-empty', '-m', 'x'],
    { env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } });
  const deep = path.join(d, 'src', 'render');
  fs.mkdirSync(deep, { recursive: true });

  // The bare test runs at every step of the walk, and a clone's own `.git`
  // answers it — so a working tree must still resolve to the working tree.
  for (const from of [d, deep]) {
    const id = readGitRepo({ currentDir: from, launchDir: from });
    assert.strictEqual(id.bare, false, `${from} is a working tree, not a bare repo`);
    assert.strictEqual(id.root, fs.realpathSync(d));
  }
});

test('a session inside a clone\'s .git is named for the project, not ".git"', { skip: !HAS_GIT }, (t) => {
  const d = tmp(t);
  const proj = path.join(d, 'atlas');
  execFileSync('git', ['init', '-q', proj]);
  const id = readGitRepo({ currentDir: path.join(proj, '.git'), launchDir: path.join(proj, '.git') });
  // Real git treats this as "no work tree" too, so reporting it like a bare repo
  // matches git; naming it ".git" would answer nothing about which repo it is.
  assert.strictEqual(id.name, 'atlas');
  assert.strictEqual(id.bare, true);
});
