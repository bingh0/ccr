# Acceptance criteria in ccr — and how they relate to conventional BDD

ccr's behaviour is specified in [`features/`](../features/): 17 feature files,
154 scenarios, 1,442 lines, executed on every run by
[`test/features.test.js`](../test/features.test.js).

This document describes what that practice **is** — what it took from
conventional BDD, where it departed, and what the departures were for. Every
claim below names the file it comes from, so it can be checked rather than
believed.

The runner is documented separately in [GHERKIN.md](GHERKIN.md). That file is a
mirror of an upstream package; this one is ccr's own, and the split is
deliberate — see [Policy lives in the consumer](#policy-lives-in-the-consumer).

## What it kept

Most of it. This is BDD, not a reaction against it.

- **The narrative.** 14 of the 17 files open with the full *As a / I want / So
  that*. From [`economy.feature`](../features/economy.feature): *"As a Claude
  Code user on a subscription plan / I want one glanceable screen that tells me
  when I'll hit the limit and whether to clear / So that I can pace a session
  without doing token math in my head."*
- **The grammar**, used where it earns its place rather than everywhere: 7
  `Background` blocks, 8 `Scenario Outline` + `Examples` pairs, 30 rows of
  step data tables.
- **The declarative voice.** Steps name behaviour, not mechanism — *"When the
  economy screen renders"*, never *"when renderEconomy() is called"*. The
  mechanism lives in the binding, where it can change without touching the
  specification.
- **The feature file as the reviewed artifact** — the thing a human reads and
  signs off, and the only place behaviour is agreed.

## Where it departed

### The reader is the author and an agent, not a business stakeholder

203 of the 1,442 lines — **14%** — are comments. Conventional practice keeps
feature files nearly comment-free, because the prose *is* the documentation and
its reader is a stakeholder who does not have the repository open. ccr's reader
does have it open, and the comments say so:
[`pane-blobs.feature`](../features/pane-blobs.feature) opens by naming
`docs/PANE-CONTRACT.md`, the golden fixture, `src/sanitize.js`,
`test/features.test.js`, and the module-graph test that pins its structural
invariants.

### Comments carry rulings, not asides

The densest headers are policy, recorded where the scenarios they govern live.
From `pane-blobs.feature`:

> `@security` marks the scenarios that hold the trust boundary rather than the
> look of the pane. They are gate-mandatory: once their steps land they must
> bind and pass even while the rest of this feature sits in `wip` … and they may
> never carry `@skip` or `@todo`.

That is a decision with its reasoning attached — closer to a design record than
to a comment.

### Negative space is first-class

**42 of the 154** scenario titles are refusal-shaped. *"Reconciliation never
drives a meter backwards"*, *"A path traversal escaping the projects dir is
rejected"*, *"A stale heartbeat never suppresses the split banner"*, *"Claude
inherits the profile's state dir so two accounts never mix"*. Conventional BDD
tends to lead with the happy path and treat refusals as edge cases; here roughly
a quarter of the specification is about what must **not** happen.

### Subjective qualities are operationalised, not avoided

`economy.feature` is titled *"Economy screen readability and intuitiveness"* and
asserts things conventional guidance would call untestable:

> Then the clear line states how many more minutes clearing now would buy
> And the screen does not require the reader to know what "ROI" means

and

> Then the time figure reads as remaining budget, not as percentage used
> And the screen does not headline a percentage-per-minute burn rate

These bind to the real renderer. The bet is that "intuitive" is not
unfalsifiable — it decomposes into claims about what the design must not demand
of a reader, and those are checkable.

### Tags are gates, not filters

In Cucumber a tag primarily *selects* which scenarios run. In ccr, `@security`
(26 uses) is a promise, enforced by
[`test/security-tags.test.js`](../test/security-tags.test.js), which parses the
feature files itself rather than going through the runner:

1. Every step of every `@security` scenario must **bind**, even while its
   feature is listed in `wip` — because *"a gate that `wip` can switch off is
   not a gate"*.
2. No `@security` scenario may carry `@skip` or `@todo`, so silencing one has to
   be the visible deletion of the `@security` tag in a diff someone reviews,
   never a quiet tag that reads like housekeeping.

### Silence is the defect

The through-line, and the reason for most of the above:

- `runFeatures()` **discovers** every `features/*.feature` rather than taking a
  hardcoded list, so a new feature file cannot be quietly left out of the run.
- An unbound step registers as a `node:test` **TODO**, and `node:test` reports
  TODO as *passing* — a silent coverage hole. So unbound steps are guarded,
  and a feature still being bootstrapped must declare that by listing its
  basename in `wip`: visible in the diff, never implicit.
- Ambiguous steps are refused rather than resolved by first match.

None of these make the suite stricter about *behaviour*. They make it unable to
be quiet about what it did not check.

## Policy lives in the consumer

`security-tags.test.js` explains why it is not upstream:

> This lives in ccr rather than in the gherkin runner on purpose:
> `test/gherkin.js` is a MIRROR of gherkin-node-test … and "@security is
> unskippable" is ccr's policy, not Gherkin semantics. Upstreaming it would fork
> the mirror for every other consumer.

The tool stays general; the policy stays local and reviewable. That boundary is
why this document exists separately from [GHERKIN.md](GHERKIN.md).

## The flavour this adds up to

Conventional BDD optimises for **shared understanding between people** — the
feature file is a conversation artifact, and its value is that a stakeholder, a
developer, and a tester read the same sentence the same way.

ccr's variant optimises for a **suite that cannot lie about what it checked**.
The difference is the collaborator. An agent will satisfy the letter of a
specification at machine speed, so silent wrongness compounds while loud
wrongness costs one retry loop. Every departure above follows from that: the
comments carry rulings because the agent reads them; refusals are specified
because unspecified behaviour is where an agent has latitude; tags became gates
because a filter is something an agent can quietly change; discovery replaced
lists because a list is something that can be silently short.

The narrative, the grammar, and the declarative voice survive unchanged, because
none of them were the problem.

## Where this sits

The practice in this repository is one point on a line:

| | |
|---|---|
| **treecontext** | no feature files at all |
| **ccr** | **agent-driven BDD 1.0** — strict grammar plus the anti-silence guards above |
| **gherkin-node-test / gherkin-cargo-test** | 1.5 — separating user-facing acceptance from developer-facing design review, and the first scope interview |
| **gherkin-trace** | 2.0 — the de novo, end-to-end example of the developed method (forthcoming) |
| *(next)* | 2.5 — appeasement and audit |

ccr is the **1.0 article**: the first articulation, when the method was
essentially the strict grammar and a refusal to let the suite be quiet. It
predates the scope interview, the out-of-scope fence, and the two-tier split.

One asymmetry is worth naming, because the repository does not otherwise show
it: the **runner** vendored here is current (gherkin-node-test 0.9.0), while the
**practice** documented above is 1.0-era. That is deliberate — ccr is maintained
as a working tool, but its method is not retrofitted, because a specimen that
gets upgraded stops being evidence of anything.

Read ccr for what 1.0 was. Read **gherkin-trace** for what the method became.
