// @ts-check
'use strict';
// Step definitions for features/doctor-windows.feature — drives src/doctor.js
// run() on a simulated win32 box and asserts the rendered report.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../../src/doctor');
const { refuteWithControl } = require('./_absence');

const hasStub = (/** @type {Record<string, string>} */ present) =>
  (/** @type {string} */ cmd) => (present[cmd] ? present[cmd] : null);

function runDoctor(/** @type {Record<string, any>} */ w) {
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
  reg.define(/^Node 22\.17\+ is installed$/, () => {});
  reg.define(/^`ccr` is on PATH$/, (w) => { (w.present ||= {}).ccr = 'C:\\ccr.cmd'; });
  reg.define(/^`wt\.exe` is resolvable$/, (w) => { (w.present ||= {}).wt = 'C:\\wt.exe'; });
  reg.define(/^`wt\.exe` is not resolvable$/, (w) => { (w.present ||= {}).wt = null; });

  // When
  reg.define(/^I run "ccr doctor"$/, (w) => runDoctor(w));

  // Then
  reg.define(/^it reports node OK$/, (w) => assert.match(w.text, /node v/));
  reg.define(/^it reports ccr-on-PATH OK$/, (w) => assert.match(w.text, /ccr on PATH/));
  reg.define(/^it reports "✓ Windows Terminal \(sidecar host\)"$/, (w) => assert.match(w.text, /Windows Terminal \(sidecar host\)/));
  // The witness is the sentence being refused: doctor once could have sent
  // Windows users to WSL, and this pins that it does not. A needle that stops
  // matching that sentence is a needle that would no longer notice.
  reg.define(/^the output contains no "use WSL" \/ "WSL-only" language$/, (w) =>
    refuteWithControl(/WSL/i, w.text, 'the sidecar is WSL-only — use WSL',
      'doctor must not send Windows users to WSL'));

  reg.define(/^it warns that Windows Terminal was not found$/, (w) => assert.match(w.text, /Windows Terminal not found/));
  reg.define(/^it suggests "winget install Microsoft\.WindowsTerminal"$/, (w) => assert.match(w.text, /winget install Microsoft\.WindowsTerminal/));
  reg.define(/^it notes the CLI still works$/, (w) => assert.match(w.text, /the CLI still works/));

  reg.define(/^ccs presence is reported as optional$/, (w) => assert.match(w.text, /ccs not installed \(optional/));
  reg.define(/^the capture-status check is reported$/, (w) => assert.match(w.text, /status captured|no status captured/));
  // Controlled against doctor's own source, which carries the POSIX phrase
  // ('sidecar/ccr-statusline is executable'). Reword that check and this
  // refusal goes red rather than silently passing on a phrase nobody emits.
  reg.define(/^the executable-bit \(0o111\) check is skipped on Windows$/, (w) =>
    refuteWithControl(/is executable/, w.text,
      fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'doctor.js'), 'utf8'),
      'the executable-bit check has no meaning on Windows and must not run'));
};
