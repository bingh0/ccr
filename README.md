# ccr — Claude Code run-rate

> Know how fast you're burning your Claude Code subscription window — and whether
> clearing context now is worth it — without doing token math in your head.

**A solo side project, shared as-is** — built to scratch my own itch and
daily-driven. See [Status & support](#status--support) for what to expect, and
the acceptance criteria in [`features/`](features/) for exactly how the
burn-rate and clear-ROI math behaves.

---

## What it does

ccr reads Claude Code's own status-line JSON and your session transcripts and
shows you the **economy** of a session:

- **Burn rate** on your 5-hour (and weekly) rate-limit window — `%/min` and, more
  usefully, **how long until you hit the wall**.
- **Clear ROI** — in plain language, how many more minutes clearing context now
  would buy you.
- **Live tool/skills feed** — in the sidebar, a rolling view of recent tool and
  slash-command calls plus per-session stats (files touched, tokens generated).
- **Resume advisor** (`ccr resume`) — recent sessions ranked by what they'd cost
  to bring back (context size, share of the window, cold/warm cache), then it
  hands selection to `claude --resume`.
- **Git pane** — press **F3** in the sidebar for the repo each tab is in: the
  repo and branch, what's staged / modified / untracked / conflicted, and
  recent commits drawn in lanes like an IDE git graph. Read from `.git`
  directly (packfiles included) — no `git` binary is ever run, and the pane
  can't write or execute anything, structurally.
- **External tool panes** — the sidebar can render read-only status panes from
  other tools via a strict JSON contract; **F3** cycles between the economy
  panel, the built-in git pane, and each configured pane (see
  [External tool panes](#external-tool-panes-sidebar)).

For scripting and external tools (status bars, menu-bar widgets), `ccr economy
--json` emits a stable, versioned model — see
[`docs/JSON-CONTRACT.md`](docs/JSON-CONTRACT.md).

It is **read-only**: it never modifies `~/.claude/settings.json`, your
credentials, or any config. It targets **subscription** plans (Pro / Max); on
API/pay-as-you-go it degrades gracefully and just shows Claude Code's own cost.

## Quickstart

```bash
# zero-install, on-demand report (any OS):
npx claude-code-runrate economy

# or install the `ccr` command for the live statusline / sidebar:
npm i -g claude-code-runrate
```

## Surfaces

| Surface | What | Linux | macOS | Windows |
|---|---|:--:|:--:|:--:|
| `ccr economy` (CLI report) | Full panel on demand | ✅ | ✅ | ✅ |
| `ccr economy --json` | Stable machine-readable model (scripting) | ✅ | ✅ | ✅ |
| `ccr resume` | Recent sessions ranked by cost to resume | ✅ | ✅ | ✅ |
| `ccr statusline` | One-line summary wired into CC's `statusLine` | ✅ | ✅ | ✅ |
| `ccr sidecar` | Live dashboard + tool/skills feed | ✅ tmux | ✅ tmux | ✅ Windows Terminal / VS Code |

The CLI and statusline are pure Node — they run on native Windows. The live
sidebar runs on **Windows Terminal** (`ccr` splits it automatically) or inside
**VS Code's integrated terminal** on any OS (see [VS Code](#vs-code-split-terminal)).
On Linux/macOS the default host is `tmux`. No WSL required.

## Requirements

- **Node ≥ 22.17** — that's it for the core. **Zero runtime dependencies.**
- For the optional live `ccr sidecar`: **`tmux` ≥ 3.2** on Linux/macOS, or **Windows
  Terminal** / **VS Code's integrated terminal** on Windows (no WSL).

## VS Code (split terminal)

`ccr` detects VS Code's integrated terminal (`TERM_PROGRAM=vscode`) and wires the
live sidebar into a **split pane** — no separate window, no WSL. A shell can't
trigger the split itself, so `ccr` does everything around it:

1. Run `ccr` (or `ccr <profile>`). Claude starts in the **current** pane and a
   bright banner shows the steps. The sidecar command is **copied to your
   clipboard** automatically (via an OSC 52 escape — works over SSH/remote too).
2. **Split the terminal** — `Ctrl+Shift+5` (Windows/Linux) or `Cmd+\` (macOS).
3. **Paste** into the new pane and press Enter — the live sidebar runs there.

Lost the banner once Claude takes the screen? Run `ccr sidecar --hint` to reprint
the steps and re-copy the command.

The split is a **one-time** setup per VS Code window: an attached sidecar picks
each new `ccr` session up automatically, so relaunching prints a short note
instead of the banner. And if you do paste the one-liner into a second pane, the
older pane stands down by itself — there is never more than one live sidebar per
session. Instances stay independent — see
[Running more than one](#running-more-than-one) below.

On **Windows** this is the default inside VS Code (Windows Terminal otherwise
opens a separate window, so the in-editor split is nicer). On **Linux/macOS**,
`ccr` defaults to `tmux` (which works inside the VS Code terminal too); set
`CCR_VSCODE=1` to use the split-terminal flow there instead.

> Automating the split keystroke itself would need a VS Code extension (the `code`
> CLI has no "run command" verb) — out of scope for the zero-dependency core. The
> clipboard + `--hint` reduce it to split-and-paste.

## Running more than one

Open a second terminal and run `ccr` again. That's the whole procedure — nothing
to name, no flag. Each instance gets its own state dir, its own sidebar, and its
own tmux session and socket, so starting, clearing or quitting one never touches
the other. This holds for CCS profiles too: two `ccr cq` at once are two
independent instances of the same account.

**Instances are ephemeral.** State lives under `~/.ccr/instances/<n>` for the
session's lifetime and is deleted when it ends. Slots are **reused** — quit the
second instance and the next `ccr` takes slot 2 back rather than counting upward
forever. What outlives an instance lives at the top of `~/.ccr`: account burn
history, and a small per-session join log (`session-<id>.jsonl` — which
instance, profile and directory a Claude session ran as, for when you're
reconstructing what happened) — both pruned 31 days after their session ends.
Up to 32 instances can be live at once; a 33rd launch refuses rather than
sharing state. Account-wide meters (the 5h and weekly walls) are reconciled
across live instances, so two sidebars agree even when one has been idle.

**Every instance has a name.** By default it's the repository (or directory)
you launched from — a second instance from the same repo becomes `gitrepo2` —
or pick one with `ccr --name side-project`. Characters outside `A-Za-z0-9._-`
become `-`; an explicit `--name` is rejected rather than repaired, and refused
if that name is already live. The name is how you see and address an instance:

- the **terminal tab title** is `name` (or `profile / name`), set once at
  launch and never changed mid-session — it is the tab's address;
- the **status line** leads with `name @ location`, and the location is live —
  it follows a mid-session `cd`, and is dropped when it would only repeat the
  name;
- the **sidebar** heads every view with the name;
- **`-i <name>`** targets a live instance from anywhere: `ccr economy -i
  side-project`, `ccr sidecar -i …`, `ccr cycle-view -i …`. Without `-i`,
  those three commands resolve the instance from your working directory (the
  live instance whose launch directory contains it) — and when that's
  ambiguous they list the candidates instead of guessing. Every panel is
  headed by the name it resolved to.

Setting `CCR_STATE_DIR` (and/or `CCR_SESSION`) still pins an instance wherever
you want it, and always wins over the automatic choice.

**Upgrading from 0.3:** the first launch migrates `~/.ccr` once — burn history
moves to the top of the container and old per-profile state dirs are swept
(they held nothing else that outlives a session). Migration refuses while any
old session is still running, and names what to close.

> `tmux ls` won't list ccr's sessions — each runs on its own socket. Use
> `tmux -L ccr ls` (or `-L ccr-2` for slot 2 — profile launches ride slot
> sockets too now).

## Wiring the statusline into Claude Code

In `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "ccr statusline" } }
```

(Install the binary with `npm i -g claude-code-runrate` rather than using `npx` here — Claude
Code calls the status line frequently, and a resolved binary avoids per-tick
latency.)

## External tool panes (sidebar)

The live sidebar can host **read-only panes from other tools**. A tool writes a
small JSON blob beside its own artifacts; you list that file's path in ccr's
config; the sidebar cycles between the economy panel, the built-in git pane, and
each configured pane.

**Cycling views.** Under tmux the launcher binds **F3** at the host. **Windows
Terminal** binds no key of its own, and neither do VS Code and its forks (Cursor,
Positron, Antigravity) — so on those the sidecar pane carries its own key: click
the pane and press **Space** or **F3**. The renderer still reads no input — the
key lives in a separate parent process that runs the panel as a child, the same
separation tmux enforces. Anywhere else, `ccr cycle-view -i <name>` (or
`--state-dir <dir>`); a bare `ccr cycle-view` resolves the instance from your
working directory, like `ccr economy` does.
`ccr sidecar --view <n>` opens on a chosen view (0 economy, 1 git, 2+ panes).

Config lives at `~/.config/ccr/config.json` (`$XDG_CONFIG_HOME` respected,
`CCR_CONFIG` overrides) — deliberately *not* in ccr's state dir, and never
read from a repository:

```json
{ "panes": [ { "path": "/home/you/project/.your-tool/sidecar.json" } ] }
```

A leading `~` expands, with either separator (`~/tools/blob.json`,
`~\tools\blob.json`), and a relative path resolves against the config file's own
directory. **On Windows, save the file as UTF-8** — `>` and `Out-File` in Windows
PowerShell 5.1 write UTF-16, which is not JSON as far as any parser is concerned:

```powershell
Set-Content -Encoding utf8 $env:USERPROFILE\.config\ccr\config.json $json
```

`ccr doctor` reports what it read out of the config — the paths as **resolved**,
not as written — and names the problem when there is one, so a pane that never
appears is a question you can answer rather than a silence.

A pane is a full-height view carrying the producing tool's own rows — here
`gherkin-trace`, whose blob ships as the golden example:

```
trace  gherkin-trace   3/3
  refresh · 2026-08-01 14:10 · blob written 0s

  ● attention     3   1 breach, 2 orphans
  ● reviewed      8
  ◌ heat          withheld   no natural break
  ◌ binding       dark   no run manifest
  ● fence         clean  ▁▅▂█
  ● exceptions    0
  · experimental  off
```

- ccr **reads the file, validates it, renders it** — that is the entire
  integration. No subprocess, no plugin code, no schema knowledge of the
  producing tool: a pane is data all the way down, and every blob string is
  stripped of control bytes before it touches your terminal.
- **Producers never know ccr exists.** You wire the join by hand, exactly like
  Claude Code's own `statusLine` — neither side takes a dependency on the other.
- **Config order is cycle order.** F3 goes economy panel → git pane → first pane
  → second pane → back to economy; the `3/3` above is that position, for the one
  configured pane in the example. The position marker appears only once you have
  configured a pane — the two built-in views identify themselves, so numbering
  them buys nothing. Entries are never de-duplicated, so listing one path twice
  gives you two panes. The config is re-read every tick — adding a pane takes
  effect without relaunching.
- **The producer is trusted for content, never for behaviour.** ccr executes
  nothing from a blob and draws no value it has not validated, so a hostile file
  cannot crash the panel or escape into your terminal — but what a pane *says*
  is the producing tool's word, not ccr's. Point it only at files you would read
  yourself.
- A malformed config yields no panes and a malformed blob renders as a **named
  error state** — never a crash, never a misrender.
- The blob format is specified in
  [`docs/PANE-CONTRACT.md`](docs/PANE-CONTRACT.md), with a golden example at
  [`docs/pane-blob.golden.json`](docs/pane-blob.golden.json). Anything that
  writes a conforming blob is a producer — there is no registry.

## Development

This project is built **BDD-first**: the Gherkin in [`features/`](features/) is
the source of truth, executed by a hand-rolled zero-dependency harness on top of
Node's built-in test runner — a single-file Gherkin parser + runner that supports
the practical core of the grammar and rejects everything else loudly rather than
mis-parsing it. The harness is available standalone as
[`gherkin-node-test`](https://github.com/bingh0/gherkin-node-test) on
[npm](https://www.npmjs.com/package/gherkin-node-test) (that repo is the
canonical source; `test/gherkin.js` is a vendored copy). See
[`docs/GHERKIN.md`](docs/GHERKIN.md) for the grammar, the deliberate limits,
and the API.

The *practice* is documented separately in [`docs/BDD.md`](docs/BDD.md): what
these scenarios (271 of them, at 0.4.0) took from conventional BDD, where they departed — refusals
as a quarter of the specification, tags that are gates rather than filters,
comments that carry rulings — and why. It also places ccr in the lineage the
method has followed since, and is honest about which point on that line this
repository represents.

```bash
npm test              # node --test — harness self-tests + feature scenarios
npm run typecheck     # tsc --noEmit over @ts-check'd JS (needs: npm i first)
npm run install-hooks # copy .githooks/ into this clone (run once)
```

`install-hooks` installs a fail-closed `pre-push` guard for the public remote:
only `main`, fast-forward only, and a scan of the commits the push would make
public. It is worth running in any clone you push from — a push is the moment
history stops being private, and it is the last moment the check can help.

- **No runtime dependencies**, ever — it's what lets `npx claude-code-runrate` install
  instantly on every OS, including native Windows.
- **Dev-only** tooling (`typescript`, `@types/node`) exists solely for
  `npm run typecheck`; it is never installed for consumers, so the runtime
  promise is untouched.
- All source uses `// @ts-check` + JSDoc — type-checked, but shipped as plain JS
  that runs straight from source (no build step, no `dist/`).

## Status & support

ccr is a **solo side project**. I built it to answer one question for myself —
*am I about to hit my Claude Code limit, and is clearing context worth it?* — and
I'm sharing it in case it's useful to you too. I use it daily, but please treat it
as **best-effort and as-is**:

- **Issues** — I read them all. Triage is usually within a week or two, faster for
  anything that breaks the core (the economy/statusline math, or a platform that
  won't run). A minimal repro and your OS + Node version help a lot.
- **Fixes** — core bugs get priority; nice-to-haves may sit for a while.
- **Pull requests** — welcome, especially small, focused ones with a test. I review
  on the same best-effort cadence. For anything large, please open an issue first so
  we don't both sink time into something I'd want shaped differently.
- **No SLA and no roadmap promises.** Things land when I have the itch or a good PR
  shows up. If ccr stops being maintained I'll say so plainly at the top of this file.

If it saved you some token math, that's the whole goal. 🎸

## License

[MIT](LICENSE) © 2026 Bing Ho
