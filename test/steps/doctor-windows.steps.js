// @ts-check
'use strict';
// Step definitions for features/doctor-windows.feature — drives src/doctor.js
// run() on a simulated win32 box and asserts the rendered report.

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../../src/doctor');

const hasStub = (present) => (cmd) => (present[cmd] ? present[cmd] : null);

function runDoctor(w) {
  w.text = '';
  w.code = run({
    platform: 'win32',
    has: hasStub(w.present || {}),
    homedir: path.join(os.tmpdir(), 'ccr-doctor-nohome-feat'), // keep ~/.ccr noise out
    write: (/** @type {string} */ s) => { w.text += s; },
  });
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineDoctorWindowsSteps(reg) {
  // Background + Givens
  reg.define(/^the platform is win32$/, (w) => { w.platform = 'win32'; });
  reg.define(/^Node 18\.3\+ is installed$/, () => {});
  reg.define(/^`ccr` is on PATH$/, (w) => { (w.present ||= {}).ccr = 'C:\\ccr.cmd'; });
  reg.define(/^`wt\.exe` is resolvable$/, (w) => { (w.present ||= {}).wt = 'C:\\wt.exe'; });
  reg.define(/^`wt\.exe` is not resolvable$/, (w) => { (w.present ||= {}).wt = null; });

  // When
  reg.define(/^I run "ccr doctor"$/, (w) => runDoctor(w));

  // Then
  reg.define(/^it reports node OK$/, (w) => assert.match(w.text, /node v/));
  reg.define(/^it reports ccr-on-PATH OK$/, (w) => assert.match(w.text, /ccr on PATH/));
  reg.define(/^it reports "✓ Windows Terminal \(sidecar host\)"$/, (w) => assert.match(w.text, /Windows Terminal \(sidecar host\)/));
  reg.define(/^the output contains no "use WSL" \/ "WSL-only" language$/, (w) => assert.ok(!/WSL/i.test(w.text)));

  reg.define(/^it warns that Windows Terminal was not found$/, (w) => assert.match(w.text, /Windows Terminal not found/));
  reg.define(/^it suggests "winget install Microsoft\.WindowsTerminal"$/, (w) => assert.match(w.text, /winget install Microsoft\.WindowsTerminal/));
  reg.define(/^it notes the CLI still works$/, (w) => assert.match(w.text, /the CLI still works/));

  reg.define(/^ccs presence is reported as optional$/, (w) => assert.match(w.text, /ccs not installed \(optional/));
  reg.define(/^the capture-status check is reported$/, (w) => assert.match(w.text, /status captured|no status captured/));
  reg.define(/^the executable-bit \(0o111\) check is skipped on Windows$/, (w) => assert.ok(!/is executable/.test(w.text)));
};
