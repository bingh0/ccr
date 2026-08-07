// @ts-check
'use strict';
// Step definitions for features/git-pane-placement.feature.
//
// This feature's subject is WIRING, so every step drives the wiring rather than
// the parts it joins. Cycling goes through the real request file the host's key
// writes (src/cycle-view.js) and the real tick that consumes it (sidecar.frame),
// which is exactly the pair an adversarial review once found disconnected with
// the suite green — see the header of test/pane-integration.test.js. Instances
// come from the real slot allocator (src/instance-slot.js) and record their
// launch directory through the real launcher writer (src/state-dir.js), so "six
// instances" means six namespaces ccr itself chose, not six directories a test
// invented and then asserted were different.
//
// Two things about the WORLD are pinned, both because the scenarios say nothing
// about them and the developer's own machine otherwise would:
//
//   - the external-pane list, pinned empty through CCR_CONFIG, so a pane
//     configured in ~/.config/ccr/config.json cannot lengthen the cycle these
//     scenarios count presses against. It is pinned through the production
//     config reader rather than the `panes` option, so the reader stays in the
//     path being exercised.
//   - the pane width, pinned in the compose wrapper. `frame` normally takes it
//     from process.stdout, which is the terminal running the suite — a narrow
//     one would clamp the identity row and fail these scenarios for a reason
//     that has nothing to do with placement.
//
// Nothing else is stubbed: the view index, the request counter, the state dirs
// and the bytes on disk are all real.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame, frame, __resetViewState } = require('../../src/sidecar');
const { cycleView } = require('../../src/cycle-view');
const { allocateSlot } = require('../../src/instance-slot');
const { recordLaunchDir } = require('../../src/state-dir');
const { buildWorkRepo } = require('./_git-fixture');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The view index the git pane occupies (economy is 0). */
const GIT_VIEW = 1;

// Wide enough that no name in these scenarios is ever shortened, narrow enough
// to stay a realistic sidebar.
const COLS = 60;

