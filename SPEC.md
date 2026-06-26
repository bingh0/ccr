# ccr Windows fast release — engineering spec

**Goal:** make `ccr` (and `ccr <profile>`) launch a live, side-by-side sidecar on
native Windows — Claude Code in one pane, `ccr sidecar` in another — without WSL,
without breaking the zero-dependency / no-config-mutation contract.

**Scope:** replace only the bash + tmux **launch layer**. The entire pure-Node
core (`src/*`, the `economy`/`statusline`/`resume`/`sidecar`/`doctor` commands)
is reused as-is.

---

## 1. Gap analysis — what exists vs. what's missing

### Works natively today (do not touch)

| Component | File | Note |
|---|---|---|
| CLI dispatch | `bin/ccr.js` `main()` | `parseArgs`, all subcommands route fine |
| One-line status | `bin/ccr.js` `cmdStatusline()` | reads stdin JSON, writes snapshot, prints line |
| Full panel | `bin/ccr.js` `cmdEconomy()` + `src/render/economy.js` | ANSI/glyphs render in Windows Terminal |
| Resume advisor | `cmdResume()` + `src/resume.js` | `os.homedir()`-based, cross-platform |
| **The sidecar loop** | `src/sidecar.js` `run()` | pure-Node 1s ANSI redraw — already platform-agnostic; it simply had no Windows host to run inside |
| Transcript tail | `src/transcripts.js` | path handling already uses `path`/`os.homedir()` |
| State dir | `src/state-dir.js` `ensureSecureDir()` | `0700`/`0600` modes are no-ops on NTFS but harmless |

### Missing / blocked on Windows

| Component | File | Problem |
|---|---|---|
| Launcher | `bin/ccr.js` `cmdLaunch()` (the `win32` branch, ~line 166) | hard-stops with a "use WSL" message |
| Launch script | `scripts/launch.sh` | bash-only; builds the tmux session |
| Multiplexer | (tmux) | not present on Windows; the pane split, env wiring, keybindings |
| Statusline shim | `sidecar/ccr-statusline` | `#!/bin/sh`; resolves node via nvm globs; not runnable as a Windows `statusLine` command |
| tmux bindings | `sidecar/ccr.tmux.conf` | F2→`/clear`, scrollback save, mouse, OSC52 clipboard |
| `doctor` Windows messaging | `src/doctor.js` | tells Windows users the sidebar is "WSL-only — by design" |

---

## 2. Chosen approach: Windows Terminal as the tmux equivalent

### Decision

Use **Windows Terminal (`wt.exe`)** split panes as the multiplexer, driven purely
through its command line. Rationale:

- **Zero new dependencies.** `wt.exe` ships with Windows 11 (Store-installable on
  Win10). We add no npm packages and no native binaries — the
  `npx claude-code-runrate` instant-install promise is preserved.
- **Glyphs, color, mouse, scrollback, clipboard for free.** Windows Terminal is a
  ConPTY host: the block glyphs (`▓ ░ ●`) and ANSI used by `renderEconomy` and
  the sidecar's cursor-home redraw work without change. (One ConPTY caveat: a
  split pane's `process.stdout.columns` is unreliable, so the launcher injects the
  computed pane width as `CCR_SIDECAR_COLS` and the sidecar clamps to it — see
  §4.2 step 6 and §5.2.)
- **It already runs Claude Code well.** Pane 0 is just a normal interactive
  Claude session — no PTY shimming on our side.

### Alternatives considered (rejected)

| Option | Why not |
|---|---|
| `node-pty` + a self-rendered in-process mux | Native addon → breaks zero-dep + instant install; large maintenance surface. The whole point of reusing `ccr sidecar` is to *avoid* re-implementing a multiplexer. |
| Raw ConPTY via Node FFI | Same native-dependency problem; far more code than the fast release warrants. |
| Two independent terminal windows | No real "sidecar" (not side-by-side, no shared focus). Kept only as the **fallback** when `wt.exe` is absent. |
| WSL (status quo) | Defeats the purpose — this release exists to remove the WSL requirement. |

### Layout produced

`wt.exe -w 0 new-tab` reuses the **current** Windows Terminal window (a new tab in
the window you ran `ccr` from, not a separate window), runs Claude in the first
pane, then `split-pane` runs the sidecar at ~34% width (matching upstream
`CCR_SIDEBAR_PCT` default of 34). The split is vertical (`-V`, sidecar on the
right) by default; set `CCR_SIDEBAR_SIDE=bottom` for a horizontal split (`-H`,
sidecar below).

