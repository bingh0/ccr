// @ts-check
'use strict';
// src/pane-config.js — where the list of pane blob paths comes from.
//
// RULED 2026-08-02 (the question left open since session e2994e0d):
//
//   Location: $XDG_CONFIG_HOME/ccr/config.json, defaulting to
//   ~/.config/ccr/config.json. Overridable by CCR_CONFIG for tests and for
//   users who keep dotfiles elsewhere.
//
//   NOT ccr's state dir (~/.ccr): that holds state ccr writes, and mixing
//   user-authored configuration into a directory the program rewrites invites
//   exactly one accident — clobbering it. NOT repo-local, ever: a config file
//   discovered by walking up from the working directory would let anyone who
//   can land a PR add a pane path to a teammate's sidecar. That is the same
//   reasoning that removed configurable prompt files (see the contract's
//   ruling log); config is the user's, and only the user's.
//
//   Format: JSON. ccr already parses JSON at every ingestion point, so this
//   adds no new parser and no new attack surface, and the verifier discipline
//   (whitelist-construct, types checked not coerced, total function) applies
//   here unchanged. A bespoke line format would need all of that written again.
//
//   Shape (v1):
//     { "panes": [ { "path": "~/code/app/.gherkin-trace/sidecar.json" } ] }
//
//   Entries are OBJECTS rather than bare strings so a later optional key is an
//   additive change rather than a format break. Order is significant (it is the
//   cycle order). Two entries naming the same path are two panes, per the
//   contract — this never de-duplicates.
//
// Config is trusted more than a blob (the user wrote it) but is still parsed
// defensively: a malformed config yields NO panes rather than throwing into
// the draw loop. The sidecar's own panel must survive a typo in a config file.

const path = require('node:path');
const os = require('node:os');
const { readTextCapped } = require('./safe-read');

/** Config is small; this is a sanity bound, not a policy. */
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * The config file path, without touching the filesystem.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function configPath(env) {
  const e = env || process.env;
  if (e.CCR_CONFIG) return e.CCR_CONFIG;
  const xdg = e.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'ccr', 'config.json');
}

/**
 * Expand a leading `~`, then resolve relative paths against `baseDir` — the
 * config file's own directory, per the contract ("a relative path resolves
 * against the config file's directory"). Resolving against the CWD instead
 * would make a pane's identity depend on where the sidecar happened to start.
 * @param {string} p
 * @param {string} baseDir
 * @param {string} home
 * @returns {string}
 */
function resolvePanePath(p, baseDir, home) {
  let out = p;
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = path.join(home, out.slice(2));
  return path.resolve(baseDir, out);
}

/**
 * Load the configured pane list. Never throws: a missing, unreadable, or
 * malformed config is "no panes configured", which renders as the plain
 * economy sidebar exactly as before this feature existed.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {{ panes: Array<{ path: string, source: string }>, configPath: string }}
 *   `path` is absolute and ready to read; `source` is the string the user wrote
 *   (what error states name, so the message matches their config, not ours).
 */
function loadPaneConfig(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const file = configPath(env);
  const empty = { panes: [], configPath: file };

  const raw = readTextCapped(file, MAX_CONFIG_BYTES);
  if (raw == null || !raw.trim()) return empty;

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.panes)) return empty;

  const baseDir = path.dirname(file);
  /** @type {Array<{ path: string, source: string }>} */
  const panes = [];
  for (const entry of parsed.panes) {
    // Whitelist-construct: read the one field v1 names, off a fresh object.
    // Never spread the entry — same rule the blob verifier follows.
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const source = entry.path;
    if (!source.trim()) continue;
    panes.push({ path: resolvePanePath(source, baseDir, home), source });
  }
  return { panes, configPath: file };
}

module.exports = { loadPaneConfig, configPath, resolvePanePath, MAX_CONFIG_BYTES };
