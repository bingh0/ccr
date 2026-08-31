// @ts-check
// test/absence.test.js — the anchor set for test/steps/_absence.js.
//
// refuteWithControl guards every structural refusal in the step layer, and its
// branch-by-branch control rides on topLevelBranches() — a hand-rolled parser
// of regex source that, until this file, was exercised only incidentally by
// its call sites. If that parser splits wrong, every control is silently
// under- or over-strict, which is the exact silent-green failure the helper
// exists to prevent. So the parser gets direct cases for each construct that
// could fool it, and the helper gets the doctrine's own treatment (see gnt
// docs/workflow.md): implant the broken input, watch the owning anchor go red.

const test = require('node:test');
const assert = require('node:assert');
const { refuteWithControl, topLevelBranches } = require('./steps/_absence');

test('topLevelBranches splits only a top-level alternation', () => {
  /** @type {[string, string[]][]} */
  const cases = [
    ['a|b', ['a', 'b']],
    ['child_process|sqlite', ['child_process', 'sqlite']],
    // escapes: an escaped pipe is content, an escaped backslash is not
    ['a\\|b', ['a\\|b']],
    ['a\\\\|b', ['a\\\\', 'b']],
    // groups of every kind keep their alternations to themselves
    ['(a|(b|c))', ['(a|(b|c))']],
    ['a(?:x|y)b|c', ['a(?:x|y)b', 'c']],
    ['(?!x|y)z', ['(?!x|y)z']],
    // character classes: pipes, escaped brackets, JS's empty-class quirk
    ['[a|b]', ['[a|b]']],
    ['[\\]|]a|b', ['[\\]|]a', 'b']],
    ['[]]a|b', ['[]]a', 'b']],
    ['[^]]a|b', ['[^]]a', 'b']],
    ['[(]a|b', ['[(]a', 'b']],
    // anchors travel with their branch; empty branches survive the split
    ['^a|b$', ['^a', 'b$']],
    ['a|', ['a', '']],
    ['|a', ['', 'a']],
  ];
  for (const [src, want] of cases) {
    assert.deepStrictEqual(topLevelBranches(src), want, `splitting ${src}`);
  }
});

test('every split branch, recompiled alone, matches what the alternation matched', () => {
  // The property the controls depend on: testing each branch separately is the
  // same check as testing the whole needle. A split through the middle of a
  // group or class would break it, and no hand-picked case list proves its own
  // completeness — so the cases above are backed by a differential sweep.
  const sources = [
    'a|b\\|c|[x|y]', '(p|q)|\\d+', '^s|e$', 'f(?:g|h)i|[\\]]',
    'send-keys -t \\.\\d|send-keys -t \\{', 'readdirSync|globSync|\\bglob\\(',
    "child_process|sqlite|require\\('node:(net|http|https|dgram|tls)'\\)",
  ];
  const probes = ['a', 'b|c', 'x', 'p', 'd5', 's', 'the e', 'fgi', 'fhi', ']',
    'send-keys -t .3', 'send-keys -t {', 'readdirSync', 'glob(', "require('node:tls')", 'zzz'];
  for (const src of sources) {
    const whole = new RegExp(src);
    const branches = topLevelBranches(src);
    for (const p of probes) {
      const union = branches.some((b) => new RegExp(b).test(p));
      assert.strictEqual(union, whole.test(p),
        `union of branches of /${src}/ disagrees with the alternation on ${JSON.stringify(p)}`);
    }
  }
});

test('the control arm goes red when any branch of the needle outruns its witness', () => {
  // The mutant, implanted: a witness proving child_process but not sqlite is
  // exactly the shape the first audit found in the wild six times.
  assert.throws(
    () => refuteWithControl(/child_process|sqlite/, 'clean subject',
      'this witness spawns via child_process only', 'must not appear'),
    /sqlite/,
    'an unproven branch must fail the control and name itself');
});

test('a refusal whose subject contains the needle fails as itself, not as the control', () => {
  assert.throws(
    () => refuteWithControl(/forbidden/, 'a forbidden word', 'forbidden is provable here',
      'the forbidden word surfaced'),
    /the forbidden word surfaced/);
});

test('a proven witness and a clean subject pass, for regex and string needles alike', () => {
  refuteWithControl(/alpha|beta/, 'gamma', 'alpha and beta both live here', 'unused');
  refuteWithControl('literal|pipe', 'gamma', 'a literal|pipe is one string, not two branches', 'unused');
  // A string needle containing `|` is a literal — a subject holding either
  // half alone stays clean.
  refuteWithControl('literal|pipe', 'just literal, just pipe', 'a literal|pipe witness', 'unused');
});

test('a /g needle cannot poison the control with lastIndex state', () => {
  // RegExp.test with /g/ is stateful; two calls from the same index lie.
  // refuteWithControl must behave identically no matter how often it runs.
  const re = /needle/g;
  re.test('needle here');   // leave dirty state behind on purpose
  refuteWithControl(re, 'clean', 'a needle for the witness', 'unused');
  refuteWithControl(re, 'clean', 'a needle for the witness', 'unused');
});