On exit the tab folds itself back: both panes run under `cmd /c` (not `cmd /k`),
so each closes when its command ends. Claude's pane drops the `exited` sentinel
then lingers ~1s; the sidecar (`--exit-on-end`) detects the sentinel within
~120ms and closes after a ~200ms grace — so the **right pane collapses first** and
the border sweeps left→right as Claude expands to fill, then the tab closes. This
mirrors the tmux launcher's `kill-session` sweep.

---

## 3. External tools the release depends on

| Tool | Required? | Used for | Detection |
|---|---|---|---|
| `wt.exe` (Windows Terminal) | required for the **sidecar**; optional for everything else | hosting the two panes | `where wt` / `where wt.exe` |
| `node` | required | runs ccr + resolves itself for the statusline shim | `process.execPath` (preferred) / `where node` |
| `claude` | required | pane 0 | `where claude` |
| `ccs` | optional | `ccr <profile>` | `where ccs` |
| `cmd.exe` / PowerShell | present by default | per-pane env injection + launch glue | n/a |

No tool is bundled. Absence of `wt.exe` triggers the documented fallback, never a
crash.

---

## 4. New files

### 4.1 Statusline injection (no shim shipped)

The injected `statusLine.command` is the **inline form** — node + `bin/ccr.js`
resolved by absolute path (see §5.3). Because that value lives inside the JSON
settings *file* (never on a shell line), no quoting is involved and no separate
`.cmd` shim is needed. (An earlier draft shipped `sidecar/ccr-statusline.cmd` as a
fallback; `run()` never invoked it, so it has been removed.)

### 4.2 `scripts/launch.ps1` *or* `src/launch-win.js` — the Windows launcher

A direct port of `scripts/launch.sh` semantics. **Recommendation: `src/launch-win.js`**
(a Node module invoked from `cmdLaunch`) so it shares `parseArgs`, path, and
validation logic with the rest of ccr and avoids a PowerShell execution-policy
dependency. It must:

1. **Validate the profile** — same `^[A-Za-z0-9._-]+$` allow-list as `launch.sh`
   (the value lands in filesystem paths and a spawned command).
2. **Resolve binaries** — `node` via `process.execPath`; require `claude` (or
   `ccs <profile>`) on PATH; require `wt.exe` (else → fallback, §6).
3. **Resolve profile state** — `claude` → `SESSION=ccr`, `STATE=~/.ccr`;
   `ccs <profile>` → `SESSION=ccr-<profile>`, `STATE=~/.ccr/<profile>`; honor
   `CCR_SESSION` / `CCR_STATE_DIR` overrides. Verify
   `~/.ccs/instances/<profile>` exists, listing available profiles on miss.
4. **Prepare state** — `ensureSecureDir(STATE)`; remove the stale `exited`
   sentinel.
5. **Write a temp settings file** (`%TEMP%\ccr-settings-XXXX.json`) containing
   `{"statusLine":{"type":"command","command":"<shim>"}}` and pass
   `claude --settings <file>`. A **file path sidesteps the Windows
   command-line JSON-quoting minefield** that an inline `--settings '{...}'` would
   hit. Best-effort cleanup of the temp file after the window closes.
6. **Build and spawn the `wt.exe` command** (§5.1), passing `CCR_STATE_DIR` into
   **both** panes' environments and `CCR_SIDECAR_COLS` (the computed pane width)
   into the sidecar's, so it clamps every line and never soft-wraps in the narrow
   split (ConPTY's per-pane `process.stdout.columns` can't be trusted here).
7. **Sentinel + sweep on exit** — pane 0 drops `STATE/exited` when Claude exits
   (sidecar flips to a clean "session ended"), then lingers ~1s so the sidecar's
   `--exit-on-end` pane closes first; both `cmd /c` panes fold and the tab closes,
   border sweeping left→right (§2 "Layout produced").

### 4.3 (optional) `sidecar/ccr.wt.fragment.json` — keybinding fragment

Deferred (see §7). Windows Terminal can load JSON fragment files that define
actions/keybindings (e.g. an `F2 → sendInput "/clear\r"` action). This is the
closest equivalent to the tmux `bind-key -n F2` config and would be the Phase 2
path if F2→/clear is wanted.

