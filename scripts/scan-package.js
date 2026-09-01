#!/usr/bin/env node
// @ts-check
'use strict';
// scripts/scan-package.js — scan what npm would actually SHIP.
//
// The history scan (scripts/history-privacy.js) answers "which commits would this
// release newly publish". It does not answer "what is in the tarball", and the
// two are different sets of bytes: `files` in package.json decides the second,
// and a file can enter the package without any commit looking new. Nothing had
// ever looked at the artifact itself.
//
// Same detectors, same private supplement, same baseline rule as the history
// scan — whatever the published tree already contains is already public and is
// not news, which is why the npm contact alias in package.json is silent here
// and would start speaking the moment it appeared somewhere it had not been.
//
// The file list comes from `npm pack --dry-run --json`, which is npm's own
// answer rather than this script's guess at how `files` resolves.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DETECTORS, loadPrivatePatterns, baselineLiterals } = require('./history-privacy');
const { discoverRepo } = require('../src/git-repo');
const { resolveRef, readObject } = require('../src/git-objects');

const DEFAULT_PUBLIC_REF = 'refs/remotes/origin/main';
const ROOT = path.join(__dirname, '..');

// npm has shipped THREE shapes for `npm pack --json`: a bare entry object, a
// one-element array of entries, and — since npm 12 — an object KEYED BY
// PACKAGE NAME. Reaching for `.files` on the wrong one yields undefined, and
// the scan below then walks an empty list and prints "clean". That is exactly
// what happened: on npm 12 this scan examined ZERO files while reporting the
// tarball clean, through the 0.6.0 publish. So unwrap all three shapes by
// looking for the entry that actually carries a files array.
/** @param {any} parsed @returns {any} the entry carrying `files`, or null */
function packEntry(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidates = Array.isArray(parsed) ? parsed : [parsed, ...Object.values(parsed)];
  return candidates.find((c) => c && Array.isArray(c.files)) || null;
}

/** The files npm would pack, asked of npm. */
function packedFiles() {
  // npm on Windows is npm.cmd, and Node refuses to execute a .cmd without a
  // shell — spawnSync returns status null and the scan cannot say which files
  // ship. These three arguments are fixed literals with no metacharacters, so
  // the cmd quote-break risk src/launch-vscode.js guards against cannot arise
  // here. Reported as `exited null` before, which named nothing: an error the
  // scan cannot explain is the one it most needs to.
  // The two-branch shape src/launch-vscode.js uses: a command STRING under the
  // shell, an args array without it. Passing an args array alongside
  // shell:true is deprecated (DEP0190) precisely because the arguments are
  // concatenated rather than escaped.
  const r = process.platform === 'win32'
    ? spawnSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const why = (r.error && r.error.message)
      || (r.stderr || '').trim()
      || `npm pack exited ${r.status} (the process did not run)`;
    return { ok: false, files: [], why };
  }
  try {
    const entry = packEntry(JSON.parse(r.stdout));
    const files = entry ? entry.files.map((/** @type {any} */ f) => f.path) : [];
    // A package always packs something. An empty list means the shape was not
    // understood, and a scan that read nothing must REFUSE, never report clean.
    if (files.length === 0) {
      return { ok: false, files: [], why: 'npm pack --json named no files — unrecognised output shape' };
    }
    return { ok: true, files, why: '' };
  } catch (e) {
    return { ok: false, files: [], why: e instanceof Error ? e.message : String(e) };
  }
}

/** Whatever the published tree already says is already public. */
function publishedLiterals() {
  const repo = discoverRepo(ROOT);
  if (!repo.found || !repo.gitDir) return { available: false, literals: new Set() };
  const published = resolveRef(repo.gitDir, DEFAULT_PUBLIC_REF);
  if (published === null) return { available: false, literals: new Set() };
  // A ref resolves to a COMMIT; baselineLiterals walks a TREE. Passing the
  // commit through silently produces an EMPTY baseline — the check then
  // reports everything, including strings that are already public, which is
  // how a scan that means well becomes a scan nobody believes.
  const obj = readObject(repo.gitDir, published);
  if (obj === null || obj.type !== 'commit') return { available: false, literals: new Set() };
  const m = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(
    obj.data.toString('latin1', 0, Math.min(obj.data.length, 256)));
  if (!m) return { available: false, literals: new Set() };
  return { available: true, literals: baselineLiterals(repo.gitDir, m[1]) };
}

function main() {
  const pack = packedFiles();
  if (!pack.ok) {
    console.error(`scan-package: REFUSING — could not determine what npm would pack: ${pack.why}`);
    return 1;
  }

  const priv = loadPrivatePatterns();
  if (priv.invalid.length > 0) {
    console.error(`scan-package: REFUSING — unparseable private patterns in ${priv.source}:`);
    for (const s of priv.invalid) console.error(`               ${s}`);
    return 1;
  }

  const base = publishedLiterals();
  /** @type {string[]} */
  const findings = [];

  for (const rel of pack.files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const d of DETECTORS) {
      for (const hit of d.extract(text)) {
        if (base.literals.has(hit)) continue;          // already public, not news
        findings.push(`  ${rel}: ${hit} — ${d.why}`);
      }
    }
    // Supplement hits ignore the baseline: those are never acceptable, whether
    // or not they are already out there.
    for (const re of priv.patterns) {
      if (re.test(text)) findings.push(`  ${rel}: matches the private pattern ${re}`);
    }
  }

  const supplement = priv.configured
    ? `private patterns from ${priv.source}`
    : 'NO private pattern list configured — generic detectors only';
  const baseline = base.available
    ? `baseline ${DEFAULT_PUBLIC_REF}`
    : `NO baseline — ${DEFAULT_PUBLIC_REF} did not resolve, so nothing counts as already-public`;

  if (findings.length === 0) {
    console.log(`scan-package: package scan clean — ${pack.files.length} file(s); ${supplement}; ${baseline}.`);
    return 0;
  }

  console.error('scan-package: REFUSING to publish.\n');
  console.error('These strings would ship in the tarball and the published tree does not');
  console.error('already contain them:\n');
  for (const f of findings) console.error(f);
  console.error('\nThe tarball is what reaches people who never read the repository.\n');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { packedFiles, packEntry };
