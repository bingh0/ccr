// @ts-check
// test/harness.test.js
// Self-test for the zero-dep Gherkin harness itself (test/gherkin.js).
// Proves: feature parsing, Background capture, Scenario Outline expansion,
// step matching with captures, and end-to-end execution against a world.

const test = require('node:test');
const assert = require('node:assert');
const { parseFeature, StepRegistry, executeSteps, runFeature, DataTable, buildSnippet, GherkinSyntaxError } = require('./gherkin');

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
  assert.ok(sc, 'the sample feature defines "increment once"');
  const world = await executeSteps([...p.background, ...sc.steps], reg);
  assert.strictEqual(world.count, 5);
});

// These steps are built by hand rather than parsed, so `line` is positional and
// not a claim about any file. The Step type requires it — the parser always
// knows it, and the linter and run manifest both read it — but executeSteps
// never does: verified against 0.9.0 and re-verified against 0.11.0, the thrown
// message is byte-identical with no line, with 1, and with 42. It is carried
// here to satisfy the type honestly, not to change behaviour.
test('executeSteps throws on an undefined step', async () => {
  const reg = new StepRegistry();
  await assert.rejects(
    () => executeSteps([{ keyword: 'Given', text: 'something undefined', line: 1 }], reg),
    /Undefined step: something undefined/,
  );
});

// --- Strict-mode guards -----------------------------------------------------
// Each unsupported / malformed construct must throw GherkinSyntaxError with a
// located, descriptive message — never parse vacuously. The line number lets a
// caller point straight at the offending line.

/** Wrap a snippet with a Feature: line so only the construct under test varies. */
const feat = (/** @type {string} */ body) => `Feature: T\n${body}\n`;

