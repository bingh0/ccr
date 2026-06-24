# `test/gherkin.js` — a tiny zero-dependency Gherkin runner

ccr executes its acceptance criteria (the `.feature` files in [`features/`](../features/))
with a hand-rolled Gherkin parser + runner that sits on top of Node's built-in
`node:test`. It is **~250 lines (≈200 of code, the rest its doc header), zero npm
dependencies, no build step** — one of the smallest practical Gherkin runners
you'll find, and small enough to read in one sitting.

It exists because the alternative — pulling in `@cucumber/gherkin` + a Vitest/Jest
binding — would add a dependency tree and a build step to a tool whose whole
selling point is that `npx claude-code-runrate` installs instantly on every OS,
Windows included. So we implement exactly the slice of Gherkin the feature files
use, and **refuse the rest loudly** instead of pretending to support it.

## The design rule

> Parse the supported subset correctly. Reject everything else with a
> `file:line:` error. **Never parse a feature file vacuously.**

The failure mode that matters for a small parser isn't crashing — it's *silently
under-parsing*, so a scenario passes with fewer steps than the author wrote (a
false green). Every construct below that this parser doesn't support is therefore
turned into a hard `GherkinSyntaxError`, not ignored.

## Supported grammar

| Construct | Notes |
|---|---|
| `Feature:` | exactly one per file, required |
| `Background:` | optional, at most one, must precede every `Scenario` |
| `Scenario:` | free-text title |
| `Scenario Outline:` | requires exactly one `Examples:` table |
| `Examples:` | a header row then ≥1 data row, `\|`-delimited |
| `<placeholder>` | substituted from the Examples columns; every `<name>` must match a column |
| Steps | `Given` `When` `Then` `And` `But` `*`, followed by step text |
| `# comment` | ignored anywhere |
| `@tag` | ignored (no tag filtering) |
| Feature narrative | the `As a… / I want… / So that…` prose block is ignored |

Step matching is by **`RegExp` or exact string** (capture groups become step
arguments) — see `StepRegistry.define`. There are no Cucumber Expressions
(`{int}`, `{string}`, custom parameter types); use a real regex instead.

## Deliberately unsupported — and rejected loudly

Each of these throws `GherkinSyntaxError` with the offending line number:

| Rejected | Why it's rejected, not ignored |
|---|---|
| Doc strings (`"""` / ` ``` `) | would be mis-read line-by-line as steps |
| Step-level data tables | the table argument would be silently dropped |
| Multiple `Examples:` per Outline | the 2nd header row would corrupt the expansion |
| `Examples:` with no data rows / no header | would expand to zero (vacuous) scenarios |
| Ragged Examples rows (cell count ≠ header) | column misalignment would pass silently |
| Unknown `<placeholder>` | almost always a typo; would leak `<name>` into a step |
| A `Scenario`/`Scenario Outline` with no steps | would run zero assertions and pass vacuously |
| A step *after* its `Examples:` table | malformed ordering; the step would mis-attach |
| `Rule:` (Gherkin 6) | grouping would be silently flattened |
| A step before any `Scenario`/`Background` | would be silently discarded |
| A 2nd `Feature:` / `Background:`, or `Background:` after a `Scenario` | ambiguous scope |

If you genuinely need any of these, this isn't the right parser — reach for
[`@cucumber/gherkin`](https://github.com/cucumber/gherkin).

### Two non-features, by design (not loud errors)

These aren't detected and rejected with a dedicated message — they simply aren't
implemented, and that's a deliberate choice, not an oversight:

- **Cucumber Expressions** (`{int}`, `{string}`, custom parameter types). Step
  text is matched by `RegExp`/exact string in `StepRegistry` — write a regex;
  `{int}` is treated as literal text, not expanded.
- **i18n / localized keywords.** English keywords only. Any line that doesn't
  start with a recognized keyword (or `|`, `#`, `@`) is treated as Feature
  narrative and ignored — which is what lets the `As a… / I want…` block exist.
  A non-English keyword therefore reads as narrative and is dropped; if that
  leaves a scenario with no steps, the **no-steps guard above** turns it into a
  loud error, so it still can't pass vacuously. The one residual gap is a
  *misspelled* keyword on a scenario that has other valid steps — that single
  line is dropped silently. Keep keywords spelled correctly.

## Error behavior

```js
const { parseFeature, GherkinSyntaxError } = require('./test/gherkin');

try {
  parseFeature(src, 'login.feature');
} catch (e) {
  if (e instanceof GherkinSyntaxError) {
    console.error(e.message); // "login.feature:12: unknown placeholder <user> (no matching Examples column)"
    console.error(e.line);    // 12
  }
}
```

Undefined steps are *not* a parse error — they're reported by the runner as
node:test **TODO** entries, so feature files are runnable before their steps
exist and go green as steps land.

## Usage

```js
const { StepRegistry, runFeatureFile } = require('./test/gherkin');

const registry = new StepRegistry();
registry
  .define(/^a counter at (\d+)$/, (world, n) => { world.count = Number(n); })
  .define(/^I add (\d+)$/,        (world, n) => { world.count += Number(n); })
  .define(/^the counter is (\d+)$/, (world, n) => {
    require('node:assert').strictEqual(world.count, Number(n));
  });

runFeatureFile('features/counter.feature', registry); // registers a node:test per scenario
```

In this repo the wiring lives in [`test/features.test.js`](../test/features.test.js):
every `features/*.feature` is auto-discovered and run against its **own scoped
registry** (`test/steps/`), so step patterns never leak between features, and
intra-feature ambiguity is asserted against.

## Public API

| Export | Purpose |
|---|---|
| `parseFeature(text, filename?)` | parse → `{ feature, background, scenarios }`; throws `GherkinSyntaxError` |
| `StepRegistry` | `.define(pattern, fn)` / `.find(text)` |
| `executeSteps(steps, registry, world?)` | run a flat step list against a shared world |
| `runFeature(parsed, registry)` | register a `node:test` per scenario |
| `runFeatureFile(file, registry)` | read + parse + run a `.feature` file |
| `GherkinSyntaxError` | thrown on unsupported/malformed syntax; carries `.line` |

The whole thing is covered by [`test/harness.test.js`](../test/harness.test.js),
including a rejection test for every guard above.
