// @ts-check
// test/steps-design/index.js
// Maps each design-tier feature file (by basename) to its step definer, the
// same shape test/steps/index.js gives the product tier. The two maps stay
// separate because the tiers are separate: features/ is the visionary's review
// contract, features/design/ is the build holding itself to formats and
// arithmetic no visionary should be asked to review.

const defineGitIndexFormatSteps = require('./git-index-format.steps');
const defineGitObjectStoreSteps = require('./git-object-store.steps');
const defineGitWorkingTreeRulesSteps = require('./git-working-tree-rules.steps');

/** @type {Record<string, (registry: import('../gherkin').StepRegistry) => any>} */
module.exports = {
  'git-index-format': defineGitIndexFormatSteps,
  'git-object-store': defineGitObjectStoreSteps,
  'git-working-tree-rules': defineGitWorkingTreeRulesSteps,
};
