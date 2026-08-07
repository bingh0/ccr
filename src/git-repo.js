// @ts-check
'use strict';
// src/git-repo.js — read a repository's IDENTITY out of .git, without git.
//
// THE BUILD FORK, RULED HERE. features/OUT-OF-SCOPE.md deferred two related
// questions to the build: "built-in .git reader vs. an external producer
// writing a pane blob", and "whether a `git` binary is ever invoked". Both are
// answered by a scenario the visionary already ratified —
// features/git-pane-safety.feature: "the pane holds no capability to run a
// command". That is not a preference the build gets to weigh; it is the
// contract, and test/sidecar-capabilities.test.js enforces it structurally by
// walking the sidecar's module graph against an allowlist of node:fs, node:path
// and node:os. A subprocess is therefore out, which settles the second question
// and decides the first: ccr reads .git itself.
//
// The producer alternative was the real other option, not a straw man — it
// reuses docs/PANE-CONTRACT.md and its hostile-renderer threat model, and costs
// no parsing at all. It loses on the reported problem: six tabs and nothing
// saying which repo each one is in, for a user who installed ccr and nothing
// else. A pane that only appears once a second tool is installed does not
// answer that. (The blob path is not wasted — it stays open for any producer,
// which is what the contract is for.)
//
// WHAT THIS COSTS, stated plainly so the next reader isn't surprised: identity
// is cheap (HEAD is one small text file), but the later sections are not.
// Working-tree status needs .git/index parsed, and history needs object reading
// including packfiles. That is design-tier work — features/design/ — and it is
// the price of the ratified safety property.
//
// EVERY READ HERE IS HOSTILE-INPUT SAFE, for the same reasons src/safe-read.js
// exists: a .git directory is on disk, anything running as the user can write
// it, and this code runs inside a synchronous 1 Hz draw loop. A fifo at
// .git/HEAD would freeze the sidebar forever. So reads go through
// readTextCapped (regular files only, size-capped, never blocking) and text
// that reaches a renderer is stripped of control bytes at THIS boundary — the
// renderer does no sanitizing of its own, the same choke-point split
// src/pane-blob.js and src/render/pane.js already use.

const fs = require('node:fs');
const path = require('node:path');
const { readTextCapped } = require('./safe-read');
const { stripControl } = require('./sanitize');

// A path deep enough to need more than this is pathological, and an unbounded
// walk is a denial-of-display path: path.dirname eventually fixpoints at the
// root, but a crafted path with enough segments would spend the draw budget
// stat-ing on the way there.
const MAX_WALK = 64;

// HEAD is one line; a .git file is one line. Anything larger at those paths is
// not the thing we came for, and the cap is what makes a planted file cheap.
const SMALL_FILE_MAX = 4096;

// Display cap applied at the read boundary. A branch name has no length limit
// worth relying on, and layout wants a value it can budget around rather than a
// megabyte it must clamp later.
const NAME_MAX = 128;

/**
 * Where the walk ended. `found` distinguishes the three outcomes that must not
 * be collapsed: a repository was located; the walk reached the filesystem root
 * without finding one; or it gave up at MAX_WALK, which is NOT evidence of
 * absence and must never be reported as "not a git repository" — that would be
 * a false statement about a perfectly healthy tree.
 *
 * @typedef {{ found: true, root: string, gitDir: string|null, bare?: boolean }
 *   | { found: false, exhausted: boolean }} RepoLocation
 *
 * `gitDir` is null when a `.git` FILE was found but did not name a readable git
 * directory. Present-but-unreachable is not the same as absent, and the pane
 * says different things about them.
 *
 * `bare` marks a repository that IS the directory rather than sitting in a
 * `.git` beneath one.
 */

