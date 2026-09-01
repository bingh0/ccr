# Changelog

Every release also has a [GitHub release](https://github.com/bingh0/ccr/releases)
and a release commit, and those carry the full notes — what was measured, what
was rejected, and why. This file is the index: enough to decide whether a
version is worth upgrading to, and where to read the rest.

Dates are npm publish dates, because that is when a version reached anyone.

## 0.6.0 — 2026-09-01

The remote-session release. Over mosh, two things had been degrading in
silence — every clipboard copy was dropped in transit, and 24-bit colour was
quietly flattened to 256 — and the tmux version floor the sidecar had grown
was written down nowhere. All three were measured at the terminal, reading
the raw bytes that reach a mosh client, not inferred.

- **The clipboard survives mosh.** tmux's built-in OSC 52 emits an empty
  selection field and mosh's parser accepts only an explicit `c`, so every
  copy vanished between the two. The shipped tmux config now spells the
  selection out — and names `c` explicitly, which is *more* compatible than
  tmux's default everywhere, not a mosh-only workaround.
- **True colour survives mosh.** mosh forces `TERM=xterm-256color` and drops
  `COLORTERM`, which tmux reads as "no RGB" and silently downgrades every
  24-bit colour to the nearest 256. The config now declares RGB for that
  TERM, restoring what mosh was carrying fine all along.
- **The tmux floor is declared: 3.2.** Percentage splits and
  `terminal-features` need 3.1; the pane-scoped hooks that keep the sidebar
  out of copy-mode need 3.2. Below the floor each failure is silent and looks
  like something else, so `ccr doctor` now reports the tmux version and names
  one that is too old — and an unreadable version is reported as unreadable,
  never manufactured into a failure.
- **The sidebar split speaks tmux 3.4's dialect.** `-p 34` was deprecated in
  3.1 and rejected outright in 3.4; the launcher sizes with `-l 34%`, which
  every supported tmux accepts.
- **The Node floor rises to 22.17.** Node 18 and 20 are past their end of
  life, and the vendored test runner's own floor is 22.17 — testing below it
  produced a lane that hung rather than failed. `engines`, the CI matrix,
  `ccr doctor`'s check, and the spec all state the same floor now, and the
  matrix pins 22.17 exactly so the floor is tested, not just declared.
- **The acceptance suite hardened underneath.** The vendored Gherkin runner
  moved to gherkin-node-test 0.11.0, whose step linter enforces a rule the
  suite now lives by: a negative assertion over a literal needle passes
  forever once the needle rots, so *absence must be earned* — by a control
  proving the needle can still find, or a sanction naming what proves it.
  Every structural refusal in the step layer (the renderer spawns nothing,
  the launcher reads no blob, the sidecar has no input channel) now carries
  one or the other, and both of 0.11's linters gate the suite.

## 0.5.0 — 2026-08-22

The Windows release. The things that could not be reasoned about were measured
on a real Windows 11 machine, because none of them are reachable from CI: every
Windows test injects the launcher, so the suite proves the argv `ccr` builds and
nothing about what Windows Terminal does when handed it.

- **The panes open where `ccr` was run.** `wt.exe` does not inherit the working
  directory the way `tmux new-session` does, so every pane opened in
  `%USERPROFILE%` while the launch record claimed otherwise — and the sidecar
  prefers that record, so the git pane described the project in full confidence
  for a terminal that was not in it. One source now feeds both.
- **Measured limits, and they are real.** Past 256 characters `wt` opens *no
  tab at all*; a UNC path opens a tab and silently lands in `%SystemRoot%`; a
  semicolon costs the whole tab; a backtick does not, so refusing it was wrong
  and no longer happens. Each unusable path degrades — the panes open in the
  default directory and stderr names which of the four reasons applied.
- **The sidecar pane has a cycle key** on Windows Terminal. F3 or Space. F3 has
  three encodings and on Windows which one arrives depends on the *Node*
  version, so `ccr` answers all three rather than pinning a Node floor for a
  keystroke.
- **A pane config that says what is wrong.** A UTF-8 BOM is stripped; UTF-16 —
  what PowerShell 5.1 writes for `>` and `Out-File` — is named as an encoding
  problem instead of reported as bad JSON; `~\` expands as well as `~/`; and a
  broken config says so on the panel and in `ccr doctor`, which reports pane
  paths as *resolved*.
- **`ccr sidecar` resolves the instance from the working directory**, which the
  feature files and the README had both described for a while.
- **The economy screen earns a decimal** where the next tenth is a decision: at
  or past 95% used, one truncated digit, so `floor(shown)` still matches
  `/usage`. A snapshot that stopped refreshing dims rather than blanks.

## 0.4.0 — 2026-08-07

[The instance layer and the git pane.](https://github.com/bingh0/ccr/releases/tag/v0.4.0)

- **Instances.** Every launch is a named, slotted instance under one container
  home; the name is derived from the project or given with `-i`, and travels
  into the window title, status line and sidebar.
- **A git pane** on F3: which repository the tab is in, the working tree, and
  recent history in lanes. Read-only — it never writes to the repository.
- The three launchers (tmux, Windows Terminal, VS Code) take naming, titles and
  retention from one shared path rather than the tmux path owning them.

## 0.3.0 — 2026-08-04

[External tool panes in the sidebar.](https://github.com/bingh0/ccr/releases/tag/v0.3.0)

- **Panes from other tools.** The sidebar hosts full-height read-only panes
  rendered from small JSON blobs another tool writes beside its own artifacts.
  You list the path in `~/.config/ccr/config.json`; F3 cycles.
- A rate-limit correctness fix, and `strict` type checking across the codebase.

## 0.2.4 — 2026-07-12

[VS Code sidecars stop piling up; profile state-dir fix.](https://github.com/bingh0/ccr/releases/tag/v0.2.4)

- One live sidecar per session: relaunching inside VS Code no longer
  accumulates identical panes.
- Profile sessions write their snapshots to the right state dir.

## 0.2.3 — 2026-07-03

[Sidecars agree on 5h/weekly across profiles.](https://github.com/bingh0/ccr/releases/tag/v0.2.3)

- The 5h and weekly walls are one account-wide resource, but each profile only
  captures its own; two sidecars on the same account could disagree. They
  reconcile now.

## 0.2.2 — 2026-07-02

[Aligned meter bars + a staleness marker.](https://github.com/bingh0/ccr/releases/tag/v0.2.2)

- A barely-used window projects an enormous time-to-exhaust, which overflowed
  the fixed time column and shoved that row's bar out of line. Long horizons
  are capped, so the bars stay aligned and the figure reads more honestly.
- A stale snapshot is annotated (`· updated Nm ago`) rather than silently
  frozen. Never a wipe — Claude Code legitimately stops ticking during a long
  operation.

## 0.2.1 — 2026-06-26

[Windows Terminal teardown and sidecar width fixes.](https://github.com/bingh0/ccr/releases/tag/v0.2.1)

- ConPTY makes a split pane's reported width unreliable, so the panel
  soft-wrapped. The launcher injects the computed width and the sidecar clamps
  to the smaller of the two.
- On exit the sidecar pane collapses first and the border sweeps left to right,
  fixing an ordering bug where Claude's pane could close first.

## 0.2.0 — 2026-06-26

[Native Windows and VS Code live sidecars.](https://github.com/bingh0/ccr/releases/tag/v0.2.0)

- **Native Windows** — the live sidecar hosted in Windows Terminal split panes,
  no tmux, bash or WSL, with a graceful fallback when `wt.exe` is absent.
- **VS Code integrated terminal on any OS** — split-pane sidecar via a
  clipboard one-liner.
- `statusLine` injected per launch through a temp settings file, so `~/.claude`
  is never mutated.

## 0.1.0 — 2026-06-24

First publish: the CLI and status line — `economy`, `resume`, `statusline` —
with the live sidebar on tmux. Native Windows arrived in 0.2.0.
