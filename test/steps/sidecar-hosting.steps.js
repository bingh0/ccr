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
  // Waiting
  reg.define(/^the split window has just opened$/, (w) => { w.dir = freshDir(); });
  reg.define(/^Claude has not yet produced a status tick$/, () => {});
  reg.define(/^the sidecar pane renders$/, (w) => { w.frame = composeFrame(w.dir); });
  reg.define(/^it shows "waiting for the first status tick…"$/, (w) => {
    assert.match(w.frame, /waiting for the first status tick/);
    fs.rmSync(w.dir, { recursive: true, force: true });
  });

  // Live panel
  reg.define(/^Claude has written a snapshot to CCR_STATE_DIR\/last-status\.json$/, (w) => {
    w.dir = w.dir || freshDir();
    fs.writeFileSync(path.join(w.dir, 'last-status.json'), SAMPLE);
  });
  reg.define(/^the sidecar redraws$/, (w) => { w.frame = composeFrame(w.dir, { now: 1_000_000 }); });
  reg.define(/^it renders the economy panel with correct block glyphs \(▓ ░ ●\) and colors$/, (w) => {
    assert.ok(!/waiting/.test(w.frame), 'no longer waiting');
    assert.ok(/[▓░]/.test(w.frame), 'block glyphs present');
    assert.ok(/\x1b\[/.test(w.frame), 'ANSI color present');
    fs.rmSync(w.dir, { recursive: true, force: true });
  });

  // Live feed
  reg.define(/^the session transcript grows as Claude works$/, (w) => {
    w.tpath = tmpFile();
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
    fs.unlinkSync(w.tpath);
  });

  // Ended (sentinel round-trip)
  reg.define(/^the sidecar is rendering the live panel$/, (w) => {
    w.dir = freshDir();
    fs.writeFileSync(path.join(w.dir, 'last-status.json'), SAMPLE);
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
    fs.rmSync(w.dir, { recursive: true, force: true });
  });
};
