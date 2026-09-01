// @ts-check
'use strict';
// test/tmux-clipboard-override.test.js — the clipboard override must survive
// tmux's own config parser, not merely read correctly in the file.
//
// WHY THIS FILE EXISTS. 0.6.0 shipped a headline clipboard fix that was INERT.
// sidecar/ccr.tmux.conf wrote the OSC 52 override inside DOUBLE quotes; tmux's
// double-quoted string parser consumes the backslash of the unknown escape \E
// and stores a literal `E]52;...`, which tmux then emits as plain text. Every
// copy landed in the tmux buffer, "copied N chars" appeared on screen, and the
// client clipboard was never set — over mosh, in silence, for a whole release.
//
// The source text READ correctly throughout, so every test that inspected the
// config file passed. That is the lesson worth pinning: for a value another
// program parses, the source is not the artifact. Only tmux can say what tmux
// stored. `ccr doctor` now asks it, and this file holds both halves of that
// answer — including a real-tmux negative control, because a check that has
// never been seen to fail is not yet known to be a check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const doctor = require('../src/doctor');

const REPO = path.join(__dirname, '..');
// A home with no ~/.ccr under it, so the capture lines stay quiet.
const NOHOME = path.join(os.tmpdir(), 'ccr-doctor-nohome-clip');
const HAVE_TMUX = process.platform !== 'win32'
  && spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

// tmux prints a stored backslash escaped, so a surviving `\E` reads back as
// `\\E`. Both lines below are transcribed from tmux 3.7's actual `show -s`
// output on the single- and double-quoted configs, byte-checked with `od -c`.
const SURVIVED = 'terminal-overrides[0] linux*:AX@\n'
  + 'terminal-overrides[1] "xterm-256color:Ms=\\\\E]52;c%p1%.0s;%p2%s\\\\007"\n';
const EATEN = 'terminal-overrides[0] linux*:AX@\n'
  + 'terminal-overrides[1] "xterm-256color:Ms=E]52;c%p1%.0s;%p2%s\\a"\n';

/**
 * Doctor on a box where tmux is present and modern, with the override probe
 * stubbed — so these assertions hold on a machine with no tmux at all.
 * @param {string|null} overrides
 * @returns {string}
 */
function runWith(overrides) {
  let buf = '';
  doctor.run({
    platform: 'linux',
    has: (cmd) => (cmd === 'tmux' ? '/usr/bin/tmux' : null),
    tmuxVersion: () => ({ major: 3, minor: 7 }),
    tmuxOverrides: () => overrides,
    homedir: NOHOME,
    write: (s) => { buf += s; },
  });
  return buf;
}

/** The trailing "N thing(s) to address above" count; 0 when doctor says all good. */
function problems(/** @type {string} */ out) {
  const m = /(\d+) thing\(s\) to address above/.exec(out);
  return m ? Number(m[1]) : 0;
}

test('a surviving \\E is reported as healthy', () => {
  assert.match(runWith(SURVIVED), /clipboard override survives tmux config parsing/);
});

test('an eaten \\E is named, and so is the remedy', () => {
  const out = runWith(EATEN);
  assert.match(out, /dropped the clipboard override/, 'the failure is stated outright');
  assert.match(out, /SINGLE-quote/, 'and the fix, since the source looks correct either way');
  assert.match(out, /mosh|ssh/, 'and where it bites, since it is invisible locally');
});

// The isolating control: the two runs differ in nothing but the stored value,
// so a difference of exactly one proves the verdict reaches the exit code —
// and that a healthy override costs nothing.
test('an eaten override costs exactly one problem, a surviving one none', () => {
  assert.strictEqual(problems(runWith(EATEN)), problems(runWith(SURVIVED)) + 1);
});

test('an unreadable probe is not evidence of a problem', () => {
  const out = runWith(null);
  assert.match(out, /clipboard override unverified/, 'it says it could not tell');
  assert.strictEqual(problems(out), problems(runWith(SURVIVED)),
    'and charges nothing for not knowing');
});

test('real tmux keeps the shipped override intact',
  { skip: !HAVE_TMUX && 'tmux is not installed' }, () => {
    let buf = '';
    doctor.run({ platform: 'linux', repo: REPO, homedir: NOHOME, write: (s) => { buf += s; } });
    assert.match(buf, /clipboard override survives tmux config parsing/,
      'the config this repo ships must resolve with its \\E intact on a real tmux');
  });

// The negative control. Without it the check above could be a constant `true`
// and nobody would know — which is precisely how 0.6.0 shipped.
test('real tmux eats the override when the value is double-quoted',
  { skip: !HAVE_TMUX && 'tmux is not installed' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-clip-control-'));
    t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(dir, 'sidecar'));
    const src = fs.readFileSync(path.join(REPO, 'sidecar', 'ccr.tmux.conf'), 'utf8');
    // Re-create the exact 0.6.0 spelling: the same value, double-quoted.
    const broken = src.replace(/^(set -as terminal-overrides )'(.*)'$/m, '$1"$2"');
    assert.notStrictEqual(broken, src,
      'the fixture must really differ from the shipped config, or this control is vacuous');
    fs.writeFileSync(path.join(dir, 'sidecar', 'ccr.tmux.conf'), broken);

    let buf = '';
    doctor.run({ platform: 'linux', repo: dir, homedir: NOHOME, write: (s) => { buf += s; } });
    assert.match(buf, /dropped the clipboard override/,
      'real tmux must be seen to eat it, or the healthy verdict proves nothing');
  });
