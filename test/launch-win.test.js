'use strict';

// Phase 1 — pure launcher helpers.
// Mirrors features/wt-args-builder.feature and the profile-validation /
// state-resolution scenarios of features/windows-launcher.feature.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  validateProfile,
  isWtArgSafe,
  resolveProfileState,
  sidebarFraction,
  sidebarSplitFlag,
  sidecarCols,
  buildWtArgs,
  findWindowsTerminal,
} = require('../src/launch-win.js');

test('validateProfile: accepts safe identifiers', () => {
  for (const ok of ['c1', 'work', 'a.b_c-1', 'C1', '0', '_-.']) {
    assert.strictEqual(validateProfile(ok), true, ok);
  }
});

// windows-launcher.feature: "Invalid profile names are rejected before any spawn"
test('validateProfile: rejects unsafe / non-string profiles', () => {
  for (const bad of ['../escape', 'a b', 'name;rm', '"quoted"', '', 'a/b', 'a\\b', undefined, null, 42]) {
    assert.strictEqual(validateProfile(bad), false, String(bad));
  }
});

test('resolveProfileState: plain claude defaults', () => {
  const r = resolveProfileState(undefined, { env: {}, home: '/home/me' });
  assert.strictEqual(r.ccCmd, 'claude');
  assert.strictEqual(r.session, 'ccr');
  assert.strictEqual(r.stateDir, path.join('/home/me', '.ccr'));
  assert.strictEqual(r.instanceDir, null);
  assert.strictEqual(r.usesCcs, false);
});

test('resolveProfileState: profile targets CCS state dir and instance dir (@AC6)', () => {
  const r = resolveProfileState('c1', { env: {}, home: '/home/me' });
  assert.strictEqual(r.ccCmd, 'ccs c1');
  assert.strictEqual(r.session, 'ccr-c1');
  assert.strictEqual(r.stateDir, path.join('/home/me', '.ccr', 'c1'));
  assert.strictEqual(r.instanceDir, path.join('/home/me', '.ccs', 'instances', 'c1'));
  assert.strictEqual(r.usesCcs, true);
});

test('resolveProfileState: honors CC_BIN / CCR_SESSION / CCR_STATE_DIR overrides', () => {
  const env = { CC_BIN: 'claude-beta', CCR_SESSION: 's', CCR_STATE_DIR: '/custom' };
  const r = resolveProfileState(undefined, { env, home: '/home/me' });
  assert.strictEqual(r.ccCmd, 'claude-beta');
  assert.strictEqual(r.session, 's');
  assert.strictEqual(r.stateDir, '/custom');

  const rp = resolveProfileState('c1', { env: { CCR_STATE_DIR: '/custom' }, home: '/home/me' });
  assert.strictEqual(rp.stateDir, '/custom');
});

test('sidebarFraction: percent -> wt fraction, with clamp and default', () => {
  assert.strictEqual(sidebarFraction(34), '0.34');
  assert.strictEqual(sidebarFraction(50), '0.5');
  assert.strictEqual(sidebarFraction(undefined), '0.34');
  assert.strictEqual(sidebarFraction(NaN), '0.34');
  assert.strictEqual(sidebarFraction(1), '0.05'); // clamped up to 5
  assert.strictEqual(sidebarFraction(100), '0.95'); // clamped down to 95
});

const baseArgsInput = {
  ccCmd: 'claude',
  settingsFile: 'C:\\Temp\\ccr-settings-ab12.json',
  stateDir: 'C:\\Users\\me\\.ccr',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  ccrJs: 'C:\\repo\\bin\\ccr.js',
  sidebarPct: 34,
};

