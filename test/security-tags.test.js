// @ts-check
'use strict';
// test/security-tags.test.js — the @security gate.
//
// A @security scenario is one that holds a trust boundary rather than the look
// of a pane: control bytes never becoming terminal control, a symlink never
// being followed, a blob never reaching a key binding. Those are the scenarios
// whose failure is a vulnerability rather than a cosmetic regression, so they
// get a stronger promise than the rest of the suite:
//
//   1. Every step of every @security scenario BINDS — even while its feature is
//      listed in `wip`. `wip` exists so a feature can be specified before it is
//      built, and it switches the unbound-step ratchet off for the whole file.
//      A gate that `wip` can switch off is not a gate, so this test reads the
//      feature files itself and ignores `wip` entirely.
//
//   2. No @security scenario carries @skip or @todo. Silencing a security
//      scenario has to be a visible act — deleting the @security tag, in a diff
//      someone reviews — not a quiet tag that reads like housekeeping.
//
// This lives in ccr rather than in the gherkin runner on purpose: test/gherkin.js
// is a MIRROR of gherkin-node-test (docs/GHERKIN.md's re-sync rule), and
// "@security is unskippable" is ccr's policy, not Gherkin semantics. Upstreaming
// it would fork the mirror for every other consumer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseFeature, StepRegistry } = require('./gherkin');
const STEP_DEFINERS = require('./steps');

const FEATURES_DIR = path.join(__dirname, '..', 'features');

/** Every feature file, parsed, with its basename. */
function allFeatures() {
  return fs.readdirSync(FEATURES_DIR)
    .filter((f) => f.endsWith('.feature'))
    .map((f) => ({
      basename: path.basename(f, '.feature'),
      file: f,
      feature: parseFeature(fs.readFileSync(path.join(FEATURES_DIR, f), 'utf8')),
    }));
}

/** Scenarios tagged @security, flattened across every feature. */
function securityScenarios() {
  /** @type {Array<{ basename: string, file: string, scenario: any, feature: any }>} */
  const out = [];
  for (const { basename, file, feature } of allFeatures()) {
    for (const scenario of feature.scenarios) {
      if (scenario.tags.includes('@security')) out.push({ basename, file, scenario, feature });
    }
  }
  return out;
}

test('@security scenarios exist and are found by the gate', () => {
  // A gate that silently matches nothing passes forever. Pin that it is live.
  const found = securityScenarios();
  assert.ok(found.length >= 10,
    `expected the security-tagged corpus to be substantial, found ${found.length}`);
});

test('every @security scenario has all of its steps bound — even under wip', () => {
  /** @type {string[]} */
  const unbound = [];
  for (const { basename, file, scenario, feature } of securityScenarios()) {
    const definer = STEP_DEFINERS[basename];
    if (!definer) {
      unbound.push(`${file}: "${scenario.name}" — no step definer registered for this feature at all`);
      continue;
    }
    const registry = new StepRegistry();
    definer(registry);
    // Background steps run before every scenario, so they are part of the
    // scenario's promise and must bind too.
    const background = (feature.background && feature.background.steps) || [];
    for (const step of [...background, ...scenario.steps]) {
      if (!registry.find(step.text)) unbound.push(`${file}: "${scenario.name}" → ${step.text}`);
    }
  }
  assert.deepStrictEqual(unbound, [],
    'a @security scenario with an unbound step is an unkept promise: it reads as coverage '
    + 'in the feature file while asserting nothing. Bind the step, or drop the @security tag '
    + 'deliberately — never leave it dangling.');
});

test('no @security scenario is skipped or marked todo', () => {
  /** @type {string[]} */
  const silenced = [];
  for (const { file, scenario } of securityScenarios()) {
    for (const tag of ['@skip', '@todo']) {
      if (scenario.tags.includes(tag)) silenced.push(`${file}: "${scenario.name}" carries ${tag}`);
    }
  }
  assert.deepStrictEqual(silenced, [],
    'silencing a security scenario must be a visible act — remove the @security tag in a '
    + 'diff a human reviews, rather than muting it with @skip/@todo.');
});
