// @ts-check
'use strict';
// Unit tests for src/launch-vscode.js — the VS Code split-terminal launcher.
// Mirrors features/vscode-sidecar.feature. Pure helpers are tested directly;
// run()/hint() are exercised with fully-injected, recorded side effects.

const test = require('node:test');
const assert = require('node:assert');
const {
  splitKeybinding,
  sidecarPasteCommand,
  osc52,
  buildBanner,
  copyToClipboard,
  run,
  hint,
} = require('../src/launch-vscode.js');

test('splitKeybinding: platform-aware split shortcut', () => {
  assert.strictEqual(splitKeybinding('darwin'), 'Cmd+\\');
  assert.strictEqual(splitKeybinding('win32'), 'Ctrl+Shift+5');
  assert.strictEqual(splitKeybinding('linux'), 'Ctrl+Shift+5');
});

test('sidecarPasteCommand: prefers `ccr` on PATH, carries the state dir by arg', () => {
  const cmd = sidecarPasteCommand({ stateDir: 'C:\\Users\\me\\.ccr', ccrBin: 'C:\\ccr.cmd', node: 'N', ccrJs: 'J' });
  assert.strictEqual(cmd, 'ccr sidecar --state-dir "C:\\Users\\me\\.ccr"');
});

test('sidecarPasteCommand: falls back to node + ccr.js by path when ccr is absent', () => {
  const cmd = sidecarPasteCommand({ stateDir: '/home/me/.ccr', ccrBin: null, node: '/usr/bin/node', ccrJs: '/repo/bin/ccr.js' });
  assert.strictEqual(cmd, '"/usr/bin/node" "/repo/bin/ccr.js" sidecar --state-dir "/home/me/.ccr"');
});

test('sidecarPasteCommand: hint form omits the state dir', () => {
  assert.strictEqual(sidecarPasteCommand({ stateDir: '/x', ccrBin: 'ccr', node: 'N', ccrJs: 'J', hint: true }), 'ccr sidecar --hint');
});

test('osc52: base64 clipboard escape that round-trips', () => {
  const esc = osc52('ccr sidecar --hint');
  assert.match(esc, /^\x1b\]52;c;[A-Za-z0-9+/=]+\x07$/);
  const b64 = esc.replace(/^\x1b\]52;c;/, '').replace(/\x07$/, '');
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf8'), 'ccr sidecar --hint');
});

