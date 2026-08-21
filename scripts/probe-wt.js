#!/usr/bin/env node
// @ts-check
'use strict';
// scripts/probe-wt.js — measure what Windows Terminal ACTUALLY does with `-d`.
//
// Why this exists: `wt.exe` is the one part of ccr no test has ever executed.
// Every Windows test injects `spawnWt` (test/launch-win-run.test.js,
// test/steps/_win-helpers.js), so the suite proves the argv we assemble and
// nothing about whether Windows Terminal accepts it. The whole point of the
// `-d` launcher is a claim about a program we have never run.
//
// Three hypotheses were raised in review and left explicitly unverified, plus
// one that decides whether the feature is safe to ship at all:
//
//   * a UNC working directory may be REFUSED by cmd.exe, which then falls back
//     to %SystemRoot% — a divergence with no error text anywhere
//   * a path past MAX_PATH may do the same
//   * `wt` may expand environment strings inside `-d`
//   * a `-d` that wt REJECTS may cost the whole tab rather than just the
//     directory — that would be worse than the bug the flag was added to fix
//
// It also measures the two characters src/launch-win.js currently refuses
// (`;` and a backtick), because "we refuse it" and "it would actually break"
// are different claims and only one of them has been tested.
//
// Method: each case opens a tab whose entire job is `cd > <file>`. Whatever
// lands in that file is where the tab really started. A file that never
// appears is the answer to the fourth hypothesis — the tab never ran.
//
// Output is a markdown table, ready to paste into the tracking issue.
//
// Usage:  node scripts/probe-wt.js [--keep]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KEEP = process.argv.includes('--keep');
const BASE = path.join(os.tmpdir(), 'ccr-wt-probe');
const OUT = path.join(BASE, 'out');
const WAIT_MS = 15000;
const POLL_MS = 250;

/** @typedef {{ id: string, what: string, dir: string, note?: string, skip?: string }} Case */