/** @type {Array<[string, string, RegExp]>} */
const REJECTED = [
  ['doc strings',
    'Scenario: s\n  Given a payload\n  """\n  body\n  """', /doc strings/],
  ['a ragged step data table',
    'Scenario: s\n  Given a table\n    | a | b |\n    | 1 |', /table row has 1 cell/],
  ['a table row with no preceding step',
    'Scenario: s\n  | a |\n  Given x', /table row without a preceding step/],
  ['a table row before any scenario',
    '| a |', /table row before any Scenario or Background/],
  ['a table row missing its closing pipe (silent cell loss)',
    'Scenario: s\n  Given a table\n    | a | b', /must end with a closing \|/],
  ['an empty table row',
    'Scenario: s\n  Given a table\n    |', /empty table row/],
  ['tags on a step',
    'Scenario: s\n  @late\n  Given x', /must immediately precede/],
  ['tags on an Examples: block',
    'Scenario Outline: o\n  Given <a>\n  @t\n  Examples:\n    | a |\n    | 1 |', /must immediately precede/],
  ['dangling tags at end of file',
    'Scenario: s\n  Given x\n@dangling', /dangling tags/],
  ['a near-miss semantic tag (case typo)',
    '@Skip\nScenario: s\n  Given x', /near-miss tag is silently inert/],
  ['a near-miss @only (would silently deselect under --test-only)',
    '@ONLY\nScenario: s\n  Given x', /near-miss tag is silently inert/],
  ['combined semantic tags (runners disagree on which wins)',
    '@skip @todo\nScenario: s\n  Given x', /mutually exclusive/],
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

// --- Step data tables ---------------------------------------------------------

const TABLE_SAMPLE = `
Feature: T
  Scenario: s
    Given these users
      | name  | role  |
      | ada   | admin |
      | linus | dev   |
    Then ok
`;

test('a table after a step attaches to it and arrives as a DataTable last argument', async () => {
  const p = parseFeature(TABLE_SAMPLE);
  assert.deepStrictEqual(p.scenarios[0].steps[0].table,
    [['name', 'role'], ['ada', 'admin'], ['linus', 'dev']]);

  const reg = new StepRegistry();
  /** @type {any} */ let got = null;
  reg.define(/^these users$/, (w, table) => { got = table; });
  reg.define('ok', () => {});
  await executeSteps(p.scenarios[0].steps, reg);

  assert.ok(got instanceof DataTable);
  assert.deepStrictEqual(got.hashes(), [{ name: 'ada', role: 'admin' }, { name: 'linus', role: 'dev' }]);
  assert.deepStrictEqual(got.rows(), [['ada', 'admin'], ['linus', 'dev']]);
  assert.deepStrictEqual(got.transpose().raw()[0], ['name', 'ada', 'linus']);
});

test('rowsHash maps a two-column table and rejects wider ones', () => {
  assert.deepStrictEqual(new DataTable([['a', '1'], ['b', '2']]).rowsHash(), { a: '1', b: '2' });
  assert.throws(() => new DataTable([['a', '1', 'x']]).rowsHash(), /two columns/);
});

test('Outline placeholders substitute inside step data tables', () => {
  const p = parseFeature(feat(
    'Scenario Outline: o\n  Given a load of <n>\n    | value |\n    | <n>   |\n  Examples:\n    | n |\n    | 7 |'));
  assert.deepStrictEqual(p.scenarios[0].steps[0].table, [['value'], ['7']]);
});

test('table cells honor \\| \\\\ \\n escapes; other backslashes stay literal', () => {
  const src = String.raw`Feature: T
  Scenario: s
    Given t
      | a\|b | c\\d | e\nf | Cmd+\ |
    Then ok`;
  const p = parseFeature(src);
  assert.deepStrictEqual(p.scenarios[0].steps[0].table, [['a|b', 'c\\d', 'e\nf', 'Cmd+\\']]);
});

// --- Tags -----------------------------------------------------------------------

test('tags attach to scenarios and inherit from the Feature', () => {
  const p = parseFeature('@suite\nFeature: T\n  @skip @AC1\n  Scenario: s\n    Given x\n');
  assert.deepStrictEqual(p.scenarios[0].tags, ['@suite', '@skip', '@AC1']);
});

// Self-proving @skip: this registers a real node:test whose only step THROWS.
// If the @skip → { skip: true } mapping ever breaks, this suite fails.
{
  const reg = new StepRegistry();
  reg.define('boom', () => { throw new Error('@skip mapping broken: skipped step ran'); });
  runFeature(parseFeature('Feature: SkipProof\n  @skip\n  Scenario: never runs\n    Given boom\n'), reg);
}

// --- world.defer (scenario-scoped cleanup) ------------------------------------

test('deferred cleanup runs LIFO after the steps', async () => {
  const reg = new StepRegistry();
  /** @type {string[]} */ const order = [];
  reg.define(/^acquire (\w+)$/, (w, name) => { w.defer(() => { order.push(String(name)); }); });
  await executeSteps([
    { keyword: 'Given', text: 'acquire outer', line: 1 },
    { keyword: 'And', text: 'acquire inner', line: 2 },
  ], reg);
  assert.deepStrictEqual(order, ['inner', 'outer']);
});

test('cleanup still runs when a step fails, and the step error wins', async () => {
  const reg = new StepRegistry();
  let cleaned = false;
  reg.define('setup', (w) => { w.defer(() => { cleaned = true; throw new Error('cleanup also failed'); }); });
  reg.define('boom', () => { throw new Error('step failed'); });
  await assert.rejects(
    () => executeSteps([{ keyword: 'Given', text: 'setup', line: 1 }, { keyword: 'When', text: 'boom', line: 2 }], reg),
    /step failed/,
  );
  assert.ok(cleaned, 'deferred cleanup must run despite the step failure');
});

test('a cleanup error surfaces when the steps themselves passed', async () => {
  const reg = new StepRegistry();
  reg.define('setup', (w) => { w.defer(() => { throw new Error('leak detected'); }); });
  await assert.rejects(
    () => executeSteps([{ keyword: 'Given', text: 'setup', line: 1 }], reg),
    /leak detected/,
  );
});

// --- Snippets -------------------------------------------------------------------

test('buildSnippet converts numbers and quoted strings to captures', () => {
  assert.strictEqual(
    buildSnippet('the 5h meter moved from 40% to 50.5% over "a b" minutes at /tmp/x'),
    'reg.define(/^the (\\d+)h meter moved from (\\d+)% to ([\\d.]+)% over "([^"]*)" minutes at \\/tmp\\/x$/,'
    + " (w, p1, p2, p3, p4) => {\n  throw new Error('pending: implement this step');\n});",
  );
});

test('the generated snippet is valid JS, matches its own step, and throws pending', () => {
  const text = 'the 5h meter shows "busy" at 42%';
  const stub = { re: /x/, fn: /** @type {any} */ (null), define(/** @type {any} */ re, /** @type {any} */ fn) { this.re = re; this.fn = fn; } };
  new Function('reg', buildSnippet(text))(stub); // throws if the snippet isn't valid JS
  assert.ok(stub.re.test(text), 'snippet regex matches the original step text');
  assert.throws(() => stub.fn({}, '5', 'busy', '42'), /pending/, 'generated body must throw, never pass vacuously');
});
