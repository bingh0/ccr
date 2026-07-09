// @ts-check
'use strict';
// Step definitions for features/sidecar-hosting.feature — drives the pure-Node
// sidecar (composeFrame / updateFeed) against a real temp state dir, pinning the
// waiting → live → ended states and the incremental tool/skills feed.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshDir, SAMPLE, tmpFile, toolLine, append } = require('./_win-helpers');
const { composeFrame, updateFeed } = require('../../src/sidecar');

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
    assert.match(w.launchSh, /tmux split-window[\s\S]*?sidecar/, 'launcher splits a sidebar pane running the sidecar');
  });
  reg.define(/^it captures the new pane id with "-P -F '#\{pane_id\}'" into SIDEBAR_PANE$/, (w) => {
    assert.match(w.launchSh, /SIDEBAR_PANE="\$\(tmux split-window[\s\S]*?-P -F '#\{pane_id\}'/, 'captures the split pane id into SIDEBAR_PANE');
  });
  reg.define(/^it sets a pane-scoped pane-mode-changed hook that cancels copy-mode only while the pane is in a mode$/, (w) => {
    // pane-scoped (-p) so the Claude pane keeps normal scrollback…
    assert.match(w.launchSh, /tmux set-hook -p -t "\$SIDEBAR_PANE" pane-mode-changed/, 'pane-scoped pane-mode-changed hook');
    // …guarded on #{pane_in_mode} so the cancel doesn't recurse, cancelling that pane's copy-mode.
    assert.match(w.launchSh, /if-shell -F '#\{pane_in_mode\}' 'send-keys -t \$SIDEBAR_PANE -X cancel'/, 'guarded copy-mode cancel');
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
