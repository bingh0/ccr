'use strict';

// Phase 4 — doctor Windows branch. Mirrors features/doctor-windows.feature.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../src/doctor.js');

// has() stub: resolve only the named tools to a fake path, everything else null.
function hasStub(present) {
  return (cmd) => (present[cmd] ? present[cmd] : null);
}

// Run doctor on a simulated win32 box and capture the rendered text + exit code.
function runWin(present, extra = {}) {
  let text = '';
  const code = run({
    platform: 'win32',
    has: hasStub(present),
    homedir: path.join(os.tmpdir(), 'ccr-doctor-nohome-xyz'), // no ~/.ccr noise
    write: (s) => { text += s; },
    ...extra,
  });
  return { text, code };
}

test('doctor reports a healthy Windows setup with Windows Terminal (@AC1)', () => {
  const { text } = runWin({ ccr: 'C:\\ccr.cmd', wt: 'C:\\wt.exe', claude: 'C:\\claude.exe' });
  assert.match(text, /ccr on PATH/);
  assert.match(text, /Windows Terminal \(sidecar host\)/);
  assert.match(text, /node v/);
});

test('doctor output contains no WSL / tmux / bash language on Windows (@AC1)', () => {
  const { text } = runWin({ ccr: 'C:\\ccr.cmd', wt: 'C:\\wt.exe' });
  assert.ok(!/WSL/i.test(text), 'no WSL language');
  assert.ok(!/tmux/i.test(text), 'no tmux line');
  assert.ok(!/\bbash\b/i.test(text), 'no bash line');
});

test('doctor flags missing Windows Terminal with winget hint, CLI still works (@AC1)', () => {
  const { text, code } = runWin({ ccr: 'C:\\ccr.cmd' }); // no wt
  assert.match(text, /Windows Terminal not found/);
  assert.match(text, /winget install Microsoft\.WindowsTerminal/);
  assert.match(text, /the CLI still works/);
  assert.strictEqual(code, 1);
});

test('doctor skips the 0o111 exec-bit check on Windows (@AC1)', () => {
  const { text } = runWin({ ccr: 'C:\\ccr.cmd', wt: 'C:\\wt.exe' });
  assert.ok(!/is executable/.test(text), 'no 0o111 exec-bit check on Windows');
  // statusLine is injected inline via the temp settings file — no shipped shim asset.
  assert.ok(!/ccr-statusline\.cmd/.test(text), 'no .cmd shim check on Windows');
});

test('doctor reports ccs as optional when absent (@AC1)', () => {
  const { text } = runWin({ ccr: 'C:\\ccr.cmd', wt: 'C:\\wt.exe' }); // no ccs
  assert.match(text, /ccs not installed \(optional/);
});

test('non-Windows branch is unchanged (still checks tmux/bash)', () => {
  let text = '';
  run({
    platform: 'linux',
    has: hasStub({ ccr: '/usr/bin/ccr', tmux: '/usr/bin/tmux', bash: '/bin/bash' }),
    homedir: path.join(os.tmpdir(), 'ccr-doctor-nohome-xyz'),
    write: (s) => { text += s; },
  });
  assert.match(text, /tmux/);
  assert.match(text, /bash/);
  assert.ok(!/Windows Terminal/.test(text));
});
