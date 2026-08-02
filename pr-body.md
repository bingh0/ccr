## Windows support for the live sidecar

Adds native-Windows launch for `ccr` (Windows Terminal split panes) and a second
launch path for **VS Code's integrated terminal** (split-pane sidecar, any OS).
The pure-Node core (economy / statusline / resume / sidecar / doctor) is reused
unchanged — this is a launch-layer addition. Zero new runtime dependencies, and
no file under `~/.claude` is ever modified.

### What's included

**Windows Terminal launcher** (`src/launch-win.js`)
- `ccr` / `ccr <profile>` opens one Windows Terminal window: Claude on the left,
  `ccr sidecar` ~34% on the right; `CCR_STATE_DIR` injected per-pane; the exit
  sentinel + temp-settings cleanup wired into pane 0.
- Graceful fallback (native-CLI guidance, no crash/stack trace) when `wt.exe` is
  absent.

**VS Code split-terminal launcher** (`src/launch-vscode.js`)
- Detects `TERM_PROGRAM=vscode`; runs Claude in the current pane and prints a
  prominent banner with the platform split key (`Ctrl+Shift+5` / `Cmd+\`) and a
  shell-agnostic `ccr sidecar --state-dir "<dir>"` one-liner, copied to the
  clipboard via OSC 52. `ccr sidecar --hint` reprints it.
- Default inside VS Code on Windows (Windows Terminal otherwise opens a separate
  window); opt-in elsewhere via `CCR_VSCODE=1` (tmux already works in the VS Code
  terminal on Linux/macOS).

**Statusline injection** — per-launch temp settings file (inline command form),
passed via `claude --settings`; no `~/.claude` mutation.

### Testing
- `npm test`: **227 pass / 0 fail / 0 todo**. All Windows + VS Code `.feature`
  files are **executable** (wired step definitions), with `*.test.js` unit tests
  underneath.
- `npm run typecheck`: clean.

### Security-relevant notes (please scrutinize)
- **`cmd.exe` payload construction** (`buildWtArgs` / `paneCommand`): paths are
  interpolated into a `cmd /k` line. We **reject** the two characters our `set
  "VAR=val"` / `"path"` quoting does *not* neutralize — `"` (ends the quoted
  string) and `%` (cmd variable expansion, which fires even inside quotes) — with
  a clear error, rather than trying to escape them. `& | < >` are literal inside
  the quotes and stay allowed. Trust boundary is the user's own env/paths
  (self-injection, not RCE).
- **Process spawns**: `spawnSync` with `stdio: 'inherit'` (Claude) / `'ignore'`
  (wt) / piped stdin (clipboard tools). No `shell: true`.
- **OSC 52 clipboard write**: base64 of the sidecar one-liner only; no secrets.
- **Profile validation**: `^[A-Za-z0-9._-]+$` allow-list before any path or spawn.

### Out of scope (documented, Phase 2+)
- Triggering the VS Code split automatically — needs a VS Code extension (the
  `code` CLI has no run-command verb).
- A graphical menu-bar / status-bar widget — a separate package built on the
  `ccr economy --json` contract, never the zero-dependency core.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
