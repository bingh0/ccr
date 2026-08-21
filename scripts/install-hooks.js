#!/usr/bin/env node
// @ts-check
'use strict';
// scripts/install-hooks.js — copy .githooks/* into this clone's .git/hooks.
//
// Git will not run hooks straight out of a tracked directory (core.hooksPath
// would, but it is per-clone configuration that a fresh clone does not have
// either, so it moves the problem rather than solving it). Copying is one
// command a contributor runs once, and it leaves the installed hook readable
// in the place people look for hooks.
//
// Why the hooks are tracked at all: pre-push was local-to-one-clone, which
// meant the guard against publishing private history did not survive re-cloning
// the repository it guards. There is nothing private in it.
//
// Usage:  npm run install-hooks

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, '.githooks');

/** The real hooks directory, asked of git rather than assumed (worktrees). */
function hooksDir() {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const p = r.stdout.trim();
  return path.isAbsolute(p) ? p : path.join(REPO, p);
}

function main() {
  const dest = hooksDir();
  if (!dest) {
    console.error('install-hooks: not a git repository (or git is unavailable) — nothing to install.');
    return 1;
  }
  let names;
  try {
    names = fs.readdirSync(SRC).filter((n) => !n.startsWith('.'));
  } catch {
    console.error(`install-hooks: no ${SRC} directory — nothing to install.`);
    return 1;
  }
  fs.mkdirSync(dest, { recursive: true });

  let installed = 0;
  for (const name of names) {
    const from = path.join(SRC, name);
    const to = path.join(dest, name);
    const wanted = fs.readFileSync(from);

    let existing = null;
    try { existing = fs.readFileSync(to); } catch { /* none yet */ }
    if (existing && existing.equals(wanted)) {
      console.log(`install-hooks: ${name} already current`);
      continue;
    }
    // Never destroy a hook someone wrote by hand. One backup slot, overwritten
    // on a second run — the first backup is the one worth keeping, because it
    // is the only one this script did not itself create.
    if (existing) {
      const backup = `${to}.replaced`;
      if (!fs.existsSync(backup)) {
        fs.writeFileSync(backup, existing);
        console.log(`install-hooks: kept the previous ${name} as ${path.basename(backup)}`);
      }
    }
    // 0o755: git runs it, and on Windows the mode is ignored rather than wrong.
    fs.writeFileSync(to, wanted, { mode: 0o755 });
    try { fs.chmodSync(to, 0o755); } catch { /* filesystem without modes */ }
    console.log(`install-hooks: installed ${name}`);
    installed++;
  }
  console.log(installed
    ? `install-hooks: ${installed} hook(s) installed into ${dest}`
    : 'install-hooks: nothing to do — every hook was already current');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { hooksDir };
