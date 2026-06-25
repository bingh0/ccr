// @ts-check
'use strict';

// src/settings-inject.js — per-launch statusLine injection (SPEC §4.2 step 5, §5.3).
//
// Claude Code must call `ccr statusline` on every status tick WITHOUT mutating
// any file under ~/.claude. We achieve that exactly like upstream launch.sh:
// write a throwaway settings object to a temp file and pass it to
// `claude --settings <file>`. A FILE (not inline --settings '{...}') sidesteps
// the Windows command-line JSON-quoting minefield.
//
// The statusLine `command` value is the inline form: node + bin/ccr.js resolved
// by absolute path. Because it lives inside the JSON settings file (never on a
// shell line), no shell-quoting is involved and no separate shim file is needed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Inline statusLine command: resolve node + ccr.js by path. Quoting is safe
 * because this value lives inside the JSON settings FILE, not on a shell line.
 *
 * @param {{ node: string, ccrJs: string }} o
 * @returns {string}
 */
function buildStatusLineCommandInline(o) {
  return `"${o.node}" "${o.ccrJs}" statusline`;
}

/**
 * The settings object Claude Code consumes via --settings.
 *
 * @param {string} command the statusLine command value
 * @returns {{ statusLine: { type: 'command', command: string } }}
 */
function buildSettings(command) {
  return { statusLine: { type: 'command', command } };
}

/**
 * Write the settings object to a uniquely-named temp file and return its path.
 * The file lives under the temp dir only — never under ~/.claude.
 *
 * @param {object} settings
 * @param {{ tmpDir?: string, rand?: string }} [opts]
 * @returns {string} absolute path to the written settings file
 */
function writeSettingsFile(settings, opts = {}) {
  const dir = opts.tmpDir || os.tmpdir();
  const rand = opts.rand || crypto.randomBytes(4).toString('hex');
  const file = path.join(dir, `ccr-settings-${rand}.json`);
  fs.writeFileSync(file, JSON.stringify(settings), { encoding: 'utf8' });
  return file;
}

/**
 * Best-effort removal of the temp settings file. Never throws.
 *
 * @param {string} file
 * @returns {void}
 */
function cleanupSettingsFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best-effort: a leftover temp file is harmless.
  }
}

module.exports = {
  buildStatusLineCommandInline,
  buildSettings,
  writeSettingsFile,
  cleanupSettingsFile,
};