---

## 5. Modified / new functions

### 5.1 `bin/ccr.js` — `cmdLaunch(profile)`

Replace the `win32` early-return block with a dispatch into the Windows launcher.

```js
function cmdLaunch(profile) {
  if (process.platform === 'win32') {
    return require('../src/launch-win').run(profile);   // NEW
  }
  // ...existing bash/tmux path unchanged...
}
```

The current "use WSL" message moves into `launch-win` as the **fallback** when
`wt.exe` is absent — so users without Windows Terminal still get a helpful
message plus the working native CLI commands, not a dead end.

### 5.2 `src/launch-win.js` — new module

```js
/** ccr [profile] on native Windows: split Windows Terminal, claude + sidecar. */
function run(profile) { /* §4.2 steps 1–7; returns an exit code */ }

/** Resolve wt.exe, or null. */
function findWindowsTerminal() { /* `where wt` */ }

/** Build the argv for wt.exe: pane 0 = claude --settings <file>; split; pane 1 = ccr sidecar. */
function buildWtArgs({ ccCmd, settingsFile, stateDir, node, ccrJs, sidebarPct, sidebarSide, termCols }) { /* ... */ }

/** Computed sidecar pane width (for CCR_SIDECAR_COLS), or null if termCols is unknown. */
function sidecarCols(termCols, fracNum, splitFlag) { /* ... */ }

/** The graceful no-Windows-Terminal fallback (prints native-CLI guidance). */
function fallbackNoWt() { /* returns 1 */ }
```

`buildWtArgs` produces something equivalent to:

```
wt.exe -w 0 new-tab --title "Claude" cmd /c "set CCR_STATE_DIR=<state>&& claude --settings <file> & type nul > <state>\exited & del /q <file> & ping -n 2 127.0.0.1 >nul"
       `;` split-pane -V -s 0.34 cmd /c "set CCR_STATE_DIR=<state>&& set CCR_SIDECAR_COLS=<n>&& node <ccrJs> sidecar --exit-on-end"
```

Notes:
- `-w 0` targets the **current** window (reuse, not a new window); the `;` pane
  separator is its own argv token.
- Env is injected per-pane via `cmd /c set VAR=...&& ...` so each pane inherits
  `CCR_STATE_DIR` (and the sidecar `CCR_SIDECAR_COLS`) like the tmux
  `set-environment` / `export` preamble upstream.
- Both panes run under `cmd /c` (not `/k`) so they self-close. Pane 0's tail —
  `type nul > exited` (sentinel) → `del /q <file>` (settings cleanup) →
  `ping -n 2 127.0.0.1 >nul` (~1s linger) — sequences the teardown so the sidecar
  collapses first (§2, §4.2 step 7). `ping` is a reliable ~1s wait; cmd.exe's
  wait primitives have 1-second granularity, so that is the practical floor.
- `termCols` is the launcher's own `process.stdout.columns`; `sidecarCols` turns
  it into the pane width (fraction of width for `-V`, full width for `-H`). It is
  omitted when unknown (non-TTY launch), and the sidecar then falls back to
  `min(live columns, hint)` with no hint.

### 5.3 Settings injection — `command` value

The launcher writes the **inline form** into the temp settings **file** (so the
outer shell never has to quote the JSON):
`{"statusLine":{"type":"command","command":"\"<node>\" \"<repo>/bin/ccr.js\" statusline"}}`
`buildStatusLineCommandInline()` resolves `<node>`/`<repo>` by absolute path.

### 5.4 `src/doctor.js` — `run()` Windows branch

Update the `isWin` messaging (currently "needs tmux + bash — for that, use WSL").
New behavior:
- Add a Windows Terminal check: `has('wt')` → `✓ Windows Terminal (sidecar host)`
  or `⚠ Windows Terminal not found — sidecar needs it (winget install
  Microsoft.WindowsTerminal); the CLI still works`.
- Reword the sidebar lines to say the sidecar runs natively via Windows Terminal,
  not WSL.
- Keep node / ccr-on-PATH / ccs / capture-status checks as-is (already
  cross-platform). The `isExec` 0o111 check stays gated behind `!isWin`.

### 5.5 `package.json` — `files`

