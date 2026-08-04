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
- **External tool panes** — the sidebar can render read-only status panes from
  other tools via a strict JSON contract; **F3** cycles between the economy
  panel and each configured pane (see [External tool panes](#external-tool-panes-sidebar)).

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

- **Node ≥ 18.3** — that's it for the core. **Zero runtime dependencies.**
- For the optional live `ccr sidecar`: `tmux` on Linux/macOS, or **Windows
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
session. Profiles stay independent: a personal `ccr` and a work `ccr <profile>`
run side by side, each with its own state dir and its own sidebar.

On **Windows** this is the default inside VS Code (Windows Terminal otherwise
opens a separate window, so the in-editor split is nicer). On **Linux/macOS**,
`ccr` defaults to `tmux` (which works inside the VS Code terminal too); set
`CCR_VSCODE=1` to use the split-terminal flow there instead.

> Automating the split keystroke itself would need a VS Code extension (the `code`
> CLI has no "run command" verb) — out of scope for the zero-dependency core. The
> clipboard + `--hint` reduce it to split-and-paste.

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
config; the sidebar cycles between the economy panel and each configured pane
(**F3** under tmux — the launcher binds it; `ccr cycle-view` on any host).

Config lives at `~/.config/ccr/config.json` (`$XDG_CONFIG_HOME` respected,
`CCR_CONFIG` overrides) — deliberately *not* in ccr's state dir, and never
read from a repository:

```json
{ "panes": [ { "path": "/home/you/project/.your-tool/sidecar.json" } ] }
```

A pane is a full-height view carrying the producing tool's own rows — here
`gherkin-trace`, whose blob ships as the golden example:

```
trace  gherkin-trace   2/2
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
- **Config order is cycle order.** F3 goes economy panel → first pane → second
  pane → back to economy; the `2/2` above is that position. Entries are never
  de-duplicated, so listing one path twice gives you two panes. The config is
  re-read every tick — adding a pane takes effect without relaunching.
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

```bash
npm test            # node --test — harness self-tests + feature scenarios
npm run typecheck   # tsc --noEmit over @ts-check'd JS (needs: npm i first)
```

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
