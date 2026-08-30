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
// EVERY BRANCH, NOT JUST ONE. An alternation is where this discipline is
// easiest to fake, and the first pass here did fake it: `/child_process|sqlite/`
// witnessed by a file containing `child_process` satisfies a naive control
// while `sqlite` stays completely unproven — free to be misspelt from the day
// it was written. An audit of the first 36 controls found 6 in exactly that
// state, with 10 unproven branches between them. So the check below splits the
// needle on its top-level alternation and requires the witness to prove EACH
// branch. A composite witness is the normal answer: concatenate the sources
// that really contain each token.
//
// Choose witnesses as evidence, not decoration: the real module that does the
// thing, the real fixture field whose value must not reach the frame. A witness
// written to match by construction proves only that the regex compiles. Some
// tokens have no instance anywhere in this repository (`readline`, `execSync`,
// `globSync`, `sqlite`, `list-panes`) — for those a spelled-out literal is the
// honest best available, and call sites say so where they use one.

const assert = require('node:assert');

/** A regex is reusable only without /g — `test` is stateful with it. */
const stateless = (/** @type {RegExp} */ re) =>
  (re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re);

/**
 * Split a regex source on its TOP-LEVEL `|`, leaving alternations nested inside
 * groups and character classes alone.
 * @param {string} src
 * @returns {string[]}
 */
function topLevelBranches(src) {
  /** @type {string[]} */ const out = [];
  let depth = 0, inClass = false, cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[i + 1] || ''); i++; continue; }
    if (inClass) { inClass = c !== ']'; cur += c; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Assert that `needle` is absent from `subject`, having first proved on
 * `witness` that every branch of it can still be found at all.
 *
 * @param {RegExp | string} needle   what must be absent
 * @param {string} subject           the text it must be absent from
 * @param {string} witness           a string that MUST contain it — the control arm
 * @param {string} message           what the absence means, for the failure
 */
function refuteWithControl(needle, subject, witness, message) {
  const re = typeof needle === 'string' ? null : stateless(needle);
  const hits = (/** @type {string} */ s) => (re ? re.test(s) : s.includes(String(needle)));

  // The control arm, branch by branch.
  const branches = re ? topLevelBranches(re.source) : [String(needle)];
  const unproven = branches.filter((b) => {
    if (!re) return !witness.includes(b);
    try { return !new RegExp(b, re.flags).test(witness); } catch { return true; }
  });
  assert.deepStrictEqual(unproven, [],
    `control arm: these branches of ${needle} no longer match their witness, so the `
    + 'refusal below proves nothing about them — widen the witness to cover each '
    + 'branch, or fix the needle. Never delete the branch to make this pass.');

  assert.ok(!hits(subject), message);
}

module.exports = { refuteWithControl, topLevelBranches };