`src/` and `sidecar/` are already globbed, so `src/launch-win.js` and
`src/launch-vscode.js` ship with no `files` change. No new `.cmd`/`.ps1` assets.

---

## 6. tmux → Windows Terminal feature mapping

| tmux feature (`launch.sh` / `ccr.tmux.conf`) | Windows Terminal equivalent | Status |
|---|---|---|
| `new-session` + `split-window -h -p 34` | `wt -w 0 new-tab ... ; split-pane -V -s 0.34 ...` | ✅ MVP |
| pane 0 runs `claude --settings` | `wt` pane 0 `cmd /c claude --settings <file>` | ✅ MVP |
| pane 1 runs `ccr sidecar` | `wt` pane 1 `cmd /c node bin/ccr.js sidecar --exit-on-end` | ✅ MVP |
| `export CCR_STATE_DIR` into panes (`set-environment`) | `cmd /c set CCR_STATE_DIR=...&& ...` per pane | ✅ MVP |
| `touch exited` on Claude exit → sidecar "ended" state | append `& type nul > <state>\exited` to pane 0's command | ✅ MVP |
| `kill-session` sweep on exit | both panes `cmd /c` + `--exit-on-end`; pane 0 lingers so the sidecar collapses first (border sweeps left→right) | ✅ MVP |
| `set -g mouse on` | Windows Terminal default (mouse select/scroll) | ✅ free |
| `history-limit 50000` (scrollback) | Windows Terminal scrollback (configurable, large default) | ✅ free |
| `set-clipboard on` (OSC52) | Windows Terminal native copy (Ctrl+Shift+C / mouse) | ✅ free |
| `bind-key -n F2 send-keys '/clear' Enter` | WT fragment action `sendInput "/clear\r"` | ⏸ Phase 2 (§7) |
| `bind-key P` save-pane-to-file | WT "export text" / no direct CLI equiv | ⏸ deferred |
| clean re-launch | `wt -w 0` reuses the current window (new tab); the tab self-closes on exit | ✅ MVP |

---

## 7. Out of scope for the fast release (Phase 2+)

- **F2 → `/clear`.** Requires either a Windows Terminal keybinding **fragment**
  installed into the user's WT settings (a config-mutation the upstream contract
  avoids — needs design) or a separate input-injection helper. Document the
  manual `/clear` for the fast release.
- **`prefix + P` save-pane-to-file.** Windows Terminal has no CLI for dumping a
  specific pane's scrollback; users can select+copy. Defer.
- **Standalone `.exe` packaging.** Out of scope; the release ships as the npm
  tarball, same as upstream.

---

## 8. Acceptance criteria

The fast release is done when, on a clean Windows 11 box with Node ≥ 18.3,
Claude Code, and Windows Terminal:

1. `ccr doctor` reports node, ccr-on-PATH, and **Windows Terminal found**, with no
   "use WSL" language.
2. `ccr` opens **one Windows Terminal window with two panes** — Claude Code left,
   `ccr sidecar` right (~34%).
3. The sidecar shows `waiting for the first status tick…`, then renders the live
   economy panel (correct glyphs/colors) once Claude produces a status tick.
4. The tool/skills **feed** updates as the session runs (transcript tail works).
5. Exiting Claude (pane 0) flips the sidecar to **`session ended`** (sentinel
   round-trips).
6. `ccr <profile>` does the same against the CCS profile's state dir, and errors
   clearly on an unknown profile.
7. With Windows Terminal **absent**, `ccr` prints the graceful fallback (native
   CLI guidance) and exits non-zero — **no crash, no stack trace**.
8. **No file under `~/.claude` is modified**; `statusLine` is injected only via
   the per-launch temp settings file, which is cleaned up.
9. `npm test` (the BDD harness) stays green; any new logic in `launch-win.js`
   that is pure (arg-building, profile validation) gets unit coverage. The
   non-Windows `launch.sh` path is unchanged.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Windows command-line JSON quoting for `--settings` | Write a **temp settings file**, pass its path (§4.2 step 5). |
