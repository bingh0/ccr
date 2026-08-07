// @ts-check
'use strict';
// scripts/release-gate.js — refuse to publish while a whole product surface
// has acceptance criteria that have never executed.
//
// This is ported from a sibling project, which learned it the expensive way. Its
// 0.0.9-beta added `journal-install.feature` and shipped in the same commit
// with all thirteen of its scenarios unbound; five field-reported defects then
// walked past a suite containing prose describing every one of them. The debt
// register was honest throughout — it said "awaiting the binding wave".
// Nothing required anyone to read it before cutting the release.
//
// ccr carries the same hazard with more consequence, because ccr actually
// publishes: a version on npm reaches people who did not read the feature
// files. `runFeatures` already ratchets the wip list in both directions, so
// the list cannot rot — but a green suite with a whole feature held open is
// still green, and green is what people check before publishing.
//
// It is not a veto. Some releases genuinely do not touch the unbound surface,
// and the owner is entitled to say so. It only demands that saying so be
// deliberate and on the record for THAT release:
//
//   CCR_RELEASE_ACCEPTS_UNBOUND="git-pane-safety" npm publish
//
// Each named feature must match a ruling. Naming one that is not ruled (or
// misspelling one) fails rather than silently waving everything through, and
// a bare `=1` catch-all is deliberately unsupported: the override has to name
// what is being accepted.

const { WHOLE_FEATURE_WIP } = require('../test/wip-register');

const ENV_KEY = 'CCR_RELEASE_ACCEPTS_UNBOUND';

function main() {
  if (WHOLE_FEATURE_WIP.length === 0) {
    console.log('release-gate: no whole-feature wip rulings — every feature surface is bound.');
    return;
  }

  const accepted = (process.env[ENV_KEY] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ruled = new Set(WHOLE_FEATURE_WIP.map((r) => r.feature));
  const unknown = accepted.filter((a) => !ruled.has(a));
  if (unknown.length > 0) {
    console.error(`release-gate: ${ENV_KEY} names features with no whole-feature ruling: ${unknown.join(', ')}`);
    console.error(`             ruled surfaces are: ${[...ruled].join(', ')}`);
    process.exit(1);
  }

  const blocking = WHOLE_FEATURE_WIP.filter((r) => !accepted.includes(r.feature));
  if (blocking.length === 0) {
    console.log(`release-gate: proceeding — this release accepts ${accepted.join(', ')} as unbound.`);
    return;
  }

  console.error('release-gate: REFUSING to publish.\n');
  console.error('These product surfaces have acceptance criteria that have never executed:\n');
  for (const r of blocking) {
    console.error(`  ${r.feature}   (ruled ${r.ruledOn})`);
    console.error(`    ${r.reason}\n`);
  }
  console.error('Bind the feature, or state that this release does not need it:\n');
  console.error(`  ${ENV_KEY}="${blocking.map((r) => r.feature).join(',')}" npm publish\n`);
  process.exit(1);
}

main();