test('buildBanner: plain mode has the steps and no ANSI', () => {
  const b = buildBanner({ sidecarCmd: 'ccr sidecar --state-dir "X"', splitKey: 'Ctrl+Shift+5', hintCmd: 'ccr sidecar --hint', color: false });
  assert.match(b, /live sidecar/);
  assert.match(b, /Ctrl\+Shift\+5/);
  assert.match(b, /ccr sidecar --state-dir "X"/);
  assert.match(b, /ccr sidecar --hint/);
  assert.ok(!/\x1b\[/.test(b), 'no ANSI in plain mode');
});

test('buildBanner: color mode adds ANSI (bright header + blink cue)', () => {
  const b = buildBanner({ sidecarCmd: 'x', splitKey: 'Ctrl+Shift+5', hintCmd: 'h', color: true });
  assert.ok(/\x1b\[1;30;103m/.test(b), 'bright reverse header');
  assert.ok(/\x1b\[5m/.test(b), 'blink cue present');
});

test('copyToClipboard: emits OSC 52 and tries a native tool, best-effort', () => {
  let out = '';
  const copies = [];
  copyToClipboard('PAYLOAD', {
    platform: 'linux',
    out: (s) => { out += s; },
    spawnCopy: (cmd, args, input) => { copies.push({ cmd, args, input }); return { status: 0 }; },
  });
  assert.match(out, /\x1b\]52;c;/, 'OSC 52 written');
  assert.strictEqual(copies[0].cmd, 'wl-copy');
  assert.strictEqual(copies[0].input, 'PAYLOAD');
});

test('copyToClipboard: never throws when no clipboard tool works', () => {
  assert.doesNotThrow(() => copyToClipboard('x', {
    platform: 'linux',
    out: () => {},
    spawnCopy: () => { throw new Error('not found'); },
  }));
});

// --- run() / hint() with injected side effects -----------------------------

function harness(over = {}) {
  const w = { out: '', err: '', spawnedClaude: null, copied: [], droppedExited: 0, cleaned: [], settings: null };
  const base = {
    env: {},
    home: '/home/me',
    node: '/usr/bin/node',
    ccrJs: '/repo/bin/ccr.js',
    platform: 'win32',
    color: false,
    out: (s) => { w.out += s; },
    err: (s) => { w.err += s; },
    which: (name) => (name === 'claude' || name === 'ccr' || over.present?.includes?.(name) ? `/usr/bin/${name}` : null),
    existsDir: () => over.existsProfile !== false,
    listDir: () => ['c1', 'c2'],
    ensureDir: () => {},
    removeExited: () => {},
    dropExited: () => { w.droppedExited++; },
    writeSettings: (s) => { w.settings = s; return 'C:\\Temp\\ccr-settings-x.json'; },
    cleanup: (f) => { w.cleaned.push(f); },
    spawnClaude: (bin, args) => { w.spawnedClaude = { bin, args }; return { status: 0 }; },
    spawnCopy: (cmd, args, input) => { w.copied.push({ cmd, input }); return { status: 0 }; },
  };
  return { w, deps: { ...base, ...over.deps } };
}

test('run: wires the banner, clipboard, Claude, and the exit sentinel', () => {
  const { w, deps } = harness();
  const code = run(undefined, deps);
  assert.strictEqual(code, 0);
  assert.match(w.out, /live sidecar/, 'banner printed');
  assert.match(w.out, /Ctrl\+Shift\+5/);
  assert.ok(w.copied.length >= 1 || /\x1b\]52;c;/.test(w.out), 'clipboard attempted');
  assert.strictEqual(w.spawnedClaude.bin, 'claude');
  assert.deepStrictEqual(w.spawnedClaude.args, ['--settings', 'C:\\Temp\\ccr-settings-x.json']);
  assert.strictEqual(w.droppedExited, 1, 'session-ended sentinel dropped after Claude exits');
  assert.deepStrictEqual(w.cleaned, ['C:\\Temp\\ccr-settings-x.json'], 'temp settings cleaned up');
});

test('run: rejects an invalid profile before any spawn', () => {
  const { w, deps } = harness();
  const code = run('../escape', deps);
  assert.strictEqual(code, 1);
  assert.match(w.err, /invalid profile/i);
  assert.strictEqual(w.spawnedClaude, null);
});

test('run: a profile runs `ccs <profile>` against the profile state dir', () => {
  const { w, deps } = harness({ present: ['ccs'] });
  const code = run('c1', deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(w.spawnedClaude.bin, 'ccs');
  assert.deepStrictEqual(w.spawnedClaude.args, ['c1', '--settings', 'C:\\Temp\\ccr-settings-x.json']);
  assert.match(w.out, /ccr sidecar --state-dir ".*\.ccr.c1"/, 'sidecar one-liner targets the profile state dir');
});

test('run: unknown profile errors with the available list and no spawn', () => {
  const { w, deps } = harness({ present: ['ccs'], existsProfile: false });
  const code = run('nope', deps);
  assert.strictEqual(code, 1);
  assert.match(w.err, /not found/);
  assert.match(w.err, /available: c1 c2/);
  assert.strictEqual(w.spawnedClaude, null);
});

test('hint: reprints the banner + copies, without launching Claude', () => {
  const { w, deps } = harness();
  const code = hint('/home/me/.ccr', deps);
  assert.strictEqual(code, 0);
  assert.match(w.out, /live sidecar/);
  assert.strictEqual(w.spawnedClaude, null, 'hint never spawns Claude');
});
