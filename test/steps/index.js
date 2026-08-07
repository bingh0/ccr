// @ts-check
// test/steps/index.js
// Maps each feature file (by basename) to the step definitions it runs against.
//
// Steps are SCOPED PER FEATURE: features.test.js builds a fresh StepRegistry per
// feature and applies only that feature's definer, so one feature's step
// patterns can never match another feature's steps. This removes the global
// step namespace entirely — no cross-feature collisions, no dependence on
// registration order. (Intra-file ambiguity is still possible within a single
// steps file; features.test.js asserts against it.)
//
// Note: every *.steps.js module here is also auto-discovered by `node --test`
// as a test file (it lives under test/) and shows as a passing file with zero
// assertions. That's expected and harmless — the real assertions run via the
// feature scenarios in features.test.js.

const defineLivenessSteps = require('./liveness.steps');
const defineBurnSteps = require('./burn.steps');
const defineEconomySteps = require('./economy.steps');
const defineTranscriptSteps = require('./transcripts.steps');
const defineFeedSteps = require('./feed.steps');
const defineResumeSteps = require('./resume.steps');
const defineStatuslineSteps = require('./statusline.steps');
const defineWindowsLauncherSteps = require('./windows-launcher.steps');
const defineWtArgsBuilderSteps = require('./wt-args-builder.steps');
const defineStatuslineInjectionSteps = require('./statusline-injection.steps');
const defineSidecarHostingSteps = require('./sidecar-hosting.steps');
const defineDoctorWindowsSteps = require('./doctor-windows.steps');
const defineFallbackNoWtSteps = require('./fallback-no-wt.steps');
const defineVscodeSidecarSteps = require('./vscode-sidecar.steps');
const defineAccountLimitsSteps = require('./account-limits.steps');
const definePaneConfigSteps = require('./pane-config.steps');
const definePaneBlobsSteps = require('./pane-blobs.steps');
const defineInstanceSlotsSteps = require('./instance-slots.steps');
const defineInstanceLifecycleSteps = require('./instance-lifecycle.steps');
const defineInstanceMigrationSteps = require('./instance-migration.steps');
const defineInstanceNamingSteps = require('./instance-naming.steps');
const defineInstanceIdentitySteps = require('./instance-identity.steps');
const defineInstanceResolutionSteps = require('./instance-resolution.steps');
const defineInstancePersistenceSteps = require('./instance-persistence.steps');
const defineGitRepoIdentitySteps = require('./git-repo-identity.steps');
const defineGitPanePlacementSteps = require('./git-pane-placement.steps');
const defineGitWorkingTreeSteps = require('./git-working-tree.steps');
const defineGitCommitGraphSteps = require('./git-commit-graph.steps');
const defineGitPaneSafetySteps = require('./git-pane-safety.steps');
const defineSidecarHotkeysSteps = require('./sidecar-hotkeys.steps');

/**
 * Feature-file basename → its step definer. A feature with no entry here runs
 * with an empty registry, so its scenarios surface as TODO until steps land.
 * @type {Record<string, (registry: import('../gherkin').StepRegistry) => any>}
 */
module.exports = {
  'liveness': defineLivenessSteps,
  'burn-rate': defineBurnSteps,
  'economy': defineEconomySteps,
  'transcripts': defineTranscriptSteps,
  'feed': defineFeedSteps,
  'resume': defineResumeSteps,
  'statusline': defineStatuslineSteps,
  'windows-launcher': defineWindowsLauncherSteps,
  'wt-args-builder': defineWtArgsBuilderSteps,
  'statusline-injection': defineStatuslineInjectionSteps,
  'sidecar-hosting': defineSidecarHostingSteps,
  'doctor-windows': defineDoctorWindowsSteps,
  'fallback-no-wt': defineFallbackNoWtSteps,
  'vscode-sidecar': defineVscodeSidecarSteps,
  'account-limits': defineAccountLimitsSteps,
  'pane-config': definePaneConfigSteps,
  'pane-blobs': definePaneBlobsSteps,
  'instance-slots': defineInstanceSlotsSteps,
  'instance-lifecycle': defineInstanceLifecycleSteps,
  'instance-migration': defineInstanceMigrationSteps,
  'instance-naming': defineInstanceNamingSteps,
  'instance-identity': defineInstanceIdentitySteps,
  'instance-resolution': defineInstanceResolutionSteps,
  'instance-persistence': defineInstancePersistenceSteps,
  'git-repo-identity': defineGitRepoIdentitySteps,
  'git-pane-placement': defineGitPanePlacementSteps,
  'git-working-tree': defineGitWorkingTreeSteps,
  'git-commit-graph': defineGitCommitGraphSteps,
  'git-pane-safety': defineGitPaneSafetySteps,
  'sidecar-hotkeys': defineSidecarHotkeysSteps,
};