/**
 * Does this directory look like a git directory in its own right? This is git's
 * own structural test (`is_git_directory`): HEAD, plus `objects` and `refs`.
 *
 * It is what finds a BARE repository — `git init --bare` produces no `.git` at
 * all, so the walk above would pass straight over one and report "not a git
 * repository" at a directory that is unambiguously a repository. It also
 * catches a session sitting inside a `.git` directory, which real git treats
 * the same way.
 *
 * Not a config read: `core.bare` is the declarative answer, but parsing config
 * to decide whether a path is a repository at all inverts the order — you would
 * have to already know it was one to trust the file.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeGitDir(dir) {
  try {
    if (!fs.statSync(path.join(dir, 'HEAD')).isFile()) return false;
    return fs.statSync(path.join(dir, 'objects')).isDirectory()
      && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} RepoIdentity
 * @property {'ok'|'not-a-repo'|'unreadable'} state
 * @property {string|null} name        Current repo, by working-tree directory name.
 * @property {string|null} branch      Checked-out branch, or null when detached.
 * @property {boolean} detached        HEAD names a commit rather than a branch.
 * @property {boolean} bare            The repository has no working tree.
 * @property {string|null} root        Working-tree root of the current repo.
 * @property {string|null} launchName  The repo ccr was launched in — set ONLY when
 *   it differs from the current one, because a tab that says the same name twice
 *   has told you nothing.
 */

/**
 * Walk up from `startDir` looking for a `.git` entry, reporting whether one was
 * found, and — when not — whether the walk actually reached the filesystem root
 * or merely ran out of budget.
 *
 * `.git` is a DIRECTORY in an ordinary clone and a FILE in a linked worktree or
 * a submodule, where it holds `gitdir: <path>`. Both are real repositories and
 * the pane must name both; only the second needs a second hop.
 *
 * `statSync` follows symlinks deliberately, which readTextCapped does not: a
 * symlinked `.git` is a legitimate layout, and following it costs nothing here
 * because nothing downstream writes. The files we then READ are still held to
 * the regular-file rule — a symlinked HEAD degrades to "unreadable" rather than
 * being followed, which is the conservative half of the same trade.
 *
 * @param {string} startDir
 * @returns {RepoLocation}
 */
function discoverRepo(startDir) {
  let dir;
  try {
    if (typeof startDir !== 'string' || !startDir) return { found: false, exhausted: false };
    dir = path.resolve(startDir);
  } catch { return { found: false, exhausted: false }; }

  for (let i = 0; i < MAX_WALK; i += 1) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { st = null; }
    if (st && st.isDirectory()) return { found: true, root: dir, gitDir: dotgit };
    if (st && st.isFile()) {
      const raw = readTextCapped(dotgit, SMALL_FILE_MAX);
      const m = raw && /^gitdir:[ \t]*(.+)$/m.exec(raw);
      // A `.git` file that exists is a repository marker whichever way its
      // contents read, so an unparseable one reports the repo as unreachable
      // rather than absent.
      return { found: true, root: dir, gitDir: m ? path.resolve(dir, m[1].trim()) : null };
    }
    // No `.git` here — but this directory may BE the repository. Checked after
    // the `.git` cases, never before: an ordinary clone has both a `.git` and,
    // one level down, something that answers this test, and the working tree is
    // the answer the pane wants.
    if (looksLikeGitDir(dir)) return { found: true, root: dir, gitDir: dir, bare: true };
    const parent = path.dirname(dir);
    if (parent === dir) return { found: false, exhausted: false };
    dir = parent;
  }
  // Ran out of walk before running out of path. Says nothing about whether a
  // repository is up there, so the caller must not claim there isn't one.
  return { found: false, exhausted: true };
}

/**
 * Read `.git/HEAD`. Returns null when it cannot be read or does not look like
 * HEAD at all — the caller reports that as unreadable, never as a branch.
 *
 * Two shapes are valid: `ref: refs/heads/<name>` on a branch, and a bare object
 * id when HEAD is detached. Both sha-1 (40 hex) and sha-256 (64 hex) ids are
 * accepted; a repository in the newer hash format is still a repository, and
 * refusing it would print "git data unavailable" at a perfectly healthy tree.
 *
 * @param {string|null} gitDir
 * @returns {{ branch: string|null, detached: boolean }|null}
 */
function readHead(gitDir) {
  if (!gitDir) return null;
  const raw = readTextCapped(path.join(gitDir, 'HEAD'), SMALL_FILE_MAX);
  if (raw == null) return null;
  const line = raw.split('\n')[0].trim();
  const ref = /^ref:[ \t]*(.+)$/.exec(line);
  if (ref) {
    const full = ref[1].trim();
    if (!full) return null;
    const short = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full;
    const name = display(short);
    // A ref line whose name is entirely control bytes leaves nothing to print;
    // "unreadable" is honest, an empty branch slot would not be.
    return name ? { branch: name, detached: false } : null;
  }
  if (/^[0-9a-f]{40}$/i.test(line) || /^[0-9a-f]{64}$/i.test(line)) {
    return { branch: null, detached: true };
  }
  return null;
}

