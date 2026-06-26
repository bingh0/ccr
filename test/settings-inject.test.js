'use strict';

// Phase 2 — statusLine injection. Mirrors features/statusline-injection.feature.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildStatusLineCommandInline,
  buildSettings,
  writeSettingsFile,
  cleanupSettingsFile,
} = require('../src/settings-inject.js');

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-test-'));
}

test('buildSettings: produces the statusLine command shape', () => {
  const s = buildSettings('whatever');
  assert.deepStrictEqual(s, { statusLine: { type: 'command', command: 'whatever' } });
});

test('inline command resolves node + ccr.js by path with statusline', () => {
  const cmd = buildStatusLineCommandInline({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    ccrJs: 'C:\\repo\\bin\\ccr.js',
  });
  assert.strictEqual(cmd, '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\bin\\ccr.js" statusline');
});

test('inline command embeds cleanly in settings JSON (round-trips)', () => {
  const cmd = buildStatusLineCommandInline({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    ccrJs: 'C:\\repo with space\\bin\\ccr.js',
  });
  const json = JSON.stringify(buildSettings(cmd));
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.statusLine.command, cmd);
  assert.strictEqual(parsed.statusLine.type, 'command');
});

test('writeSettingsFile writes ccr-settings-*.json under the temp dir (@AC8)', () => {
  const dir = freshTmpDir();
  try {
    const settings = buildSettings('node ccr.js statusline');
    const file = writeSettingsFile(settings, { tmpDir: dir });
    assert.ok(file.startsWith(dir), 'file is under the temp dir, never ~/.claude');
    assert.match(path.basename(file), /^ccr-settings-[0-9a-f]+\.json$/);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(onDisk, settings);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSettingsFile uses a unique name per call', () => {
  const dir = freshTmpDir();
  try {
    const a = writeSettingsFile(buildSettings('x'), { tmpDir: dir });
    const b = writeSettingsFile(buildSettings('x'), { tmpDir: dir });
    assert.notStrictEqual(a, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupSettingsFile removes the temp file (@AC8)', () => {
  const dir = freshTmpDir();
  try {
    const file = writeSettingsFile(buildSettings('x'), { tmpDir: dir });
    assert.ok(fs.existsSync(file));
    cleanupSettingsFile(file);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupSettingsFile is best-effort and never throws on a missing file', () => {
  assert.doesNotThrow(() => cleanupSettingsFile(path.join(os.tmpdir(), 'ccr-settings-does-not-exist.json')));
});
