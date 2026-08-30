// @ts-check
'use strict';
// Step definitions for features/git-repo-identity.feature.
//
// These drive the REAL path end to end: a real `.git` directory on disk, a real
// state directory holding the real `last-status.json` and `launch-cwd` files the
// launcher and the status line write, rendered through `composeFrame` — the
// same function the sidecar's draw loop calls. Nothing about the git pane is
// stubbed.
//
// That is deliberate and it is the lesson of this repository's own worst
// binding: features/pane-blobs.feature once "proved" row overflow through a
// step that called `renderPane` directly, and the collapse it asserted was
// unreachable in production because the only real caller never passed a row
// budget. A step that renders one level below the product proves the renderer,
// not the pane. So the only knobs used here are the ones the product itself
// has: the view index, the column count, and the bytes on disk.
//
// Repositories are built by hand rather than by running `git init`, for two
// reasons: the suite must pass on a machine with no git installed, and a
// hand-built fixture states exactly which bytes the reader is being held to.
// The far-side check — that these fixtures are what real git actually writes —
// is a separate concern and does not belong inside the product's own scenarios.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame } = require('../../src/sidecar');
const { visibleWidth } = require('../../src/render/shared');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The view index the git pane occupies (economy is 0). */
const GIT_VIEW = 1;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitRepoIdentitySteps(reg) {
  const tmp = (/** @type {Record<string, any>} */ w) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-git-'));
    w.defer(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };

  /** Lazily create the sandbox: a scratch root plus the sidecar's state dir. */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (!w.root) {
      w.root = tmp(w);
      w.stateDir = path.join(w.root, 'state');
      fs.mkdirSync(w.stateDir, { recursive: true });
    }
    return w;
  };

  /**
   * A directory named in a scenario, mapped inside the sandbox. An absolute
   * path in the feature text ("/home/me/scratch") is a name, not an instruction
   * to touch the real filesystem there.
   */
  const at = (/** @type {Record<string, any>} */ w, /** @type {string} */ name) =>
    path.join(world(w).root, 'tree', name.replace(/^[/\\]+/, ''));

  /**
   * Build a real working tree with a real `.git` directory.
   *
   * Only the files the identity reader actually consults are written, and they
   * are written in git's own on-disk format: `HEAD` holding either a symbolic
   * ref or a raw object id, and the loose ref it names.
   */
  const makeRepo = (/** @type {string} */ dir, /** @type {{ branch?: string|null, head?: string }} */ o = {}) => {
    const git = path.join(dir, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
    const oid = o.head || '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d';
    if (o.branch === null) {
      // Detached: HEAD names a commit directly, exactly as `git checkout <sha>`
      // leaves it.
      fs.writeFileSync(path.join(git, 'HEAD'), oid + '\n');
    } else {
      const branch = o.branch || 'main';
      fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
      const refPath = path.join(git, 'refs', 'heads', branch);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, oid + '\n');
    }
    return dir;
  };

  /** Point the SESSION at a directory, the way the status line reports it. */
  const setSessionDir = (/** @type {Record<string, any>} */ w, /** @type {string} */ dir) => {
    w.sessionDir = dir;
    fs.writeFileSync(path.join(world(w).stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
      rate_limits: {},
    }));
  };

  /** Point the LAUNCH directory at a directory, the way the launcher records it. */
  const setLaunchDir = (/** @type {Record<string, any>} */ w, /** @type {string} */ dir) => {
    w.launchDir = dir;
    fs.writeFileSync(path.join(world(w).stateDir, 'launch-cwd'), dir + '\n');
  };

  /**
   * The pane, split into the parts the scenarios talk about.
   *
   * Row 0 is the identity line, `<current repo>   <branch>`, with an optional
   * trailing cycle position. The launch repo is PINNED ON ITS OWN ROW below it —
   * the shape the chosen option specifies ("always keeps the launch repo visible
   * as a second line") and the reason a long branch name can never crowd it out.
   *
   * Parsing the rows means an assertion can name the part it cares about — "the
   * branch is main" — instead of asking whether the word appears somewhere in
   * the frame, which a pane showing it in the wrong place would also satisfy.
   */
  const identity = (/** @type {Record<string, any>} */ w) => {
    const line = w.lines[0] || '';
    const body = line.replace(/\s+\d+\/\d+\s*$/, '').trim();
    const cols = body.split(/\s{2,}/);
    const launchRow = (w.lines.slice(1) || [])
      .map((/** @type {string} */ l) => /^\s*launched in (.+?)\s*$/.exec(l))
      .find(Boolean);
    return {
      line,
      body,
      launch: launchRow ? launchRow[1].trim() : null,
      current: (cols[0] || '').trim(),
      branch: cols.length > 1 ? (cols[cols.length - 1] || '').trim() : '',
    };
  };

  // ── Given: the world on disk ──────────────────────────────────────────────

  reg.define(/^the pane is (\d+) columns wide$/, (w, n) => { world(w).cols = Number(n); });

  reg.define(/^ccr was launched in the repo "([^"]+)" on branch "([^"]+)"$/, (w, repo, branch) => {
    const dir = makeRepo(at(w, String(repo)), { branch: String(branch) });
    setLaunchDir(w, dir);
    // Until a scenario says the session moved, it is working where ccr started.
    setSessionDir(w, dir);
  });

  reg.define(/^ccr was launched in the repo "([^"]+)"$/, (w, repo) => {
    const dir = makeRepo(at(w, String(repo)));
    setLaunchDir(w, dir);
    setSessionDir(w, dir);
  });

  reg.define(/^ccr was launched in the bare repo "([^"]+)"$/, (w, repo) => {
    // `git init --bare` writes the repository's own files at the TOP of the
    // directory — no `.git` beneath it, which is exactly why the walk used to
    // pass straight over one. Built by hand like every other fixture here;
    // test/git-repo.test.js checks this layout against what real git produces.
    const dir = at(w, String(repo));
    fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, 'refs', 'heads', 'main'),
      '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d\n');
    setLaunchDir(w, dir);
    setSessionDir(w, dir);
  });

  reg.define(/^ccr was launched in the directory "([^"]+)"$/, (w, dir) => {
    const d = at(w, String(dir));
    fs.mkdirSync(d, { recursive: true });
    setLaunchDir(w, d);
    setSessionDir(w, d);
  });

  reg.define(/^the session is editing files in the repo "([^"]+)"$/, (w, repo) => {
    setSessionDir(w, makeRepo(at(w, String(repo))));
  });

  reg.define(/^the repo has no branch checked out$/, (w) => {
    // Re-lay the launch repo as a detached checkout. `git checkout <sha>`
    // rewrites HEAD in place and leaves the branch refs alone, so does this.
    makeRepo(w.launchDir, { branch: null });
  });

  reg.define(/^no git repository contains that directory$/, (w) => {
    // A precondition, and it is checked rather than assumed: if the sandbox
    // happened to sit inside somebody's checkout, every assertion below would
    // pass or fail for a reason that has nothing to do with the pane. "The
    // fixture is the hole" is a failure this project has already met once.
    for (let d = w.launchDir; ; d = path.dirname(d)) {
      assert.ok(!fs.existsSync(path.join(d, '.git')),
        `fixture invalid: ${d} is inside a git repository, so "not a repository" cannot be tested here`);
      if (path.dirname(d) === d) break;
    }
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the git pane renders$/, (w) => {
    // `panes: []` pins the external-pane list to empty so the developer's own
    // ~/.config/ccr/config.json cannot change what this scenario renders.
    w.frame = composeFrame(world(w).stateDir, {
      now: Date.now(), view: GIT_VIEW, cols: w.cols || 48, panes: [],
    });
    w.plain = plain(w.frame);
    w.lines = w.plain.split('\n').filter((/** @type {string} */ l, /** @type {number} */ i, /** @type {string[]} */ a) => !(i === a.length - 1 && l === ''));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the pane shows the current repo as "([^"]+)"$/, (w, repo) => {
    assert.strictEqual(identity(w).current, repo,
      `the current repo segment of "${identity(w).body}" should be ${repo}`);
  });

  reg.define(/^the pane shows the launch repo as "([^"]+)"$/, (w, repo) => {
    assert.strictEqual(identity(w).launch, repo,
      `the launch repo segment of "${identity(w).body}" should be ${repo}`);
  });

  reg.define(/^the pane shows the branch as "([^"]+)"$/, (w, branch) => {
    assert.strictEqual(identity(w).branch, branch,
      `the branch segment of "${identity(w).body}" should be ${branch}`);
  });

  reg.define(/^the pane shows "bare repository" where a branch name would be$/, (w) => {
    assert.strictEqual(identity(w).branch, 'bare repository',
      `the branch segment of "${identity(w).body}" should say it is bare`);
  });

  reg.define(/^the pane shows "detached" where a branch name would be$/, (w) => {
    assert.strictEqual(identity(w).branch, 'detached',
      `the branch segment of "${identity(w).body}" should read detached`);
  });

  reg.define(/^the pane shows "not a git repository"$/, (w) => {
    assert.match(w.plain, /not a git repository/);
  });

  reg.define(/^the pane shows no branch name$/, (w) => {
    // Stronger than "the word main is absent": the identity row must consist of
    // the refusal and nothing else, so no branch, ref or object id can be
    // sitting beside it.
    assert.match(identity(w).body, /^not a git repository$/,
      `the identity row should carry only the refusal, got "${identity(w).body}"`);
  });

  reg.define(/^the identity line occupies exactly 1 row$/, (w) => {
    // "Exactly 1 row" is a claim about the identity line, not the pane: since
    // the working-tree section landed, rows exist BELOW it. A wrapped identity
    // would spill its tail onto row 1 — so row 1, when present, must be one of
    // the two shapes that legally follow the identity row: the pinned launch
    // row, or the blank line that opens the body sections.
    const next = w.lines[1];
    assert.ok(next === undefined || next === '' || /^\s*launched in /.test(next),
      `the identity line must not wrap; row 1 holds ${JSON.stringify(next)} `
      + `(rows: ${JSON.stringify(w.lines)})`);
  });

  reg.define(/^the identity line is at most (\d+) columns wide$/, (w, n) => {
    const width = visibleWidth(w.lines[0] || '');
    assert.ok(width <= Number(n),
      `the identity line is ${width} columns wide, over the ${n}-column pane: "${w.lines[0]}"`);
  });

  reg.define(/^the identity line contains "([^"]+)"$/, (w, text) => {
    assert.ok((w.lines[0] || '').includes(text),
      `"${text}" is missing from the identity line "${w.lines[0]}"`);
  });
};
