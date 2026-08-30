// @ts-check
'use strict';
// test/steps/_absence.js — absence, earned.
//
// gherkin-node-test 0.11.0 names the asymmetry this file exists to answer
// (docs/workflow.md, from @llowrey's step-fidelity audit):
//
//   Positive assertions fail loud; negative assertions fail silent;
//   absence must be earned.
//
// The two directions are not mirror images. `assert.match(src, /child_process/)`
// with a misspelt needle fails on the first run and names itself. Its negation,
// `assert.ok(!/child_proces/.test(src))`, passes — and keeps passing for years
// while the capability it denies sits in the file under the right spelling.
// Every structural guarantee in this suite is of the second shape: the pane
// renderer spawns nothing, the launcher reads no blob, pane-config probes no
// directory. Those are the assertions whose silence is worth the least.
//
// So a refusal here carries a CONTROL: the same predicate, run first against a
// witness that does contain the thing being denied. One hand-built mutant,
// executed on every run — mutation testing miniaturised to a single assertion.
// When the needle rots, the control goes red and says so, instead of the
// refusal quietly becoming true.
//
// The witness is the argument that does the work, so choose it as evidence, not
// as decoration: the real string the forbidden code would contain, the real
// fixture field whose value must not reach the frame. A witness written to
// match the needle by construction (`'child_process'` for /child_process/)
// proves only that the regex compiles. Prefer one taken from the world the
// subject came from.

const assert = require('node:assert');

/** A regex is reusable only without /g — `test` is stateful with it. */
const stateless = (/** @type {RegExp} */ re) =>
  (re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re);

/**
 * Assert that `needle` is absent from `subject`, having first proved on
 * `witness` that it can still be found at all.
 *
 * @param {RegExp | string} needle   what must be absent
 * @param {string} subject           the text it must be absent from
 * @param {string} witness           a string that MUST contain it — the control arm
 * @param {string} message           what the absence means, for the failure
 */
function refuteWithControl(needle, subject, witness, message) {
  const re = typeof needle === 'string' ? null : stateless(needle);
  const hits = (/** @type {string} */ s) => (re ? re.test(s) : s.includes(String(needle)));
  assert.ok(
    hits(witness),
    `control arm: ${needle} no longer matches its witness, so the refusal below `
    + 'proves nothing — fix the needle, not this line',
  );
  assert.ok(!hits(subject), message);
}

/**
 * The same discipline for a set of needles sharing one witness and one subject:
 * each is proved able to fire before it is refused.
 *
 * @param {Array<RegExp | string>} needles
 * @param {string} subject
 * @param {string} witness
 * @param {(needle: RegExp | string) => string} message
 */
function refuteAllWithControl(needles, subject, witness, message) {
  for (const n of needles) refuteWithControl(n, subject, witness, message(n));
}

module.exports = { refuteWithControl, refuteAllWithControl };
