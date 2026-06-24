// @ts-check
// test/harness.test.js
// Self-test for the zero-dep Gherkin harness itself (test/gherkin.js).
// Proves: feature parsing, Background capture, Scenario Outline expansion,
// step matching with captures, and end-to-end execution against a world.

const test = require('node:test');
const assert = require('node:assert');
const { parseFeature, StepRegistry, executeSteps, GherkinSyntaxError } = require('./gherkin');

const SAMPLE = `
Feature: Demo
  As a tester
  I want the harness to work

  Background:
    Given a counter at 0

  Scenario: increment once
    When I add 5
    Then the counter is 5

  Scenario Outline: add amounts
    When I add <n>
    Then the counter is <total>

    Examples:
      | n  | total |
      | 2  | 2     |
      | 10 | 10    |
`;

test('parseFeature captures feature, background, and scenarios', () => {
  const p = parseFeature(SAMPLE);
  assert.strictEqual(p.feature, 'Demo');
  assert.strictEqual(p.background.length, 1);
  assert.strictEqual(p.background[0].text, 'a counter at 0');
  // 1 plain scenario + 2 expanded outline rows = 3
  assert.strictEqual(p.scenarios.length, 3);
});

test('parseFeature ignores Feature narrative lines', () => {
  const p = parseFeature(SAMPLE);
  const allSteps = p.scenarios.flatMap((s) => s.steps.map((st) => st.text));
  assert.ok(!allSteps.some((t) => /As a tester|I want/.test(t)));
});

test('Scenario Outline expands and substitutes placeholders', () => {
  const p = parseFeature(SAMPLE);
  const outline = p.scenarios.filter((s) => s.name.startsWith('add amounts'));
  assert.strictEqual(outline.length, 2);
  assert.strictEqual(outline[0].name, 'add amounts [1]');
  assert.strictEqual(outline[0].steps[0].text, 'I add 2');
  assert.strictEqual(outline[1].steps[0].text, 'I add 10');
});

test('StepRegistry matches and captures regex groups', () => {
  const reg = new StepRegistry();
  reg.define(/^I add (\d+)$/, () => {});
  const hit = reg.find('I add 42');
  assert.ok(hit);
  assert.deepStrictEqual(hit.args, ['42']);
  assert.strictEqual(reg.find('nope'), null);
});

test('executeSteps runs background + scenario against a shared world', async () => {
  const reg = new StepRegistry();
  reg.define(/^a counter at (\d+)$/, (w, n) => { w.count = Number(n); });
  reg.define(/^I add (\d+)$/, (w, n) => { w.count += Number(n); });
  reg.define(/^the counter is (\d+)$/, (w, n) => { assert.strictEqual(w.count, Number(n)); });

  const p = parseFeature(SAMPLE);
  const sc = p.scenarios.find((s) => s.name === 'increment once');
  const world = await executeSteps([...p.background, ...sc.steps], reg);
  assert.strictEqual(world.count, 5);
});

test('executeSteps throws on an undefined step', async () => {
  const reg = new StepRegistry();
  await assert.rejects(
    () => executeSteps([{ keyword: 'Given', text: 'something undefined' }], reg),
    /Undefined step: something undefined/,
  );
});

// --- Strict-mode guards -----------------------------------------------------
// Each unsupported / malformed construct must throw GherkinSyntaxError with a
// located, descriptive message — never parse vacuously. The line number lets a
// caller point straight at the offending line.

/** Wrap a snippet with a Feature: line so only the construct under test varies. */
const feat = (body) => `Feature: T\n${body}\n`;

/** @type {Array<[string, string, RegExp]>} */
const REJECTED = [
  ['doc strings',
    'Scenario: s\n  Given a payload\n  """\n  body\n  """', /doc strings/],
  ['step-level data tables',
    'Scenario: s\n  Given a table\n    | a | b |\n    | 1 | 2 |', /step-level data tables/],
  ['the Rule: keyword',
    'Rule: r\n  Scenario: s\n    Given x', /Rule: keyword/],
  ['Examples outside an outline',
    'Scenario: s\n  Given x\n  Examples:\n    | a |\n    | 1 |', /Examples: outside a Scenario Outline/],
  ['multiple Examples per outline',
    'Scenario Outline: s\n  Given <a>\n  Examples:\n    | a |\n    | 1 |\n  Examples:\n    | a |\n    | 2 |', /multiple Examples/],
  ['an outline with no Examples',
    'Scenario Outline: s\n  Given <a>', /no Examples/],
  ['an outline whose Examples has no data rows',
    'Scenario Outline: s\n  Given <a>\n  Examples:\n    | a |', /no data rows/],
  ['a ragged Examples row',
    'Scenario Outline: s\n  Given <a> <b>\n  Examples:\n    | a | b |\n    | 1 |', /header has 2/],
  ['an unknown placeholder',
    'Scenario Outline: s\n  Given <nope>\n  Examples:\n    | a |\n    | 1 |', /unknown placeholder <nope>/],
  ['a step before any scenario',
    'Given orphaned', /step before any Scenario/],
  ['multiple Background blocks',
    'Background:\n  Given a\nBackground:\n  Given b', /multiple Background/],
  ['a Background after a Scenario',
    'Scenario: s\n  Given x\nBackground:\n  Given a', /Background: must appear before/],
  // A Background placed after a Scenario OUTLINE: the outline isn't expanded into
  // `scenarios` until it's flushed, so the guard must flush before counting.
  ['a Background after a Scenario Outline',
    'Scenario Outline: o\n  Given <a>\n  Examples:\n    | a |\n    | 1 |\nBackground:\n  Given b',
    /Background: must appear before/],
  ['a Scenario with no steps (vacuous pass)',
    'Scenario: empty\nScenario: s2\n  Given x', /Scenario "empty" has no steps/],
  ['a Scenario Outline with no steps',
    'Scenario Outline: o\n  Examples:\n    | a |\n    | 1 |', /Scenario Outline "o" has no steps/],
  ['a step after its Examples table',
    'Scenario Outline: o\n  Given <a>\n  Examples:\n    | a |\n    | 1 |\n  When too late',
    /step after an Examples: table/],
];

for (const [label, body, pattern] of REJECTED) {
  test(`parseFeature loudly rejects ${label}`, () => {
    assert.throws(() => parseFeature(feat(body), 'x.feature'), (err) => {
      assert.ok(err instanceof GherkinSyntaxError, 'is a GherkinSyntaxError');
      assert.match(err.message, pattern);
      assert.match(err.message, /^x\.feature:\d+: /, 'message is located (file:line:)');
      assert.strictEqual(typeof err.line, 'number');
      return true;
    });
  });
}

test('parseFeature requires a Feature: line', () => {
  assert.throws(() => parseFeature('Scenario: s\n  Given x'), /no Feature: line/);
});

test('parseFeature still accepts the supported subset unchanged', () => {
  // The valid SAMPLE above must parse without throwing under strict mode.
  const p = parseFeature(SAMPLE, 'sample.feature');
  assert.strictEqual(p.scenarios.length, 3);
});
