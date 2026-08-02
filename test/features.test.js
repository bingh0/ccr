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

runFeatures(path.join(__dirname, '..', 'features'), STEP_DEFINERS, { wip: ['pane-blobs'] });
