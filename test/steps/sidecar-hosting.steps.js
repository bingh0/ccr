// @ts-check
'use strict';
// Step definitions for features/sidecar-hosting.feature — drives the pure-Node
// sidecar (composeFrame / updateFeed) against a real temp state dir, pinning the
// waiting → live → ended states and the incremental tool/skills feed.

const assert = require('node:assert');
const { refuteWithControl } = require('./_absence');
const fs = require('node:fs');
const path = require('node:path');
const { freshDir, SAMPLE, tmpFile, toolLine, append } = require('./_win-helpers');
const { composeFrame, updateFeed } = require('../../src/sidecar');
const { cycleView, readViewRequests } = require('../../src/cycle-view');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineSidecarHostingSteps(reg) {
  /** create a state dir cleaned up when the scenario ends, pass or fail */
  const stateDir = (/** @type {Record<string, any>} */ w) => {
    w.dir = freshDir();
    w.defer(() => fs.rmSync(w.dir, { recursive: true, force: true }));
    return w.dir;
  };

  // Waiting
  reg.define(/^the split window has just opened$/, (w) => { stateDir(w); });
  reg.define(/^Claude has not yet produced a status tick$/, () => {});
  reg.define(/^the sidecar pane renders$/, (w) => { w.frame = composeFrame(w.dir); });
  reg.define(/^it shows "waiting for the first status tick…"$/, (w) => {
    assert.match(w.frame, /waiting for the first status tick/);
  });

  // Live panel
  reg.define(/^Claude has written a snapshot to CCR_STATE_DIR\/last-status\.json$/, (w) => {
    if (!w.dir) stateDir(w);
    fs.writeFileSync(path.join(w.dir, 'last-status.json'), SAMPLE);
  });
  reg.define(/^the sidecar redraws$/, (w) => { w.frame = composeFrame(w.dir, { now: 1_000_000 }); });
  reg.define(/^it renders the economy panel with correct block glyphs \(▓ ░ ●\) and colors$/, (w) => {
    // step-lint: allow unearned-absence -- the waiting-state step above asserts /waiting for the first status tick/ positively on a frame from this same composer
    assert.ok(!/waiting/.test(w.frame), 'no longer waiting');
    assert.ok(/[▓░]/.test(w.frame), 'block glyphs present');
    assert.ok(/\x1b\[/.test(w.frame), 'ANSI color present');
  });
  // Value fidelity: the snapshot's numbers must survive normalize → render, not
  // just produce *a* panel. Pins the raw-JSON → view field mapping end to end.
  reg.define(/^the meters carry the snapshot's numbers, not placeholders$/, (w) => {
    const plain = w.frame.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /5h[^\n]*\b50% used/, "SAMPLE's five_hour 50% reaches the 5h meter");
    assert.match(plain, /weekly[^\n]*\b40% used/, "SAMPLE's seven_day 40% reaches the weekly meter");
    assert.match(plain, /262K/, "SAMPLE's 262000 context tokens reach the context line");
  });

  // Live feed
  reg.define(/^the session transcript grows as Claude works$/, (w) => {
    w.tpath = tmpFile();
    w.defer(() => fs.rmSync(w.tpath, { force: true }));
    append(w.tpath, [toolLine('Edit', { file_path: 'a.js' })]);
  });
  reg.define(/^the sidecar tails the transcript$/, (w) => {
    // Capture COUNTS, not the array: updateFeed returns feedState.events by
    // reference, so holding both objects would alias to the same grown array.
    w.feedCount1 = updateFeed(w.tpath).events.length;
    append(w.tpath, [toolLine('Bash', { description: 'x' }), toolLine('Read', { file_path: 'b.js' })]);
    w.feedCount2 = updateFeed(w.tpath).events.length;
  });
  reg.define(/^the tool\/skills feed updates roughly once a second$/, (w) => {
    assert.ok(w.feedCount2 > w.feedCount1, `feed grows as the transcript grows (${w.feedCount1} -> ${w.feedCount2})`);
  });

  // Staleness annotation (snapshot ages while CC is busy) — driven through the
  // real composeFrame so it pins the wiring, not just the pure liveness() policy.
  reg.define(/^Claude wrote a snapshot (\d+) minutes ago and then went quiet$/, (w, n) => {
    const snap = path.join(stateDir(w), 'last-status.json');
    fs.writeFileSync(snap, SAMPLE);
    w.now = Date.now();
    const agoSec = w.now / 1000 - Number(n) * 60;   // age the file's mtime
    fs.utimesSync(snap, agoSec, agoSec);
  });
  reg.define(/^the sidecar redraws after the quiet spell$/, (w) => {
    w.frame = composeFrame(w.dir, { now: w.now });
  });
  reg.define(/^the economy panel is still shown with a dim "updated (\d+)m ago" marker$/, (w, n) => {
    assert.match(w.frame, /Opus 4\.8/, 'dashboard stays visible — the marker is never a wipe');
    assert.match(w.frame, new RegExp('updated ' + n + 'm ago'));
  });

  // Launcher wiring: the sidebar pane must auto-cancel copy-mode so a stray scroll
  // can't freeze it. The hook is pure tmux orchestration (no Node seam), so — like
  // windows-launcher pins buildWtArgs rather than spawning Windows Terminal — we pin
  // the wiring structurally against scripts/launch.sh.
  reg.define(/^the tmux launcher script scripts\/launch\.sh$/, (w) => {
    w.launchSh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'launch.sh'), 'utf8');
  });
  reg.define(/^it splits the sidebar pane$/, (w) => {
    assert.match(w.launchSh, /tmux -L "\$SOCKET" split-window[\s\S]*?sidecar/, 'launcher splits a sidebar pane running the sidecar');
  });
  reg.define(/^it captures the new pane id with "-P -F '#\{pane_id\}'" into SIDEBAR_PANE$/, (w) => {
    assert.match(w.launchSh, /SIDEBAR_PANE="\$\(tmux -L "\$SOCKET" split-window[\s\S]*?-P -F '#\{pane_id\}'/, 'captures the split pane id into SIDEBAR_PANE');
  });
  reg.define(/^it sets a pane-scoped pane-mode-changed hook that cancels copy-mode only while the pane is in a mode$/, (w) => {
    // pane-scoped (-p) so the Claude pane keeps normal scrollback…
    assert.match(w.launchSh, /tmux -L "\$SOCKET" set-hook -p -t "\$SIDEBAR_PANE" pane-mode-changed/, 'pane-scoped pane-mode-changed hook');
    // …guarded on #{pane_in_mode} so the cancel doesn't recurse, cancelling that pane's copy-mode.
    assert.match(w.launchSh, /if-shell -F '#\{pane_in_mode\}' 'send-keys -t \$SIDEBAR_PANE -X cancel'/, 'guarded copy-mode cancel');
  });

  // View cycling: a host key signals the sidecar, which never reads input.
  reg.define(/^it binds the view-cycle key$/, (w) => {
    w.cycleBinding = /printf "bind-key -n \S+ run-shell '%s'[\s\S]*?RUN_CONF"/.exec(w.launchSh);
    assert.ok(w.cycleBinding, 'the launcher emits a view-cycle binding');
    // The binding names a generated helper inside tmux SINGLE quotes, where
    // tmux performs no escape processing. Embedding the paths in the binding
    // itself put them through tmux's parser AND the shell's, and escaping for
    // both at once is how the original injection survived its first fix.
    // Witness: the double-quoted form itself — the shape that once let an
    // apostrophe in $HOME run as a command. The control keeps this refusal
    // pointed at that bug rather than at a spelling of it nobody writes.
    refuteWithControl(/run-shell \\"/, w.cycleBinding[0],
      String.raw`printf "bind-key -n F4 run-shell \"$CMD\""`,
      'the binding must not use a tmux double-quoted string');
  });
  reg.define(/^the key runs ccr's own cycle-view command against this profile's state dir$/, (w) => {
    const helper = /\{\s*\n\s*printf '#!\/bin\/sh[\s\S]*?\} > "\$CYCLE_SH"/.exec(w.launchSh);
    assert.ok(helper, 'a helper script carries the command');
    assert.match(helper[0], /\$REPO\/bin\/ccr\.js/, "it runs ccr's own CLI, never an arbitrary command");
    assert.match(helper[0], /cycle-view/, 'it invokes cycle-view');
    assert.match(helper[0], /--state-dir/, 'scoped to a state dir');
    // Every interpolated path is shell-escaped: these come from $HOME and env
    // overrides, and an apostrophe in one used to run as a command.
    for (const v of ['NODE', 'REPO/bin/ccr.js', 'STATE']) {
      assert.ok(helper[0].includes(`sq "$${v}"`), `${v} is single-quote-escaped before interpolation`);
    }
  });
  reg.define(/^the sidecar reads no keystroke of its own$/, () => {
    // The structural invariant the whole design exists to preserve; enforced
    // across the module graph by test/sidecar-capabilities.test.js.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sidecar.js'), 'utf8');
    // sidecar-keys.js really owns stdin; `readline` appears nowhere in this
    // repository, so it is spelled out beside it rather than riding along
    // unproved on its sibling branch.
    refuteWithControl(/process\.stdin|readline/, src,
      fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sidecar-keys.js'), 'utf8')
      + "require('node:readline')",
      'the sidecar must have no input channel');
    assert.match(src, /onSignal\('SIGUSR1'/, 'cycling arrives as a signal');
  });

  /**
   * @param {Record<string, any>} w
   * @param {string|null} beat null writes no heartbeat file at all
   * @param {number} [freshMs] omitted leaves the heartbeat's own mtime alone
   */
  const cycleHarness = (w, beat, freshMs) => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ccr-cycle-'));
    w.defer(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (beat != null) fs.writeFileSync(path.join(dir, 'sidecar-alive'), beat);
    if (freshMs != null) {
      const when = (Date.now() - freshMs) / 1000;
      fs.utimesSync(path.join(dir, 'sidecar-alive'), when, when);
    }
    w.cycleDir = dir;
  };

  reg.define(/^a state directory an attacker can write$/, (w) => {
    // The hostile shape that used to matter: a heartbeat naming someone else's
    // pid. Under the request-file mechanism it is simply irrelevant, which is
    // the point — the capability is gone rather than guarded.
    cycleHarness(w, `${process.pid}:${Date.now()}`, 0);
  });
  reg.define(/^a state directory with no live sidecar$/, (w) => { cycleHarness(w, null); });
  reg.define(/^a state directory with no view requests yet$/, (w) => { cycleHarness(w, null); });

  reg.define(/^the view-cycle command runs$/, (w) => { w.cycleResult = cycleView(w.cycleDir); });
  reg.define(/^the view-cycle command runs twice$/, (w) => {
    w.before = readViewRequests(w.cycleDir);
    cycleView(w.cycleDir);
    w.cycleResult = cycleView(w.cycleDir);
  });
  reg.define(/^it sends no signal to any process$/, () => {
    // Structural and absolute: there is no signalling code left to guard.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cycle-view.js'), 'utf8');
    refuteWithControl(/process\.kill|\bkill\(/, src,
      fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'instance-slot.js'), 'utf8'),
      'cycle-view must hold no signalling capability at all');
  });
  reg.define(/^the only thing it can change is which pane is displayed$/, (w) => {
    // Its entire effect is one counter in one file; nothing else is touched.
    const entries = fs.readdirSync(w.cycleDir).filter((f) => f !== 'sidecar-alive');
    assert.deepStrictEqual(entries, ['view-request'], 'cycling writes exactly one request file');
    assert.match(fs.readFileSync(path.join(w.cycleDir, 'view-request'), 'utf8'), /^\d+$/,
      'the request is a counter, never a command');
  });
  reg.define(/^the sidecar sees two pending advances$/, (w) => {
    assert.strictEqual(readViewRequests(w.cycleDir) - w.before, 2, 'each press records one advance');
  });
  reg.define(/^a sidecar that was already up to date sees none$/, (w) => {
    const seen = readViewRequests(w.cycleDir);
    assert.strictEqual(readViewRequests(w.cycleDir) - seen, 0, 'reading is idempotent — no phantom advances');
  });
  reg.define(/^the command still exits cleanly$/, (w) => {
    assert.ok(w.cycleResult && typeof w.cycleResult.ok === 'boolean', 'a result is returned, never thrown');
  });

  reg.define(/^the view-request path is a pipe that never yields bytes$/, (w) => {
    cycleHarness(w, null);
    try {
      require('node:child_process').execFileSync('mkfifo', [path.join(w.cycleDir, 'view-request')]);
    } catch { w.skipFifo = true; }
  });
  reg.define(/^the sidecar checks for pending advances$/, (w) => {
    const started = Date.now();
    w.advances = readViewRequests(w.cycleDir);
    w.elapsed = Date.now() - started;
  });
  reg.define(/^the check completes without blocking$/, (w) => {
    assert.ok(w.elapsed < 2000, `reading the request file blocked for ${w.elapsed}ms`);
  });
  reg.define(/^no advance is reported$/, (w) => {
    assert.strictEqual(w.advances, 0, 'an unreadable request file reports no advance');
  });

  // Socket isolation: each instance on its own tmux server. The universal scan
  // below is the ratchet — a NEW bare `tmux` call (no -L) reintroduces the
  // shared-server single point of failure, and must fail here, not in review.
  reg.define(/^it talks to tmux$/, () => {});
  reg.define(/^it derives a per-instance socket name from the session name$/, (w) => {
    assert.match(w.launchSh, /^SOCKET="\$SESSION"$/m, 'socket name follows the per-profile session name');
  });
  reg.define(/^every tmux invocation names that socket with -L$/, (w) => {
    /** @type {string[]} */
    const offenders = [];
    for (const line of w.launchSh.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      // Command positions only: line start, `$(`, or after ; && || — skips
      // `command -v tmux` and prose like "tmux not found" in messages.
      for (const m of line.matchAll(/(?:^|[;(]|&&|\|\|)\s*tmux\s+(\S+)/g)) {
        if (m[1] !== '-L') offenders.push(line.trim());
      }
    }
    assert.deepStrictEqual(offenders, [], 'every tmux invocation must carry -L (per-profile socket)');
  });
  reg.define(/^the in-pane teardown kill-session names the same socket$/, (w) => {
    // Inside the pane command string: single-quoted so the value expands at
    // launch, exactly like the '$SESSION' beside it.
    assert.match(w.launchSh, /tmux -L '\$SOCKET_Q' kill-session -t '\$SESSION_Q'/, 'pane teardown targets its own socket');
  });

  // Launcher robustness: fail loudly, never silently
  reg.define(/^a machine with no ~\/\.nvm and no node on PATH$/, (w) => {
    const { spawnSync } = require('node:child_process');
    w.fakeHome = freshDir();
    // A PATH with neither node nor tmux on it, so the launcher reaches its own
    // dependency checks — provided it survives node RESOLUTION to get there.
    w.emptyPath = freshDir();
    w.defer(() => { for (const d of [w.fakeHome, w.emptyPath]) fs.rmSync(d, { recursive: true, force: true }); });
    // The interpreter must be named absolutely: the child resolves its command
    // against the PATH we are deliberately emptying. Windows is excluded the
    // same way a bash-less host is — Git Bash answers `command -v bash` with a
    // virtual /usr/bin path spawnSync cannot execute, and scripts/launch.sh is
    // not a Windows surface (Windows has its own launcher).
    w.bash = process.platform === 'win32'
      ? ''
      : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  });
  reg.define(/^the tmux launcher runs$/, (w) => {
    if (!w.bash) return; // no bash on this host — the launcher isn't reachable anyway
    const { spawnSync } = require('node:child_process');
    w.launch = spawnSync(w.bash, [path.join(__dirname, '..', '..', 'scripts', 'launch.sh')], {
      env: { HOME: w.fakeHome, PATH: w.emptyPath },
      encoding: 'utf8',
      timeout: 20_000,
    });
  });
  reg.define(/^it reports that node was not found$/, (w) => {
    if (!w.bash) return;
    assert.match(String(w.launch.stderr || ''), /ccr: node not found/);
  });
  reg.define(/^it does not abort before reaching that check$/, (w) => {
    if (!w.bash) return;
    // The regression: `set -e` killed the script at the nvm glob, so it exited 2
    // with EMPTY stderr — no diagnosis, nothing to act on.
    assert.strictEqual(w.launch.status, 1, "the launcher's own guard exits 1, not the shell's 2");
    // Positive direction: stderr must CARRY something, which is the fact the
  // regression destroyed. Asserting "not empty string" says the same thing in
    // the shape that goes green when the needle is wrong.
    assert.ok(String(w.launch.stderr || '').trim().length > 0, 'never a silent abort');
  });

  // Heartbeat write safety
  reg.define(/^a fifo planted where the sidecar writes its heartbeat$/, (w) => {
    const { spawnSync } = require('node:child_process');
    w.dir = freshDir();
    w.defer(() => fs.rmSync(w.dir, { recursive: true, force: true }));
    const r = spawnSync('mkfifo', [path.join(w.dir, 'sidecar-alive')]);
    if (r.status !== 0) { w.noFifo = true; return; } // no mkfifo (e.g. Windows)
  });
  reg.define(/^the sidecar beats$/, (w) => {
    if (w.noFifo) return;
    const { spawnSync } = require('node:child_process');
    // In a CHILD with a timeout: a regressed guard blocks in writeFileSync
    // forever, and a synchronous hang would take the whole test runner with it.
    w.beat = spawnSync(process.execPath, [
      '-e',
      'require(process.argv[1]).heartbeatTick(process.argv[2], "1:2")',
      path.join(__dirname, '..', '..', 'src', 'sidecar.js'),
      w.dir,
    ], { timeout: 10_000, encoding: 'utf8' });
  });
  reg.define(/^the beat completes without blocking$/, (w) => {
    if (w.noFifo) return;
    assert.strictEqual(w.beat.signal, null, 'the heartbeat write blocked on the fifo');
    assert.strictEqual(w.beat.status, 0, w.beat.stderr);
  });
  reg.define(/^the heartbeat is a regular file again$/, (w) => {
    if (w.noFifo) return;
    assert.strictEqual(fs.lstatSync(path.join(w.dir, 'sidecar-alive')).isFile(), true);
  });

  // Ended (sentinel round-trip)
  reg.define(/^the sidecar is rendering the live panel$/, (w) => {
    fs.writeFileSync(path.join(stateDir(w), 'last-status.json'), SAMPLE);
    assert.match(composeFrame(w.dir, { now: 1_000_000 }), /Opus 4\.8/);
  });
  reg.define(/^Claude \(pane 0\) exits and drops the "exited" sentinel in the state dir$/, (w) => {
    fs.writeFileSync(path.join(w.dir, 'exited'), '');
  });
  reg.define(/^the sidecar shows the "session ended" state$/, (w) => {
    assert.match(composeFrame(w.dir), /session ended/);
  });
  reg.define(/^the sentinel round-trips without manual intervention$/, (w) => {
    assert.match(composeFrame(w.dir), /session ended/);
  });
};
