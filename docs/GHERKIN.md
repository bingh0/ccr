# `test/gherkin.js` — a minimal, zero-dependency BDD runner for JavaScript

A **targeted** tool: it runs Gherkin (`.feature`) acceptance tests in plain
JavaScript with **zero npm dependencies and no build step**, on top of the
runtime's built-in test runner (`node:test` under Node; natively `bun:test`
under Bun; Deno's `node:test` bridge under Deno — ccr itself runs it on Node).
In ccr it executes the criteria in [`features/`](../features/). At ~2,200 lines
it is still small enough to read in one sitting and to vendor as a single file.

`test/gherkin.js` is a vendored copy of **gherkin-node-test 0.11.0**
([source](https://github.com/bingh0/gherkin-node-test),
[npm](https://www.npmjs.com/package/gherkin-node-test)) — that package is the
canonical, standalone home; use it directly in other projects. The copy here
keeps ccr's suite running on a bare `node --test` with zero install.

**Scope of this document.** It describes the *tool* — the half of the vendored
file ccr actually uses: the runner. For ccr's own acceptance-criteria
**practice** — what it took from conventional BDD, where it departed, and why —
see [BDD.md](BDD.md). The split is deliberate: this file mirrors an upstream
package, and ccr's policy is not the runner's semantics.

Of the runner itself, this page covers only what ccr wires up and relies
on. The vendored copy also carries two **linters** and a **run manifest**.
Both linters are wired: `lintFeature` gates the reviewed corpus in strict mode
(`test/feature-lint.test.js`, with a reasoned register for the heuristic
`vague-then` class), and `lintStepDefinitionSource` gates the step layer
(`test/step-lint.test.js`), where every absence assertion must be earned by a
control or sanctioned by a marker naming its prover. The run manifest and
`bindRunner` ship with the file and are not wired up here. For those, and for
the authoritative account of everything below, read the upstream README; this
page is kept to what ccr relies on so it stays true without tracking every
upstream release.

It exists because the alternative — pulling in `@cucumber/gherkin` + a Vitest/Jest
binding — would add a dependency tree and a build step to a tool whose whole
selling point is that `npx claude-code-runrate` installs instantly on every OS,
Windows included. So we implement exactly the practical core of Gherkin and
**refuse the rest loudly** instead of pretending to support it.

## When to reach for it — and when not

This is a **targeted** option, not a general Cucumber replacement. It fits when
*all* of these hold:

- you want **BDD / Gherkin in JavaScript**, with **zero dependencies** and **no
  build step**;
- running on the runtime's built-in test runner (`node:test` / `bun:test`) is
  fine; and
- the practical core of Gherkin (Feature / Background / Scenario / Scenario
  Outline + Examples / step data tables / `@skip` `@todo` tags) covers
  your `.feature` files.

That's the whole niche: the smallest thing that turns `.feature` files into real
`node:test` tests, with nothing to install and nothing to compile.

Once you outgrow that, reach for a heavier tool instead:

- **TypeScript on a Vite / Vitest stack →**
  [`@amiceli/vitest-cucumber`](https://github.com/amiceli/vitest-cucumber). Native
  TypeScript, integrates with the Vitest runner (watch, UI, coverage), and
  supports Cucumber Expressions, hooks and doc strings.
- **The full Gherkin grammar or the official toolchain →**
  [`@cucumber/gherkin`](https://github.com/cucumber/gherkin) with a
  Jest / Mocha / Vitest binding, or `@cucumber/cucumber` itself.

## The design rule

> Parse the supported subset correctly. Reject everything else with a
> `file:line:` error. **Never parse a feature file vacuously.**

The failure mode that matters for a small parser isn't crashing — it's *silently
under-parsing*, so a scenario passes with fewer steps (or fewer table cells)
than the author wrote — a false green. Every construct below that this parser
doesn't support is therefore turned into a hard `GherkinSyntaxError`, not
ignored. The same rule extends past the parser: unbound and ambiguous steps are
failed by `runFeatures()`'s guard tests, and generated step snippets **throw**
rather than pass.

## Usage

The high-level entry point runs a whole directory, one scoped registry per
feature:

```js
// test/features.test.js
const path = require('node:path');
const { runFeatures } = require('./gherkin');

runFeatures(path.join(__dirname, '..', 'features'), {
  // feature basename → step definer
  'counter': (reg) => {
    reg.define(/^a counter at (\d+)$/,   (w, n) => { w.count = Number(n); });
    reg.define(/^I add (\d+)$/,          (w, n) => { w.count += Number(n); });
    reg.define(/^the counter is (\d+)$/, (w, n) => {
      require('node:assert').strictEqual(w.count, Number(n));
    });
  },
}, { wip: [] });   // features still bootstrapping (TODO scenarios allowed)
```

Run with `node --test`. Alongside the scenarios, `runFeatures` registers guards:

- **every definer key must name an existing `.feature` file** — a renamed
  feature can't silently strand its step definitions;
- **within each feature, every step must match exactly one definition** — an
  ambiguous step (>1 match) fails, and an unbound step (0 matches) fails
  *unless the feature is listed in `wip`*. This matters because unbound
  scenarios register as `node:test` **TODO**, which is reported as *passing* —
  without the guard, rewording one step could silently un-test a feature while
  CI stays green. The failure message includes a **paste-ready snippet** for
  each missing step;
- `@skip`'d scenarios are ratcheted too: skip means "don't run", never
  "don't bind";
- **one `runFeatures` call per test file** — a second call in the same file is
  refused as a registered failing test. (Under Deno, a top-level throw after an
  earlier `test()` registration is silently swallowed and `deno test` exits 0;
  a single call per file keeps every load-time error ahead of every
  registration, so it surfaces loudly on all runtimes.)

Step registries are **scoped per feature**: one feature's patterns can never
match another feature's steps, so there is no global step namespace — identical
sentences in two features may legitimately bind to different definitions.

## Supported grammar

| Construct | Notes |
|---|---|
| `Feature:` | exactly one per file, required |
| `Background:` | optional, at most one, must precede every `Scenario` |
| `Scenario:` | free-text title |
| `Scenario Outline:` | requires exactly one `Examples:` table |
| `Examples:` | a header row then ≥1 data row, `\|`-delimited |
| `<placeholder>` | substituted from the Examples columns — in step text **and** in step data tables; every `<name>` must match a column |
| Steps | `Given` `When` `Then` `And` `But` `*`, followed by step text |
| Step data tables | `\|` rows after a step attach to that step; the step function receives a **`DataTable`** as its last argument |
| Tags | `@skip` never runs the scenario (steps must still bind); `@todo` runs it as xfail — failing gates nothing, *passing* reds the run as a stale tag; tags on `Feature:` apply to all its scenarios; any other tag (e.g. `@AC3`) is carried on `scenario.tags` but has no runtime effect |
| `# comment` | ignored anywhere |
| Feature narrative | the `As a… / I want… / So that…` prose block is ignored |

Table cells honor the Gherkin escapes `\|` (literal pipe), `\\` (literal
backslash) and `\n` (newline); a backslash before any other character is
literal, so cells like `C:\Temp` or `Cmd+\` need no escaping.

Tag semantics on the runner side: `@skip` never executes the scenario.
`@todo` is **inverted** (xfail) as of 0.9.0 and behaves identically on every
runtime: the scenario runs as a plain test, and while it fails, the failure is
printed but gates nothing. The run that would first turn it *green* goes red
instead, naming the stale tag — so a paid-off `@todo` cannot hide, and the only
exit is deleting the tag in a one-line reviewed diff. (Before 0.9.0 the runtimes
disagreed: Node reported a failing todo as passing, Bun ran todo bodies only
under `--todo`, and Deno never ran them at all.) ccr carries no `@todo`
scenarios. `@only` is **rejected** as a registered failing test: focus
semantics differ irreconcilably across runtimes (Node: inert without
`--test-only`; Bun/Deno: focuses its file on every run, and Deno exits 0 — a
committed `@only` would silently narrow a CI run). Focus one scenario with the
runner's own per-run flag instead. Combining `@skip`/`@todo`/`@only` on one
scenario is likewise a loud error — runners disagree on which would win.

### Step matching and `DataTable`

Step matching is by **`RegExp` or exact string** (capture groups become step
arguments) — see `StepRegistry.define`. There are no Cucumber Expressions
(`{int}`, `{string}`); write a regex.

A step with a data table receives a `DataTable` as its **last** argument,
API-compatible with cucumber-js so step code ports both ways:

```gherkin
Given these users
  | name  | role  |
  | ada   | admin |
```

```js
reg.define(/^these users$/, (w, table) => {
  table.raw();      // [['name','role'],['ada','admin']]  (defensive copy)
  table.rows();     // rows minus the header
  table.hashes();   // [{ name: 'ada', role: 'admin' }]
  table.rowsHash(); // two-column table → { key: value } map
  table.transpose() // columns become rows → new DataTable
});
```

### Scenario-scoped cleanup: `world.defer(fn)`

Cleanup registered with `world.defer` runs after the scenario in reverse (LIFO)
order — **including when a step failed**, so a failing assertion can't leak
temp dirs, files, or processes. The step failure, if any, outranks cleanup
errors; if the steps passed, the first cleanup error fails the scenario.
(`defer` is a reserved key on the world object.)

```js
reg.define(/^a state dir$/, (w) => {
  w.dir = fs.mkdtempSync(prefix);
  w.defer(() => fs.rmSync(w.dir, { recursive: true, force: true }));
});
```

### Snippets for unbound steps

Guard failures (and `executeSteps`' undefined-step error) include a paste-ready
definition per missing step — quoted strings and numbers already converted to
capture groups:

```
// the meter moved from 40% to 50.5%
reg.define(/^the meter moved from (\d+)% to ([\d.]+)%$/, (w, p1, p2) => {
  throw new Error('pending: implement this step');
});
```

The generated body **throws** deliberately: an empty body would turn the pasted
definition into an instant vacuous pass — the exact failure mode this harness
exists to prevent.

## Deliberately unsupported — and rejected loudly

Each of these throws `GherkinSyntaxError` with the offending line number:

| Rejected | Why it's rejected, not ignored |
|---|---|
| Doc strings (`"""` / ` ``` `) | would be mis-read line-by-line as steps |
| Multiple `Examples:` per Outline | the 2nd header row would corrupt the expansion |
| `Examples:` with no data rows / no header | would expand to zero (vacuous) scenarios |
| Ragged table rows (Examples **or** step tables) | column misalignment would pass silently |
| A table row missing its closing `\|` | the trailing cell would be silently dropped |
| A table row with no preceding step | the data would silently belong to nothing |
| Unknown `<placeholder>` | almost always a typo; would leak `<name>` into a step |
| A `Scenario`/`Scenario Outline` with no steps | would run zero assertions and pass vacuously |
| A step *after* its `Examples:` table | malformed ordering; the step would mis-attach |
| Tags anywhere but immediately before `Feature:` / `Scenario:` / `Scenario Outline:` | a mis-placed `@skip` would silently not skip |
| `@only` (well-formed) | focus behaves three different ways on the three runtimes — a committed `@only` would silently narrow a CI run (the one entry here rejected as a *registered failing test* rather than a parse error, so it shows up in the run, not at load) |
| `@skip`/`@todo`/`@only` combined on one scenario | runners disagree on which tag wins |
| A near-miss semantic tag (`@Skip`, `@SKIP`, `@Only`, …) | would be silently inert |
| `Rule:` (Gherkin 6) | grouping would be silently flattened |
| A step before any `Scenario`/`Background` | would be silently discarded |
| A 2nd `Feature:` / `Background:`, or `Background:` after a `Scenario` | ambiguous scope |

If you genuinely need any of these, this isn't the right parser — reach for
[`@cucumber/gherkin`](https://github.com/cucumber/gherkin).

### Two non-features, by design (not loud errors)

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

An **ambiguous** step — one matching two registered bindings — fails its
scenario before any step runs, naming the step and every matching pattern.
Ambiguity is detected at registration, so it outranks `@skip` and `@todo`: a
binding defect is never parked or worn as declared debt. (Before 0.9.0 the
first match simply ran, silently.)

Undefined steps are *not* a parse error — they're reported by the low-level
runner as node:test **TODO** entries, so feature files are runnable before their
steps exist and go green as steps land. Under `runFeatures()` that bootstrapping
mode must be opted into per feature via `wip`; otherwise unbound steps fail the
guard test (TODO reads as *passing* in `node:test`, so an unguarded TODO is a
silent coverage hole).

## Public API

| Export | Purpose |
|---|---|
| `runFeatures(dir, definers, { wip, manifest }?)` | **high-level runner**: discover every `.feature`, scoped registries, guard tests. A missing directory, a non-directory path, and a directory with no `.feature` files each fail the run with a test naming the path — never a silently green zero-scenario run. ccr passes no `manifest` |
| `parseFeature(text, filename?)` | parse → `{ feature, background, scenarios }`; throws `GherkinSyntaxError` |
| `StepRegistry` | `.define(pattern, fn)` / `.find(text)` |
| `executeSteps(steps, registry, world?)` | run a flat step list against a shared world (installs `world.defer`) |
| `runFeature(parsed, registry)` | register a runner test per scenario (tags applied, `@only` rejected, unbound → TODO) |
| `runFeatureFile(file, registry)` | read + parse + run a `.feature` file |
| `DataTable` | cucumber-compatible step table: `raw` / `rows` / `hashes` / `rowsHash` / `transpose` |
| `buildSnippet(text)` | paste-ready step definition for an unbound step (body throws) |
| `GherkinSyntaxError` | thrown on unsupported/malformed syntax; carries `.line` |

The whole thing is covered by [`test/harness.test.js`](../test/harness.test.js),
including a rejection test for every parse-time guard above, a self-proving
`@skip` scenario whose only step throws, and an eval of a generated snippet.
The registration-level guards (`@only`, a second `runFeatures` call) are proven
by subprocess in the canonical package's own suite —
[`gherkin-node-test`](https://github.com/bingh0/gherkin-node-test).
