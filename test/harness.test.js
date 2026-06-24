// @ts-check
// test/harness.test.js
// Self-test for the zero-dep Gherkin harness itself (test/gherkin.js).
// Proves: feature parsing, Background capture, Scenario Outline expansion,
// step matching with captures, and end-to-end execution against a world.

const test = require('node:test');
const assert = require('node:assert');
const { parseFeature, StepRegistry, executeSteps } = require('./gherkin');

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
