# Acceptance criteria — Gherkin features

These `.feature` files are the executable acceptance criteria for `ccr`. Every
feature here runs under `npm test` via the zero-dep harness's `runFeatures()`
(`test/gherkin.js`, invoked from `test/features.test.js`), and completeness is
**enforced**: the run fails if a feature's steps are unbound or ambiguous
(unbound steps would otherwise register as TODO, which `node:test` reports as
passing — the failure message includes a paste-ready snippet per missing step),
or if a step-definer key in `test/steps/index.js` matches no feature file. A
feature may opt into bootstrap mode (unbound steps allowed as TODO) only via
the explicit `wip` list in `test/features.test.js`.

Step definitions are **scoped per feature** — each file runs against its own
registry (`test/steps/index.js`), so identical step sentences in two features
may legitimately bind to different definitions. Implementation-detail
assertions (exact argv tokens, glyph literals) live in the `test/*.test.js`
unit layer underneath; features stay behavioral.

## Feature index

| Feature file | Tool / component | Criteria from |
|---|---|---|
| `account-limits.feature` | `src/account-limits.js` (cross-instance 5h/weekly reconciliation) | reported bug ("the sidecars don't agree") |
| `instance-slots.feature` | `src/instance-slot.js` + every launcher's namespace choice | reported bug ("can't have two ccr up at once") |
| `burn-rate.feature` | `src/burn.js` (windowEstimate / binding / clearROI) | gap analysis (Gaps 1–3) + backtest |
| `economy.feature` | `src/render/economy.js` | readability review (R#/I# codes) |
| `feed.feature` | `src/render/feed.js` + transcript events | design (live tool/skills feed) |
| `liveness.feature` | `src/sidecar.js` composeFrame + `src/liveness.js` policy | reported bug ("times out too quickly") |
| `resume.feature` | `src/resume.js` + `src/render/resume.js` | design (resume-cost advisor, not a picker) |
| `statusline.feature` | `src/render/statusline.js` | design (plain-text statusLine contract) |
| `transcripts.feature` | `src/transcripts.js` | design (shared transcript spine) |

### Scoped 2026-08-04, since built

These carry the reviewed acceptance criteria for the git pane, produced by a
`/scope` interview on 2026-08-04 and confirmed by the visionary. They entered
the `wip` register in `test/wip-register.js` as declared debt and each
basename left the list as its steps bound — both registers are empty today,
so every scenario below runs and passes. The fence that goes with them is
[`OUT-OF-SCOPE.md`](OUT-OF-SCOPE.md).

| Feature file | Behavior |
|---|---|
| `git-repo-identity.feature` | which repo a tab is in, and the branch |
| `git-working-tree.feature` | what is changed but not committed |
| `git-commit-graph.feature` | recent history, drawn with its branch structure |
| `git-pane-safety.feature` | a bad repo spoils at most its own pane |
| `git-pane-placement.feature` | cycling alongside the economy panel, across instances |

The Windows fast release and the VS Code split-terminal path trace to
[`../SPEC.md`](../SPEC.md); their scenarios are tagged `@AC#` back to the
acceptance criteria in SPEC §8 and §10 (`@AC9` = keep-tests-green / unit
coverage). The other features above predate that spec and carry no tags.

| Feature file | Tool / component | Spec | Acceptance |
|---|---|---|---|
| `windows-launcher.feature` | `src/launch-win.js` + `cmdLaunch` dispatch | §4.2, §5.1–5.2 | §8.2, §8.6 |
| `wt-args-builder.feature` | `buildWtArgs` / `findWindowsTerminal` (pure) | §5.2, §6, §9 | §8.9 |
| `statusline-injection.feature` | temp settings file + inline statusLine | §4.2.5, §5.3 | §8.8 |
| `sidecar-hosting.feature` | hosted `ccr sidecar` + exit sentinel | §1, §6 | §8.3–8.5 |
| `doctor-windows.feature` | `src/doctor.js` Windows branch | §5.4 | §8.1 |
| `fallback-no-wt.feature` | `fallbackNoWt()` | §2, §5.1, §6 | §8.7 |
| `vscode-sidecar.feature` | `src/launch-vscode.js` (split-terminal) | §10 | §10.1–10.6 |

## Traceability — every SPEC §8 and §10 criterion is covered

| § | Criterion | Covered by |
|---|---|---|
| 8.1 | doctor reports node/ccr/Windows Terminal, no "use WSL" | `doctor-windows` |
| 8.2 | one window, two panes (Claude left, sidecar ~34% right) | `windows-launcher` |
| 8.3 | sidecar waits, then renders live panel | `sidecar-hosting` |
| 8.4 | tool/skills feed updates (transcript tail) | `sidecar-hosting` |
| 8.5 | exiting Claude → "session ended" (sentinel round-trip) | `sidecar-hosting`, `wt-args-builder` |
| 8.6 | `ccr <profile>` targets CCS state dir; clear unknown-profile error | `windows-launcher` |
| 8.7 | no Windows Terminal → graceful fallback, non-zero, no crash | `fallback-no-wt` |
| 8.8 | no `~/.claude` mutation; statusLine via temp file, cleaned up | `statusline-injection` |
| 8.9 | `npm test` green; pure launch logic gets unit coverage | `wt-args-builder` |
| 10.1 | VS Code: Claude in the current pane + a prominent split banner | `vscode-sidecar` |
| 10.2 | sidecar one-liner carries the state dir; copied via OSC 52 | `vscode-sidecar` |
| 10.3 | exiting Claude drops the session-ended sentinel | `vscode-sidecar` |
| 10.4 | `ccr sidecar --hint` reprints the steps, never launches Claude | `vscode-sidecar` |
| 10.5 | `ccr <profile>` targets the CCS state dir; unknown errors clearly | `vscode-sidecar` |
| 10.6 | platform-aware split keybinding (Ctrl+Shift+5 / Cmd+\\) | `vscode-sidecar` |