| `wt.exe` argument parsing (`;` separator, nested quotes) | Centralize in `buildWtArgs`; cover with a unit test asserting the exact argv; prefer `cmd /c` wrappers over deep inline quoting. |
| Per-pane env not inherited | Inject via `cmd /c set VAR=...&& ...` rather than relying on `wt` global env. |
| Sidecar soft-wraps in the narrow split (ConPTY `columns` unreliable) | Launcher computes the pane width and injects `CCR_SIDECAR_COLS`; sidecar clamps to `min(live columns, hint)` (§4.2 step 6, §5.2). |
| Windows Terminal not installed (Win10) | Detect and fall back; `doctor` flags it with the `winget` install hint. |
| NTFS has no `0700`/`0600` | Accept best-effort (upstream `ensureSecureDir` already tolerates failure); note Windows ACLs as a Phase 2 hardening item. |
| Claude Code `--settings` semantics differ across versions | Inline-command form in a temp settings file (§5.3); re-introduce a shim only if a future version needs it. |

---

## 10. VS Code integrated terminal (split-pane sidecar)

**Goal:** when `ccr` runs inside VS Code's integrated terminal, deliver the live
sidecar as an in-editor **split pane** — no separate window, no WSL — on any OS.

### 10.1 Why a separate launcher

A shell process cannot trigger VS Code's "Split Terminal" action: the `code` CLI
exposes no command-execution verb (by design), and synthesizing the keystroke
would need OS input injection or a VS Code extension — both rejected (dependency
weight / config mutation). So `src/launch-vscode.js` automates everything *around*
the split and leaves the single keystroke to the user.

### 10.2 Flow — `run(profile)`

1. Validate profile + resolve state (reuses `launch-win`'s `validateProfile` /
   `resolveProfileState`); require `claude` (or `ccs <profile>`) on PATH.
2. `ensureSecureDir(stateDir)`; clear the stale `exited` sentinel.
3. Write the temp settings file (inline statusLine form, §5.3) — same
   no-`~/.claude`-mutation guarantee as the wt.exe path.
4. Print a prominent banner: the platform split keybinding (`Ctrl+Shift+5`, or
   `Cmd+\` on macOS) and a **shell-agnostic** sidecar one-liner
   `ccr sidecar --state-dir "<dir>"` (the state dir travels as an argument, so no
   per-shell `set` / `$env:` / `export` is needed).
5. Copy that one-liner to the clipboard — **OSC 52** first (zero-dep, works over
   SSH/remote/dev-containers; VS Code honors it), native
   `clip`/`pbcopy`/`wl-copy` as a best-effort fallback.
6. Run Claude in the **current** pane (`stdio: inherit`, blocks until exit).
7. On exit: drop the `exited` sentinel (sidecar → "session ended") and delete the
   temp settings file. No `cmd /k` glue — Claude runs directly, so cleanup is
   in-process.

`ccr sidecar --hint` reprints the banner + re-copies the one-liner (no Claude),
for when the banner scrolls under Claude's full-screen UI.

### 10.3 Dispatch — `bin/ccr.js` `cmdLaunch`

`TERM_PROGRAM=vscode` selects this launcher **on Windows always** (Windows
Terminal opens a separate window, so the in-editor split is strictly better
there). On Linux/macOS, `tmux` already works inside the VS Code terminal and is
richer (real multiplexer, F2→/clear), so the split flow is **opt-in** via
`CCR_VSCODE=1`.

### 10.4 Acceptance criteria

1. **§10.1** — inside a VS Code terminal, `ccr` runs Claude in the current pane and
   prints a prominent banner with the split keybinding + sidecar one-liner.
2. **§10.2** — the one-liner carries the resolved state dir by argument and is
   copied to the clipboard via OSC 52.
3. **§10.3** — exiting Claude drops the `exited` sentinel (sidecar shows "session
   ended").
4. **§10.4** — `ccr sidecar --hint` reprints the steps and re-copies, never
   launching Claude.
5. **§10.5** — `ccr <profile>` targets the CCS profile state dir; an unknown
   profile errors clearly and starts nothing.
6. **§10.6** — the split keybinding is platform-correct (`Ctrl+Shift+5` on
   Windows/Linux, `Cmd+\` on macOS); no file under `~/.claude` is modified.

### 10.5 Out of scope (Phase 2+)

- **Triggering the split automatically** — needs a VS Code extension or OS input
  injection; the clipboard + `--hint` reduce it to split-and-paste.
- **A graphical status-bar / menu-bar economy widget** — a separate package built
  on the `ccr economy --json` contract, never the zero-dependency core.