test('buildWtArgs: canonical two-pane argv (@AC9 @AC2)', () => {
  const a = buildWtArgs(baseArgsInput);

  // `-w 0` targets the CURRENT Windows Terminal window (no separate window).
  assert.strictEqual(a[0], '-w');
  assert.strictEqual(a[1], '0');

  // Pane 0 = new-tab titled "Claude", under cmd /c so the pane closes on exit.
  assert.strictEqual(a[2], 'new-tab');
  assert.strictEqual(a[3], '--title');
  assert.strictEqual(a[4], 'Claude');
  assert.strictEqual(a[5], 'cmd');
  assert.strictEqual(a[6], '/c');
  const pane0 = a[7];
  assert.match(pane0, /set "CCR_STATE_DIR=C:\\Users\\me\\.ccr"/);
  assert.match(pane0, /claude --settings "C:\\Temp\\ccr-settings-ab12\.json"/);

  // ";" is a standalone separator token.
  const sep = a.indexOf(';');
  assert.strictEqual(a[8], ';');
  assert.ok(sep > 0);

  // Split + size. Default side is 'right' → a vertical split (-V).
  assert.strictEqual(a[sep + 1], 'split-pane');
  assert.strictEqual(a[sep + 2], '-V');
  assert.strictEqual(a[sep + 3], '-s');
  assert.strictEqual(a[sep + 4], '0.34');
  assert.strictEqual(a[sep + 5], 'cmd');
  assert.strictEqual(a[sep + 6], '/c');
  const pane1 = a[sep + 7];
  assert.match(pane1, /set "CCR_STATE_DIR=C:\\Users\\me\\.ccr"/);
  // Sidecar carries --exit-on-end so its cmd /c pane sweeps closed on session end.
  assert.match(pane1, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\repo\\bin\\ccr\.js" sidecar --exit-on-end/);
});

test('sidebarSplitFlag: side → wt split flag, defaulting to right (-V)', () => {
  assert.strictEqual(sidebarSplitFlag('right'), '-V');
  assert.strictEqual(sidebarSplitFlag('RIGHT'), '-V');
  assert.strictEqual(sidebarSplitFlag('bottom'), '-H');
  assert.strictEqual(sidebarSplitFlag('Bottom'), '-H');
  // Unknown / unset falls back to the default (right).
  assert.strictEqual(sidebarSplitFlag(undefined), '-V');
  assert.strictEqual(sidebarSplitFlag('sideways'), '-V');
});

test('sidecarCols: right split → fraction of width minus the divider', () => {
  // 120 cols * 0.34 = 40.8 → floor 40, minus 1 for the pane divider = 39.
  assert.strictEqual(sidecarCols(120, 0.34, '-V'), 39);
  assert.strictEqual(sidecarCols(200, 0.5, '-V'), 99);
});

test('sidecarCols: bottom split keeps the full width', () => {
  assert.strictEqual(sidecarCols(120, 0.34, '-H'), 120);
});

test('sidecarCols: unknown terminal width → null (no hint injected)', () => {
  assert.strictEqual(sidecarCols(undefined, 0.34, '-V'), null);
  assert.strictEqual(sidecarCols(0, 0.34, '-V'), null);
  assert.strictEqual(sidecarCols(NaN, 0.34, '-V'), null);
});

test('sidecarCols: clamps tiny panes up to a usable floor', () => {
  assert.strictEqual(sidecarCols(10, 0.34, '-V'), 20);
});

test('buildWtArgs: injects CCR_SIDECAR_COLS into pane 1 when termCols is known', () => {
  const a = buildWtArgs({ ...baseArgsInput, termCols: 120 });
  const sep = a.indexOf(';');
  const pane1 = a[sep + 7];
  // 120 * 0.34 → 40 → 39 after the divider.
  assert.match(pane1, /set "CCR_SIDECAR_COLS=39"/);
  // The state dir is still set, and it precedes the node invocation.
  assert.match(pane1, /set "CCR_STATE_DIR=C:\\Users\\me\\.ccr"/);
  assert.match(pane1, /sidecar --exit-on-end/);
});

test('buildWtArgs: omits CCR_SIDECAR_COLS when termCols is unknown', () => {
  const a = buildWtArgs(baseArgsInput); // no termCols
  const sep = a.indexOf(';');
  assert.doesNotMatch(a[sep + 7], /CCR_SIDECAR_COLS/);
});

test('buildWtArgs: sidebarSide bottom uses a horizontal split (-H)', () => {
  const a = buildWtArgs({ ...baseArgsInput, sidebarSide: 'bottom' });
  const sep = a.indexOf(';');
  assert.strictEqual(a[sep + 1], 'split-pane');
  assert.strictEqual(a[sep + 2], '-H');
});

test('buildWtArgs: per-pane env via cmd /c, present in both panes (@AC9)', () => {
  const a = buildWtArgs(baseArgsInput);
  const cmdC = a.filter((t, i) => t === 'cmd' && a[i + 1] === '/c');
  assert.strictEqual(cmdC.length, 2);
  const panes = a.filter((t) => t.startsWith('set "CCR_STATE_DIR='));
  assert.strictEqual(panes.length, 2);
});

test('buildWtArgs: pane 0 appends the exited sentinel (@AC9 @AC5)', () => {
  const a = buildWtArgs(baseArgsInput);
  const pane0 = a[7];
  assert.match(pane0, /& type nul > "C:\\Users\\me\\.ccr\\exited"/);
});

test('buildWtArgs: pane 0 deletes the temp settings file on exit (@AC8)', () => {
  const a = buildWtArgs(baseArgsInput);
  const pane0 = a[7];
  assert.match(pane0, /& del \/q "C:\\Temp\\ccr-settings-ab12\.json"/);
});

test('buildWtArgs: pane 0 lingers after cleanup so the sidecar closes first', () => {
  const pane0 = buildWtArgs(baseArgsInput)[7];
  // The linger runs AFTER the sentinel + settings cleanup, so the right pane
  // (sidecar) collapses before pane 0 → border sweeps left→right.
  assert.match(pane0, /& del \/q "[^"]+" & ping -n 2 127\.0\.0\.1 >nul$/);
});

test('buildWtArgs: settings passed by path, never inline JSON (@AC9 @AC8)', () => {
  const a = buildWtArgs(baseArgsInput);
  const joined = a.join(' ');
  assert.ok(joined.includes(baseArgsInput.settingsFile));
  assert.ok(!joined.includes('{'), 'no raw JSON object on the command line');
  assert.ok(!joined.includes('statusLine'));
});

test('buildWtArgs: ccs profile command flows through pane 0 (@AC6)', () => {
  const a = buildWtArgs({ ...baseArgsInput, ccCmd: 'ccs c1' });
  assert.match(a[7], /ccs c1 --settings /);
});

test('findWindowsTerminal: returns null when wt is absent (@AC7)', () => {
  let calls = 0;
  const runWhere = () => { calls++; return null; };
  assert.strictEqual(findWindowsTerminal({ runWhere }), null);
  assert.ok(calls >= 1);
});

test('findWindowsTerminal: returns the resolved path when found', () => {
  const runWhere = (name) => (name === 'wt' ? 'C:\\wt.exe' : null);
  assert.strictEqual(findWindowsTerminal({ runWhere }), 'C:\\wt.exe');
});

test('findWindowsTerminal: does not throw', () => {
  assert.doesNotThrow(() => findWindowsTerminal({ runWhere: () => null }));
});

// --- Adversarial quoting (the cmd /k payload) -----------------------------
// buildWtArgs raw-interpolates paths into a cmd.exe line. `"` and `%` are the
// two characters our `set "VAR=val"` / `"path"` quoting does NOT neutralize:
// `"` ends the quoted string, and `%` triggers cmd.exe variable expansion even
// inside quotes (a path like C:\Users\%PATH% would expand at runtime). Pin that
// these are rejected, not silently emitted, so a weird path can never produce a
// broken — or self-expanding — command. (& | < > are literal inside the quotes,
// so they must remain ALLOWED.)

test('isWtArgSafe: allows spaces and shell metacharacters that quotes neutralize', () => {
  for (const ok of [
    'C:\\Program Files\\nodejs\\node.exe', // space
    'C:\\Users\\John & Jane\\.ccr',        // & is literal inside quotes
    'C:\\Users\\me (work)\\.ccr',          // parens
    'C:\\Temp\\a|b<c>d',                   // pipe/redirect literal inside quotes
    'ccs c1',                              // the profile command form
  ]) {
    assert.strictEqual(isWtArgSafe(ok), true, ok);
  }
});

test('isWtArgSafe: rejects the quote-breaking / expansion / newline chars', () => {
  for (const bad of [
    'C:\\Users\\"quoted"\\.ccr', // double quote ends the string
    'C:\\Users\\%USERNAME%\\.ccr', // % expands inside cmd
    'C:\\Users\\50%off\\.ccr',     // lone % is still unsafe
    'claude\r\nmalicious',         // CRLF breaks the command line
  ]) {
    assert.strictEqual(isWtArgSafe(bad), false, bad);
  }
});

test('buildWtArgs: throws on a state dir containing %% (would expand in cmd)', () => {
  assert.throws(
    () => buildWtArgs({ ...baseArgsInput, stateDir: 'C:\\Users\\%USERNAME%\\.ccr' }),
    /unsupported character.*Windows Terminal/s,
  );
});

test('buildWtArgs: throws on a settings file path containing a double quote', () => {
  assert.throws(
    () => buildWtArgs({ ...baseArgsInput, settingsFile: 'C:\\Temp\\a"b.json' }),
    /settings file path/,
  );
});

test('buildWtArgs: throws on a CC_BIN-derived claude command with %', () => {
  // CC_BIN flows into ccCmd unvalidated upstream; buildWtArgs is the backstop.
  assert.throws(
    () => buildWtArgs({ ...baseArgsInput, ccCmd: 'claude%PATH%' }),
    /claude command/,
  );
});

test('buildWtArgs: still builds cleanly for paths with spaces and &', () => {
  assert.doesNotThrow(() =>
    buildWtArgs({ ...baseArgsInput, stateDir: 'C:\\Users\\John & Jane\\.ccr' }));
});
