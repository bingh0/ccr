// @ts-check
// test/features.test.js
// Executes the Gherkin acceptance criteria in features/ via the zero-dep
// harness. EVERY features/*.feature is discovered (never a hardcoded list, so a
// new feature file can't be silently left out), and each runs against its OWN
// scoped registry — step definitions never leak between features.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { StepRegistry, runFeatureFile, parseFeature } = require('./gherkin');
const STEP_DEFINERS = require('./steps');

const FEATURES_DIR = path.join(__dirname, '..', 'features');

for (const file of fs.readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.feature')).sort()) {
  const base = file.replace(/\.feature$/, '');
  const featureFile = path.join(FEATURES_DIR, file);

  // Fresh registry per feature, populated only with this feature's steps.
  const registry = new StepRegistry();
  const definer = STEP_DEFINERS[base];
  if (definer) definer(registry);

  // Guard: within this feature, every step must resolve to exactly one
  // definition. Catches intra-file ambiguity loudly and located, instead of
  // silently taking whichever pattern registered first.
  test(`${base} :: step definitions are unambiguous`, () => {
    const parsed = parseFeature(fs.readFileSync(featureFile, 'utf8'));
    const steps = [...parsed.background, ...parsed.scenarios.flatMap((s) => s.steps)];
    const ambiguous = steps
      .filter((s) => registry.steps.filter((d) => s.text.match(d.re)).length > 1)
      .map((s) => `"${s.text}"`);
    assert.strictEqual(ambiguous.length, 0, `steps matching >1 definition: ${ambiguous.join('; ')}`);
  });

  runFeatureFile(featureFile, registry);
}
