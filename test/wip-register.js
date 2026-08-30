// @ts-check
'use strict';
// test/wip-register.js — the debt register, and the rulings behind it.
//
// `runFeatures` already ratchets `wip` in both directions: an unbound step
// outside the list fails the suite, and an entry whose feature has become
// fully bound fails until it is removed. That keeps the list HONEST. What it
// cannot do is make anyone READ the list before cutting a release.
//
// The distinction this file exists for: a scenario-scoped entry is ordinary
// debt — some of a feature is bound, some is not. A WHOLE-FEATURE entry is a
// different animal. It means an entire surface of the product has acceptance
// criteria that have never executed, which is the same thing as saying the
// feature does not exist. Publishing a version while one stands ships prose
// describing behavior users do not have.
//
// So a whole-feature entry costs a written ruling here, and scripts/release-gate.js
// refuses to publish while one exists unless the release names it as acceptable.
// This list is the single source: test/features.test.js feeds it straight to
// the runner, so the register and the allowlist cannot drift apart.

/**
 * @typedef {object} WholeFeatureWipRuling
 * @property {string} feature   Feature file stem, e.g. 'git-repo-identity'.
 * @property {string} reason    Why the whole surface is unbound, and what would end it.
 * @property {string} ruledOn   ISO date the ruling was made or last reaffirmed.
 */

/** @type {WholeFeatureWipRuling[]} */
const WHOLE_FEATURE_WIP = [
  // The git pane: reviewed scope, now part-built. A /scope interview on
  // 2026-08-04 produced five files and the fence beside them
  // (features/OUT-OF-SCOPE.md). They are here rather than absent because the
  // criteria are agreed and worth holding the build to — but agreed criteria
  // are not a feature, and the difference is exactly what a release must not
  // blur. Entries leave as their steps bind; the runner fails a stale one, so
  // this list cannot quietly outlive the debt it records.
  //
  // 'git-repo-identity' left the register on 2026-08-05: src/git-repo.js reads
  // the repository and the pane renders through composeFrame's own view cycle.
  // 'git-pane-placement' left it the same day — the pane is really in the shared
  // draw loop and cycling reaches it. One of its scenarios remains, as ordinary
  // scenario-scoped debt below.
  // 'git-working-tree' left the register on 2026-08-06: the section is built
  // and its steps bind through composeFrame's own view cycle.
  // 'git-commit-graph' left it the same day — the graph draws below the list,
  // lanes and all, and the long-list scenario bound with it.
  // 'git-pane-safety' left last, deliberately: its bindings carry the four
  // @security tags the scoping record owed, so the entry least safe to waive
  // ended as the promise hardest to silence (security-tags.test.js).
  // The instance layout: scoped 2026-08-06 (six files, fence appended to
  // features/OUT-OF-SCOPE.md). This is the 0.4.0 contract — the multi-instance
  // fix ships slots and the container layout together, so none of these may be
  // waived individually at release: publishing with any of them unbound ships
  // the bug the release exists to fix.
  //
  // The subagent observability views: scoped 2026-08-23 (three files, fence
  // section "The subagent observability views" in features/OUT-OF-SCOPE.md).
  // Post-0.5.0 feature work; no release coupling ruled, but same logic as the
  // git pane applies — agreed criteria are worth holding the build to, and
  // agreed criteria are not a feature. Entries leave as their steps bind.
  {
    feature: 'subagents-view',
    reason: 'The S2 roster view is unbuilt; steps bind when src/sidecar renders agent blocks from Claude Code transcripts.',
    ruledOn: '2026-08-23',
  },
  {
    feature: 'subagent-mirror',
    reason: 'ccr subagents does not exist yet; steps bind with the CLI command and its JSON output.',
    ruledOn: '2026-08-23',
  },
  {
    feature: 'subagent-channels',
    reason: 'Fail-open transcript parsing is unbuilt; steps bind with the derivation layer they pin.',
    ruledOn: '2026-08-23',
  },
];

/**
 * @typedef {object} ScenarioWipEntry
 * @property {string} feature    Feature file stem.
 * @property {string[]} scenarios  Source titles still unbound.
 * @property {string} reason     Why these scenarios and not the feature.
 */

/**
 * ORDINARY DEBT: a feature whose surface exists and is bound, minus named
 * scenarios. Unlike a whole-feature entry this does NOT block a release — the
 * feature is real, some of its criteria are still owed — so these carry a
 * reason rather than a ruling. The runner ratchets them exactly as hard: a
 * title that has since bound fails the suite until it is removed here.
 *
 * @type {ScenarioWipEntry[]}
 */
const SCENARIO_WIP = [
  // git-pane-placement's change-count isolation scenario bound on 2026-08-06,
  // with the working-tree section it was waiting for; the long-list scenario
  // bound the same day, with the commit graph its final Then draws.
];

/** Feature stems carrying a whole-feature ruling, for the runner's wip list. */
const wholeFeatureWip = () => WHOLE_FEATURE_WIP.map((r) => r.feature);

/** Scenario-scoped debt in the shape `runFeatures` takes. */
const scenarioWip = () => SCENARIO_WIP.map((e) => ({ feature: e.feature, scenarios: e.scenarios }));

module.exports = { WHOLE_FEATURE_WIP, wholeFeatureWip, SCENARIO_WIP, scenarioWip };