/** Make a directory, reporting WHY it could not be made rather than throwing. */
function mkdir(/** @type {string} */ p) {
  try { fs.mkdirSync(p, { recursive: true }); return null; } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The fixtures. Each is a real directory except `missing`, which is the point.
 * @returns {Case[]}
 */
function buildCases() {
  /** @type {Case[]} */
  const cases = [];
  const add = (/** @type {string} */ id, /** @type {string} */ what, /** @type {string} */ dir, /** @type {string} */ note) => {
    const err = mkdir(dir);
    cases.push(err ? { id, what, dir, note, skip: `could not create the fixture: ${err}` } : { id, what, dir, note });
  };

  add('plain', 'an ordinary path', path.join(BASE, 'plain'), 'baseline — if this diverges, nothing else means anything');
  add('space', 'a path containing spaces', path.join(BASE, 'My Projects', 'app'), 'the common real case');
  add('percent', 'a literal % in the name', path.join(BASE, '%USERNAME%-test'), 'does wt expand environment strings inside -d?');
  add('semicolon', 'a semicolon in the name', path.join(BASE, 'semi;colon'), 'wt splits its own command line on `;` — ccr refuses this today');
  add('backtick', 'a backtick in the name', path.join(BASE, 'back`tick'), 'ccr refuses this today; wt is not PowerShell, so the refusal may be unearned');

  // Past MAX_PATH. Creating it may itself fail when long paths are disabled,
  // which is a finding rather than an error — the case reports why and moves on.
  let long = path.join(BASE, 'long');
  while (long.length < 275) long = path.join(long, 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwww');
  add('longpath', `a path of ${long.length} characters`, long, 'past MAX_PATH (260)');

  // UNC. The admin share needs elevation, so this reports as skipped rather
  // than failing the run — `net share probe=<dir>` and re-run is the way in.
  const unc = '\\\\localhost\\c$\\Windows';
  cases.push(fs.existsSync(unc)
    ? { id: 'unc', what: 'a UNC path', dir: unc, note: 'cmd.exe is believed to refuse a UNC cwd and fall back to %SystemRoot%' }
    : { id: 'unc', what: 'a UNC path', dir: unc, note: 'the hypothesis that matters most — it would be SILENT', skip: 'no access to \\\\localhost\\c$ (needs an elevated shell, or `net share probe=C:\\some\\dir` and edit this case)' });

  // Deliberately never created.
  cases.push({ id: 'missing', what: 'a directory that does not exist', dir: path.join(BASE, 'definitely-not-here'), note: 'does the TAB still open? if not, -d can cost more than the directory' });
  return cases;
}

/** Where a case writes what it found. */
const outFile = (/** @type {Case} */ c) => path.join(OUT, `${c.id}.txt`);

/**
 * Open one tab whose whole job is to record where it started.
 * `wt` returns as soon as it has handed off, so a 0 exit says nothing about
 * whether the tab ran — only the output file does.
 * @param {Case} c
 * @returns {string|null} spawn-level error, if the launcher itself refused
 */
function launch(c) {
  const r = spawnSync('wt', ['-w', '0', 'new-tab', '-d', c.dir, 'cmd', '/c', `cd > "${outFile(c)}"`], {
    encoding: 'utf8', windowsHide: false,
  });
  if (r.error) return r.error.message;
  if (r.status !== 0) return `wt exited ${r.status}${r.stderr ? ': ' + r.stderr.trim() : ''}`;
  return null;
}

/** Poll until every expected file has landed, or the deadline passes. */
function collect(/** @type {Case[]} */ cases) {
  const want = cases.filter((c) => !c.skip);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (want.every((c) => fs.existsSync(outFile(c)))) return;
    if (Date.now() >= deadline) return;
    // Synchronous sleep: this script is a sequence of blocking spawns, and an
    // async poll would only add a scheduler to something with nothing to do.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

/** Windows paths compare case-insensitively, and a trailing slash means nothing. */
function samePath(/** @type {string} */ a, /** @type {string} */ b) {
  const norm = (/** @type {string} */ s) => s.trim().replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The verdict for one case, as a pure function of what came back. Separated
 * from the run because this is the part that decides whether the feature is
 * safe to ship, and a diagnostic nobody can test is not evidence.
 *
 * @param {Case} c
 * @param {string|null|undefined} launchError the launcher's own refusal, if any
 * @param {string|null} fileContent what the tab wrote, or null if it never wrote
 * @returns {{ kind: 'skipped'|'no-tab'|'diverged'|'ok', reported: string, verdict: string }}
 */
function classify(c, launchError, fileContent) {
  if (c.skip) return { kind: 'skipped', reported: '—', verdict: `skipped — ${c.skip}` };
  if (launchError) return { kind: 'no-tab', reported: '—', verdict: `**launcher refused** — ${launchError}` };
  if (fileContent == null) {
    return { kind: 'no-tab', reported: '—', verdict: `**NO TAB** — nothing ran within ${WAIT_MS / 1000}s` };
  }
  const reported = fileContent.trim() || '(empty)';
  return samePath(reported, c.dir)
    ? { kind: 'ok', reported, verdict: 'ok — landed where asked' }
    : { kind: 'diverged', reported, verdict: '**DIVERGED**' };
}

function main() {
  if (process.platform !== 'win32') {
    console.error('probe-wt: this measures Windows Terminal, so it only means anything on Windows.');
    console.error(`probe-wt: (you are on ${process.platform})`);
    return 2;
  }
  if (spawnSync('where', ['wt'], { encoding: 'utf8' }).status !== 0) {
    console.error('probe-wt: wt.exe not found on PATH — install Windows Terminal (winget install Microsoft.WindowsTerminal).');
    return 2;
  }

  fs.rmSync(BASE, { recursive: true, force: true });
  mkdir(OUT);
  const cases = buildCases();

  console.log('probe-wt: opening one tab per case; each closes as soon as it has reported.\n');
  /** @type {Record<string, string>} */
  const launchErrors = {};
  for (const c of cases) {
    if (c.skip) continue;
    const err = launch(c);
    if (err) launchErrors[c.id] = err;
  }
  collect(cases);

  const rows = [];
  let diverged = 0;
  let noTab = 0;
  for (const c of cases) {
    let content = null;
    try { content = fs.readFileSync(outFile(c), 'utf8'); } catch { /* never wrote */ }
    const r = classify(c, launchErrors[c.id], content);
    if (r.kind === 'no-tab') noTab++;
    if (r.kind === 'diverged') diverged++;
    rows.push({ c, reported: r.reported, verdict: r.verdict });
  }

  console.log(`### \`wt -d\` probe — ${os.release()} / Windows Terminal\n`);
  console.log('| case | asked for | tab reported | verdict |');
  console.log('|---|---|---|---|');
  for (const { c, reported, verdict } of rows) {
    const cell = (/** @type {string} */ s) => String(s).replace(/\|/g, '\\|');
    console.log(`| \`${c.id}\` — ${cell(c.what)} | \`${cell(c.dir)}\` | \`${cell(reported)}\` | ${cell(verdict)} |`);
  }
  console.log('\n<details><summary>what each case is asking</summary>\n');
  for (const c of cases) if (c.note) console.log(`- \`${c.id}\`: ${c.note}`);
  console.log('\n</details>\n');

  // The reading, stated rather than left to the reader — a table of paths is
  // not an answer to "is this safe to ship".
  if (noTab) {
    console.log(`**${noTab} case(s) cost the whole tab.** A \`-d\` that wt rejects is worse than the bug`);
    console.log('`-d` was added to fix: 0.4.0 opens in the wrong directory, this opens nothing.');
  }
  if (diverged) {
    console.log(`**${diverged} case(s) landed somewhere else without saying so.** ccr writes the launch`);
    console.log('record from the same path it passes to `-d`, so for these the git pane will describe');
    console.log('a repository the terminal is not in, with no error text anywhere.');
  }
  if (!noTab && !diverged) console.log('**No divergence.** Every honoured `-d` landed where it was asked to.');
  console.log('\nPaste this table into https://github.com/bingh0/ccr/issues/6');

  if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });
  else console.log(`\n(fixtures kept at ${BASE})`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { classify, samePath, buildCases, BASE };
