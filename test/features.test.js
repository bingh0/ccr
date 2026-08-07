// @ts-check
// test/features.test.js
// Executes the Gherkin acceptance criteria in features/ via the zero-dep
// harness's high-level runner. runFeatures() discovers EVERY features/*.feature
// (never a hardcoded list, so a new feature file can't be silently left out),
// scopes each to its own step registry, and registers the guard tests: no
// ambiguous steps, no unbound steps (which would register as TODO — reported as
// PASSING by node:test), and no definer keys naming a missing feature file.
//
// A feature still being bootstrapped may allow TODO scenarios by listing its
// basename in `wip` — visible in this diff, never implicit.

const path = require('node:path');
const { runFeatures } = require('./gherkin');
const STEP_DEFINERS = require('./steps');
const { wholeFeatureWip, scenarioWip } = require('./wip-register');

// Whole-feature debt comes from the ruling register rather than a list written
// out here, so the names the runner holds open are exactly the names the
// release gate reads (scripts/release-gate.js). Two copies could disagree, and
// the copy that decides whether to publish is the one nobody looks at.
//
// Each name must still leave the register as its steps bind — the runner
// ratchets that in both directions, so a stale entry fails the suite.
//
// Scenario-scoped debt comes from the same register, in the runner's second wip
// shape. It is kept separate because the two mean different things: a whole
// -feature entry says a product surface has never executed and blocks a release;
// a scenario entry says a bound feature still owes some of its criteria.
runFeatures(path.join(__dirname, '..', 'features'), STEP_DEFINERS, {
  wip: [...wholeFeatureWip(), ...scenarioWip()],
});
