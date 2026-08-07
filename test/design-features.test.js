// @ts-check
// test/design-features.test.js
// Executes the DESIGN TIER: features/design/*.feature, the implementation
// contracts the product features deliberately do not carry (byte formats,
// budget arithmetic). Ratified in features/OUT-OF-SCOPE.md ("Deferred to the
// design tier"): its own runFeatures call, its own wip register, outside the
// visionary's review contract — the visionary reviews features/ and only
// features/.
//
// The wip list is inline and empty by design: this tier was created on
// 2026-08-06 WITH its first bindings, so unlike the product tier it has never
// had a bootstrap period. A design feature added ahead of its steps must
// either bind immediately or put its name here, visibly.

const path = require('node:path');
const { runFeatures } = require('./gherkin');
const DESIGN_STEP_DEFINERS = require('./steps-design');

runFeatures(path.join(__dirname, '..', 'features', 'design'), DESIGN_STEP_DEFINERS, {
  wip: [],
});
