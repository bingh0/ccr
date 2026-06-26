# Acceptance criteria — Gherkin features

These `.feature` files specify the acceptance criteria for each necessary tool the
Windows fast release builds (see [`../SPEC.md`](../SPEC.md)). Scenarios are tagged
`@AC#` to trace back to the eight acceptance criteria in SPEC §8 (`@AC9` =
keep-tests-green / unit coverage).

| Feature file | Tool / component | Spec | Acceptance |
|---|---|---|---|
| `windows-launcher.feature` | `src/launch-win.js` + `cmdLaunch` dispatch | §4.2, §5.1–5.2 | §8.2, §8.6 |
| `wt-args-builder.feature` | `buildWtArgs` / `findWindowsTerminal` (pure) | §5.2, §6, §9 | §8.9 |
| `statusline-injection.feature` | temp settings file + inline statusLine | §4.2.5, §5.3 | §8.8 |
| `sidecar-hosting.feature` | hosted `ccr sidecar` + exit sentinel | §1, §6 | §8.3–8.5 |
| `doctor-windows.feature` | `src/doctor.js` Windows branch | §5.4 | §8.1 |
| `fallback-no-wt.feature` | `fallbackNoWt()` | §2, §5.1, §6 | §8.7 |
| `vscode-sidecar.feature` | `src/launch-vscode.js` (split-terminal) | §10 | §10.1–10.6 |

Every `.feature` here is **executable**: each has step definitions registered in
[`../test/steps/index.js`](../test/steps/index.js) and runs under `npm test` (no
`todo` placeholders). Implementation-detail assertions (exact argv tokens, glyph
literals) live in the `test/*.test.js` unit layer underneath.

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