/**
 * Strip control bytes and cap length — the one place repository-authored text
 * becomes display text. Everything downstream may assume it is printable.
 * @param {string} s
 * @returns {string}
 */
function display(s) {
  const clean = stripControl(String(s)).trim();
  // By CODE POINT, not by UTF-16 unit. A plain .slice() at 128 can land in the
  // middle of a surrogate pair and put a lone surrogate on the terminal — the
  // exact hazard clampVisible's header documents. And a value cut without a
  // mark reads as a complete one, which is the rule ellipsize exists to keep.
  const cps = [...clean];
  return cps.length <= NAME_MAX ? clean : cps.slice(0, NAME_MAX - 1).join('') + '…';
}

/**
 * The pane's identity model: which repo the session is in, which branch, and
 * (only when they differ) which repo the tab was launched in.
 *
 * WHY TWO DIRECTORIES. The launch repo is the tab's stable identity — it is
 * what the terminal tab has been called all session. The current repo follows
 * the session, because a session can `cd` somewhere else, and a pane that
 * quietly keeps describing the old place is worse than one that admits the
 * move. So both are read, and the launch name is shown only when it has
 * something to add.
 *
 * THE LAUNCH REPO IS RESOLVED FIRST, AND SURVIVES EVERY OUTCOME. An earlier
 * version returned "not a git repository" before it ever looked at the launch
 * directory, which made the pane state a falsehood in the state EVERY TAB
 * STARTS IN: between `ccr` launching and Claude's first status tick there is no
 * session directory at all, so the pane announced that this was not a
 * repository while the file naming the repository sat unread beside it. The tab
 * always has an answer even when the session does not yet.
 *
 * Hence two rules here: an unknown session directory falls back to the launch
 * directory (the tab is sitting in it), and a session that really is outside
 * any repository still shows which repo the tab belongs to.
 *
 * @param {{ currentDir?: string|null, launchDir?: string|null }} dirs
 * @returns {RepoIdentity}
 */
function readGitRepo(dirs) {
  const launchDir = dirs && dirs.launchDir ? dirs.launchDir : null;
  /** @type {RepoLocation} */
  const launch = launchDir ? discoverRepo(launchDir) : { found: false, exhausted: false };

  /** The launch repo's name, but only when it adds something to the current one. */
  const launchNameFor = (/** @type {string|null} */ currentRoot) => {
    if (!launch.found || launch.root === currentRoot) return null;
    return display(path.basename(launch.root)) || null;
  };

  // No session directory yet → the tab is still where it was launched.
  const currentDir = (dirs && dirs.currentDir) || launchDir;
  /** @type {RepoLocation} */
  const current = currentDir ? discoverRepo(currentDir) : { found: false, exhausted: false };

  if (!current.found) {
    // Giving up at MAX_WALK is not evidence of absence: a deep-but-healthy tree
    // must degrade to "cannot read" rather than be declared repository-free.
    return {
      state: current.exhausted ? 'unreadable' : 'not-a-repo',
      name: null, branch: null, detached: false, bare: false, root: null,
      launchName: launchNameFor(null),
    };
  }

  const bare = current.bare === true;
  // A bare repo is conventionally `<project>.git`, and a session sitting inside
  // an ordinary clone's `.git` would otherwise be named ".git" — neither of
  // which answers "which repo is this tab". The directory holding it does.
  const named = bare && path.basename(current.root) === '.git'
    ? path.dirname(current.root) : current.root;
  const name = display(path.basename(named)) || null;
  const head = readHead(current.gitDir);
  if (!head) {
    // The repo is located; only its HEAD is unreadable. Naming it is the pane's
    // entire job, and the model has the answer — an earlier version computed the
    // name here and threw it away.
    return {
      state: 'unreadable', name, branch: null, detached: false, bare,
      root: current.root, launchName: launchNameFor(current.root),
    };
  }

  return {
    state: 'ok', name, branch: head.branch, detached: head.detached, bare,
    root: current.root, launchName: launchNameFor(current.root),
  };
}

module.exports = { readGitRepo, discoverRepo, readHead, MAX_WALK, NAME_MAX };
