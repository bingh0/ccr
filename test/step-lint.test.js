// @ts-check
// test/step-lint.test.js
// The binding side of the contract, gated.
//
// gherkin-node-test 0.11.0 ships `lintStepDefinitionSource`, the companion to
// the feature-file linter aimed at the other half: the step code. Its default
// rule, `unearned-absence`, fires on absence assertions whose needle is a
// string or regex LITERAL — the unfalsifiable class, where a wrong needle goes
// green forever while the thing it denies sits there under another name.
//
// The library is warn-class and never gates; whether to gate is the consumer's
// call, and ccr gates. The suite's structural guarantees — the renderer holds
// no keystroke capability, pane-config probes no directory, liveness never
// shells out — are all absence assertions, which makes their silence the least
// trustworthy thing in the repository. Every one of them now either earns its
// absence with a control (see test/steps/_absence.js) or carries a marker
// naming what proves the needle.
//
// SCAN ROOTS. Upstream's warning is that the one field incident behind this
// rule came from files OUTSIDE the lint's roots, so this scans the whole
// import closure of the step layer — test/steps, test/steps-design, and the
// shared helpers those import — not merely the *.steps.js files.
//
// Deliberately NOT scanned yet: the sibling *.test.js unit tests, which carry
// 32 findings of the same class as of 2026-09-01 (four arrived with the
// mosh/tmux work — three with the original PR, one with 0.6.1's single-quote
// guard; two are the optional-lookup shape, both mitigated by the positive
// beside them at launch-tmux-portability.test.js's Ms= extraction, which
// throws if the line goes missing). That is a real backlog, named
// here so it is not mistaken for clean. The one that mattered immediately was
// sidecar-capabilities.test.js, because pane-blobs.feature's steps delegate
// their global capability guarantee to it; it is sanctioned against its own
// control test and is scanned below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lintStepDefinitionSource } = require('./gherkin');

const ROOT = path.join(__dirname, '..');

// Repo-relative with forward slashes on every platform — the control below
// compares against 'test/steps/...' literals, and Windows' path.relative
// yields backslashes (the same trap test/sidecar-capabilities.test.js names).
const rel = (/** @type {string} */ f) => path.relative(ROOT, f).split(path.sep).join('/');

/** Every .js under a directory, recursively. */
function walk(/** @type {string} */ dir, /** @type {string[]} */ out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const ROOTS = ['test/steps', 'test/steps-design'];
const ALSO = [
  'test/_links.js',
  'test/privacy-fixtures.js',
  'test/wip-register.js',
  'test/sidecar-capabilities.test.js',
  // The anchor set for _absence.js itself: the file certifying the refusal
  // helper faces the same linter as the refusals it certifies.
  'test/absence.test.js',
];

const scanned = [
  ...ROOTS.flatMap((d) => walk(path.join(ROOT, d))),
  ...ALSO.map((f) => path.join(ROOT, f)),
].filter((f) => fs.existsSync(f)).sort();

test('every step-layer absence assertion is earned or sanctioned', () => {
  /** @type {string[]} */
  const findings = [];
  for (const file of scanned) {
    const name = rel(file);
    for (const f of lintStepDefinitionSource(fs.readFileSync(file, 'utf8'), name)) {
      findings.push(`${name}:${f.line} [${f.rule}] ${f.message}`);
    }
  }
  assert.deepStrictEqual(findings, [],
    'A negative assertion over a literal needle passes forever once the needle is '
    + 'wrong. Earn it with a control (test/steps/_absence.js refuteWithControl), '
    + 'rewrite it in the positive direction, or sanction it with a marker naming '
    + 'what proves the needle:\n// step-lint: allow <rule> -- <prover>');
});

// The roots themselves are a claim, and a claim that quietly stops being true
// is the same defect one level up: if the step layer were renamed or moved,
// the loop above would scan nothing and report clean.
test('the step-lint scan actually reaches the step layer', () => {
  assert.ok(scanned.length >= 40, `scanned only ${scanned.length} files — the roots are wrong`);
  const names = scanned.map(rel);
  for (const expected of [
    'test/steps/pane-blobs.steps.js',
    'test/steps/_absence.js',
    'test/steps-design/git-object-store.steps.js',
  ]) {
    assert.ok(names.includes(expected), `${expected} is not being scanned`);
  }
});
