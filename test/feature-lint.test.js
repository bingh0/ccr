// @ts-check
// test/feature-lint.test.js
// The reviewed corpus, linted in strict mode.
//
// The runner already refuses the error class at parse time — a dialect
// violation or a duplicate title fails the feature outright. What this adds is
// the warn class plus strict's own rule: `strict-tag`, which refuses a
// committed @skip or @only, so reviewed output can carry no silent debt and no
// focus. (@todo is deliberately exempt upstream: the stale-@todo run-time
// inversion polices it, which makes a committed @todo honest, visible,
// self-retiring debt rather than a hidden skip.)
//
// WHY THERE IS A REGISTER. gnt's docs/lint-admission.md sets a rule this gate
// has to respect: heuristic rules — the `vague-then` class — stay warnings
// because their cheapest appeasement is phrase-shuffling, and "if a rule fires
// on a meaningful fraction of honest output, it is a phrasing tax." Gating on
// `vague-then` with no register would invite exactly the spec-weakening the
// admission tests exist to prevent, on the surface the doctrine most protects:
// feature files are reviewer-facing.
//
// So the gate is strict, and the two standing findings are sanctioned here by
// name, with reasons, in a reviewed diff. Both are false positives of the same
// shape — the flagged word sits inside a quoted literal that the rule reads as
// prose. Entries are keyed on the quoted sentence rather than a line number:
// reword the Then and it faces the gate again, which is the point.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lintFeature } = require('./gherkin');

const FEATURES = path.join(__dirname, '..', 'features');

/**
 * Findings ruled acceptable, each naming why. A sanction whose rule no longer
 * fires is itself a failure below — a stale entry is a claim nobody checked.
 * @type {{ file: string, rule: string, quoting: string, reason: string }[]}
 */
const SANCTIONED = [
  {
    file: 'doctor-windows.feature',
    rule: 'vague-then',
    quoting: 'it notes the CLI still works',
    reason:
      'Not vague: the Then quotes doctor\'s own output. src/doctor.js emits the '
      + 'literal string "the CLI still works" beside the winget hint, and the '
      + 'binding asserts that exact substring. "works" here is a quotation, not a '
      + 'claim about behaviour — the observable is the sentence itself.',
  },
  {
    file: 'transcripts.feature',
    rule: 'vague-then',
    quoting: 'the feed lists a "Bash" event with arg "still works"',
    reason:
      'The flagged word is fixture data, not the outcome. "still works" is the '
      + 'described Bash command in the malformed-line scenario; the outcome being '
      + 'asserted is that the feed lists the event at all after a bad line. '
      + 'Renaming the fixture to dodge the rule would be the phrase-shuffling '
      + 'lint-admission.md names as unsound appeasement.',
  },
];

const featureFiles = fs.readdirSync(FEATURES)
  .filter((f) => f.endsWith('.feature')).sort();

test('the reviewed feature corpus is strict-lint clean', () => {
  /** @type {string[]} */
  const unsanctioned = [];
  const hit = new Set();

  for (const file of featureFiles) {
    const text = fs.readFileSync(path.join(FEATURES, file), 'utf8');
    for (const f of lintFeature(text, file, { strict: true })) {
      const s = SANCTIONED.find((x) =>
        x.file === file && x.rule === f.rule && f.message.includes(x.quoting));
      if (s) { hit.add(s); continue; }
      unsanctioned.push(`${file}:${f.line} [${f.rule}] ${f.message}`);
    }
  }

  assert.deepStrictEqual(unsanctioned, [],
    'Fix the file, or add a reasoned entry to SANCTIONED in this test.');

  // The ratchet's other direction: a sanction that no longer fires is removed,
  // not left standing. Otherwise the register silently accumulates permissions
  // for findings nobody has seen in a year.
  const stale = SANCTIONED.filter((s) => !hit.has(s))
    .map((s) => `${s.file} [${s.rule}] "${s.quoting}"`);
  assert.deepStrictEqual(stale, [],
    'This sanction no longer matches any finding — delete it.');
});

test('the feature-lint scan actually reaches the corpus', () => {
  assert.ok(featureFiles.length >= 30,
    `found only ${featureFiles.length} feature files — the root is wrong`);
});