// A cycle cannot be longer than the views that exist, and here that is two.
// The bound exists so "cycled until the economy panel returns" fails as a
// finite red rather than spinning when the cycle never comes back.
const MAX_PRESSES = 8;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitPanePlacementSteps(reg) {
  /**
   * The sandbox: a temp home for the slot allocator, an empty pane config, and
   * the module-level view state reset on both sides (it is process-global by
   * design — see `__resetViewState` in src/sidecar.js).
   */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (w.home) return w;
    w.home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-place-'));
    w.defer(() => fs.rmSync(w.home, { recursive: true, force: true }));

    const cfg = path.join(w.home, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ panes: [] }));
    const prevCfg = process.env.CCR_CONFIG;
    process.env.CCR_CONFIG = cfg;
    w.defer(() => {
      if (prevCfg == null) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prevCfg;
    });

    __resetViewState();
    w.defer(() => __resetViewState());
    w.instances = [];
    return w;
  };

  /**
   * A real working tree with a real `.git` directory, in git's own on-disk
   * format. Only HEAD and the loose ref it names are written, because identity
   * is all this feature reads — the shapes a reader must survive (detached,
   * worktree files, packed refs) belong to features/git-repo-identity.feature
   * and test/git-repo.test.js, which is where they are covered.
   */
  const makeRepo = (/** @type {string} */ dir, /** @type {string} */ branch) => {
    const git = path.join(dir, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
    // A branch name with a slash is a NESTED path under refs/heads, which is
    // what git itself writes for `topic/1` — hence the parent, not just the dir.
    const ref = path.join(git, 'refs', 'heads', branch);
    fs.mkdirSync(path.dirname(ref), { recursive: true });
    fs.writeFileSync(ref, '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d\n');
    return dir;
  };

  /**
   * The snapshot `ccr statusline` leaves behind: where the session is working,
   * plus enough rate-limit and context data for the economy panel to draw its
   * meters — without them "the meters it showed before" would compare two empty
   * lists and pass on any pane at all.
   *
   * Reset instants are relative to now because a fixed epoch drifts into the
   * past and stops producing a countdown.
   */
  const writeStatus = (/** @type {string} */ stateDir, /** @type {string} */ dir) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: nowSec + 3 * 3600 },
        seven_day: { used_percentage: 18, resets_at: nowSec + 4 * 86400 },
      },
      context_window: { context_window_size: 1000000, total_input_tokens: 120000 },
      cost: { total_cost_usd: 3.25, total_duration_ms: 45 * 60 * 1000 },
    }));
  };

  /**
   * One running instance: a namespace ccr's own allocator chose, a repository,
   * and the two files a live instance has on disk. `env: {}` states that this is
   * a BARE launch — allocateSlot returns null when CCR_SESSION or CCR_STATE_DIR
   * is set, and the suite may well be running inside a ccr instance itself.
   */
  const newInstance = (/** @type {Record<string, any>} */ w, /** @type {string} */ name, /** @type {string} */ branch) => {
    const slot = allocateSlot({ env: {}, home: world(w).home });
    assert.ok(slot && !('exhausted' in slot), `ccr found no free slot for the instance in "${name}"`);
    const repo = makeRepo(path.join(w.home, 'trees', name), branch);
    recordLaunchDir(slot.stateDir, repo);
    writeStatus(slot.stateDir, repo);
    const inst = { name, branch, repo, stateDir: slot.stateDir, slot: slot.slot };
    w.instances.push(inst);
    return inst;
  };

  /** Lines carrying a meter bar — the economy panel's 5h, weekly and ctx rows. */
  const meterLines = (/** @type {string} */ p) => p.split('\n').filter((l) => /[▓░]/.test(l));

  /**
   * A meter row with its two CLOCK fields neutralised: time-to-exhaust and the
   * reset countdown both derive from `Date.now()`, so two frames a few
   * milliseconds apart can legitimately differ by a minute across a boundary.
   * Everything else in the row — the dot, the label, the bar, the percentage,
   * the context totals — comes from the snapshot and must be identical.
   */
  const meters = (/** @type {string} */ p) => meterLines(p)
    .map((l) => l.replace(/~\S+/g, '~…').replace(/resets\s+\S+/g, 'resets …').trimEnd());

  /**
   * Which view is on screen, identified POSITIVELY on both sides. A classifier
   * that returned "git" for anything that was not the economy panel would call
   * an error line, a blank frame or a stale pane a success.
   */
  const viewOf = (/** @type {Record<string, any>} */ w, /** @type {string} */ p) => {
    const first = (p.split('\n')[0] || '');
    if (/^economy\b/.test(first.trim()) && meterLines(p).length > 0) return 'economy';
    const id = /^\s{2}(\S(?:.*\S)?)\s{2,}(\S(?:.*\S)?)\s*$/.exec(first);
    if (id && id[1] === w.sidebar.name && id[2] === w.sidebar.branch) return 'git';
    return 'other';
  };

  /**
   * One sidecar tick, through the production path: `frame` reads the request
   * counter, advances its own view index, and hands it to composeFrame. The
   * wrapper exists to pin the width and to record the index that actually
   * reached the frame, so a tick that painted the right thing for the wrong
   * reason is still visible in the failure message.
   */
  const tick = (/** @type {Record<string, any>} */ w) => {
    let painted = '';
    frame({
      stateDir: w.sidebar.stateDir,
      compose: (/** @type {string} */ dir, /** @type {any} */ opts) => {
        w.viewIndex = opts.view;
        return composeFrame(dir, { ...opts, cols: COLS });
      },
      paint: (/** @type {string} */ s) => { painted = s; },
    });
    w.frame = painted;
    w.plain = plain(painted);
    return w.plain;
  };

  /** A keypress, then the tick that consumes it. */
  const press = (/** @type {Record<string, any>} */ w) => {
    const res = cycleView(w.sidebar.stateDir);
    assert.ok(res.ok, `the cycle key could not record a request: ${res.reason}`);
    w.presses = (w.presses || 0) + 1;
    return tick(w);
  };

  // ── Given: what is on screen ──────────────────────────────────────────────

  reg.define(/^the sidebar is showing the economy panel$/, (w) => {
    w.sidebar = newInstance(world(w), 'atlas', 'main');
    // A Given that merely assumed its own premise would make the When below
    // meaningless: if the sidebar opened on something else, "cycled once" would
    // be measuring from an unknown place.
    assert.strictEqual(viewOf(w, tick(w)), 'economy',
      `the sidebar should open on the economy panel; got:\n${w.plain}`);
    w.economyBefore = meters(w.plain);
    assert.ok(w.economyBefore.length > 0,
      `the economy panel drew no meters, so "the meters it showed before" would compare nothing:\n${w.plain}`);
  });

  reg.define(/^the sidebar is showing the git pane$/, (w) => {
    w.sidebar = newInstance(world(w), 'atlas', 'main');
    // Reached by cycling rather than by setting an index, because the return
    // trip this scenario tests only means something if the outward one was real.
    // The economy panel is recorded on the way past: it is the "before" the last
    // Then compares against, and it is only observable from here.
    assert.strictEqual(viewOf(w, tick(w)), 'economy',
      `the sidebar should open on the economy panel; got:\n${w.plain}`);
    w.economyBefore = meters(w.plain);
    assert.ok(w.economyBefore.length > 0, 'the economy panel drew no meters to remember');
    for (let i = 0; i < MAX_PRESSES && viewOf(w, w.plain) !== 'git'; i += 1) press(w);
    assert.strictEqual(viewOf(w, w.plain), 'git',
      `the git pane never appeared in ${MAX_PRESSES} presses; last frame:\n${w.plain}`);
    w.presses = 0;
  });

  reg.define(/^six ccr instances are running in six different repos$/, (w) => {
    world(w);
    for (let n = 1; n <= 6; n += 1) newInstance(w, `repo-${n}`, `topic/${n}`);
    // The premise, checked rather than assumed. Six instances that shared a
    // state dir would make every assertion below pass or fail for a reason with
    // nothing to do with the pane — and a slot allocator that handed out one
    // namespace six times is precisely the bug slots exist to prevent.
    //
    // Resolved through the FILESYSTEM rather than compared as the strings the
    // allocator returned: six distinct names that resolve to one directory are
    // one namespace wearing six labels, and the allocator's own return value
    // cannot be the evidence for the allocator's own claim.
    const dirs = new Set(w.instances.map((/** @type {any} */ i) => fs.realpathSync(i.stateDir)));
    assert.strictEqual(dirs.size, 6,
      `ccr assigned ${dirs.size} distinct directories to six bare launches: ${[...dirs].join(', ')}`);
    for (const inst of w.instances) {
      assert.strictEqual(
        fs.readFileSync(path.join(inst.stateDir, 'launch-cwd'), 'utf8').trim(), inst.repo,
        `instance ${inst.slot}'s launch directory is not its own repository`);
    }
  });

  reg.define(/^two ccr instances are running in the repos "([^"]+)" and "([^"]+)"$/, (w, a, b) => {
    world(w);
    for (const name of [a, b]) {
      const slot = allocateSlot({ env: {}, home: w.home });
      assert.ok(slot && !('exhausted' in slot), `ccr found no free slot for the instance in "${name}"`);
      // A repository with a readable object store, not just a HEAD: this
      // scenario counts CHANGES, and a change count only exists where the
      // index and HEAD tree can actually be compared.
      const repo = buildWorkRepo(path.join(w.home, 'trees', name), {
        committed: { 'README.md': `# ${name}\n` },
      });
      recordLaunchDir(slot.stateDir, repo);
      writeStatus(slot.stateDir, repo);
      w.instances.push({ name, repo, stateDir: slot.stateDir, slot: slot.slot });
    }
  });

  /** The named instance's pane, rendered fresh through the production call. */
  const paneOf = (/** @type {Record<string, any>} */ w, /** @type {string} */ name) => {
    const inst = w.instances.find((/** @type {any} */ i) => i.name === name);
    assert.ok(inst, `no instance is running in "${name}"`);
    return { inst, plain: plain(composeFrame(inst.stateDir, { now: Date.now(), view: GIT_VIEW, cols: COLS, rows: 40 })) };
  };

  reg.define(/^the pane for "([^"]+)" shows (\d+) changes$/, (w, name, n) => {
    const inst = w.instances.find((/** @type {any} */ i) => i.name === name);
    assert.ok(inst, `no instance is running in "${name}"`);
    // First use is the Given: seed exactly n untracked files, then verify the
    // pane really shows them — a precondition checked, not assumed. Later uses
    // are the Then, where seeding again would beg the question.
    if (!inst.seeded) {
      for (let i = 1; i <= Number(n); i += 1) {
        fs.writeFileSync(path.join(inst.repo, `note-${i}.txt`), `note ${i}\n`);
      }
      inst.seeded = true;
    }
    const p = paneOf(w, name).plain;
    const line = p.split('\n').map((/** @type {string} */ l) => l.trim()).find((/** @type {string} */ l) => /^\d+\+? changes?$/.test(l));
    assert.strictEqual(line, `${n} changes`,
      `the pane for "${name}" should count ${n} changes; its counts row reads ${JSON.stringify(line)}:\n${p}`);
  });

  reg.define(/^(\d+) files are modified in "([^"]+)"$/, (w, n, name) => {
    const inst = w.instances.find((/** @type {any} */ i) => i.name === name);
    assert.ok(inst, `no instance is running in "${name}"`);
    for (let i = 1; i <= Number(n); i += 1) {
      fs.writeFileSync(path.join(inst.repo, `churn-${i}.txt`), `churn ${i}\n`);
    }
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the view is cycled once$/, (w) => { press(w); });

  reg.define(/^the view is cycled until the economy panel returns$/, (w) => {
    for (let i = 0; i < MAX_PRESSES && viewOf(w, w.plain) !== 'economy'; i += 1) press(w);
    assert.ok(w.presses > 0,
      'the economy panel was already showing, so nothing was cycled back to');
  });

  reg.define(/^each instance's git pane renders$/, (w) => {
    // No `panes` option and no `view` arithmetic: each instance renders its own
    // state dir through the same call the draw loop makes, with the external
    // pane list coming from the pinned config.
    for (const inst of w.instances) {
      inst.plain = plain(composeFrame(inst.stateDir, { now: Date.now(), view: GIT_VIEW, cols: COLS }));
    }
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the sidebar shows the git pane$/, (w) => {
    assert.strictEqual(viewOf(w, w.plain), 'git',
      `expected the git pane naming "${w.sidebar.name}" on "${w.sidebar.branch}" `
      + `after ${w.presses} press(es) (view index ${w.viewIndex}); got:\n${w.plain}`);
  });

  reg.define(/^the sidebar shows the economy panel$/, (w) => {
    assert.strictEqual(viewOf(w, w.plain), 'economy',
      `expected the economy panel after ${w.presses} press(es) (view index ${w.viewIndex}); got:\n${w.plain}`);
  });

  reg.define(/^the economy panel shows the meters it showed before$/, (w) => {
    assert.deepStrictEqual(meters(w.plain), w.economyBefore,
      'the economy panel came back changed — the git pane is an EXTRA view, '
      + 'so a round trip through it must cost the panel nothing');
  });

  reg.define(/^each pane names the repo of its own instance$/, (w) => {
    for (const inst of w.instances) {
      const first = (inst.plain.split('\n')[0] || '');
      const id = /^\s{2}(\S(?:.*\S)?)\s{2,}(\S(?:.*\S)?)\s*$/.exec(first);
      assert.ok(id, `instance ${inst.slot}'s pane has no identity row:\n${inst.plain}`);
      assert.strictEqual(id[1], inst.name, `instance ${inst.slot} names the wrong repo: "${first}"`);
      assert.strictEqual(id[2], inst.branch, `instance ${inst.slot} names the wrong branch: "${first}"`);
      // And nobody else's. Naming your own repo is satisfiable by a pane that
      // names every repo it can find; the promise is that six tabs answer for
      // six repos, which means the other five must be absent.
      for (const other of w.instances) {
        if (other === inst) continue;
        assert.ok(!inst.plain.includes(other.name),
          `instance ${inst.slot}'s pane mentions "${other.name}", which belongs to instance ${other.slot}:\n${inst.plain}`);
      }
    }
  });
};
