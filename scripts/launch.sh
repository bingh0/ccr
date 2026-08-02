#!/usr/bin/env bash
# scripts/launch.sh — bring up a tmux session with:
#   pane 0 — claude (or `ccs <profile>`) with statusLine injected via --settings
#   pane 1 — the live economy sidebar (ccr sidecar)
#
# Usage (normally via the `ccr` CLI):
#   ccr            → plain `claude` + sidebar
#   ccr c1         → CCS profile c1 + sidebar
#
# No config files are modified: statusLine is passed per-launch with --settings,
# so CCS symlinks, shared settings, and credentials are untouched. Per-profile
# state dirs keep concurrent profiles from colliding.
#
# Env overrides: CC_BIN, CCR_SESSION, CCR_STATE_DIR, CCR_SIDEBAR_PCT (default 34).
# The tmux socket name follows the session name — each instance runs its own
# tmux server, so `tmux ls` won't list ccr sessions (`tmux -L ccr-<profile> ls`).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-}"

# Validate the profile name: it goes into filesystem paths and the launched
# command, so allow only a safe identifier (letters, digits, . _ -).
if [ -n "$PROFILE" ] && ! printf '%s' "$PROFILE" | grep -qE '^[A-Za-z0-9._-]+$'; then
  echo "ccr: invalid profile name '$PROFILE' (allowed: letters, digits, . _ -)" >&2
  exit 1
fi

# Escape a value for a SINGLE-QUOTED shell context: ' becomes '\''.
# Correct for anything we pass through `sh -c`, which is one parsing layer.
# NOT sufficient inside a tmux config string — see the F3 binding below for why.
sq() { printf "%s" "$1" | sed "s/'/'\\\\''/g"; }

# State lives under the user's home, never world-shared /tmp; create it
# owner-only so other local users can't read captured status.
umask 077

# Belt-and-suspenders: CC executes the statusLine command directly, so it must
# be executable even if git/npm didn't preserve the bit.
chmod +x "$REPO/sidecar/ccr-statusline" 2>/dev/null || true

# Prefer the newest nvm-installed node; `sort -V` is a GNU-ism, so suppress its
# error on BSD/macOS and fall back to PATH node below.
NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1)"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "ccr: node not found" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "ccr: tmux not found (required for the sidebar)" >&2; exit 1; }

if [ -n "$PROFILE" ]; then
  command -v ccs >/dev/null 2>&1 || { echo "ccr: 'ccs' not found on PATH — pass a profile only if CCS is installed." >&2; exit 1; }
  if [ ! -d "$HOME/.ccs/instances/$PROFILE" ]; then
    echo "ccr: CCS profile '$PROFILE' not found ($HOME/.ccs/instances/$PROFILE)." >&2
    echo "     available: $(ls -1 "$HOME/.ccs/instances" 2>/dev/null | tr '\n' ' ')" >&2
    exit 1
  fi
  CC_CMD="ccs $PROFILE"
  SESSION="${CCR_SESSION:-ccr-$PROFILE}"
  STATE="${CCR_STATE_DIR:-$HOME/.ccr/$PROFILE}"
else
  CC_CMD="${CC_BIN:-claude}"
  SESSION="${CCR_SESSION:-ccr}"
  STATE="${CCR_STATE_DIR:-$HOME/.ccr}"
fi

# Every instance gets its OWN tmux server, on a socket named after the session
# (-L puts it under /tmp/tmux-$UID/). On a shared server, one server death —
# a kill-server (2026-08-02: an agent inside one instance ran exactly that as
# "cleanup" after a config parse check), a crash, a cgroup teardown — takes
# down every concurrent profile at once; and root-table bindings like F2 are
# server-global, so the last launch would steal the hotkey for all instances.
# Isolation costs one visible thing: `tmux ls` won't list ccr sessions —
# use `tmux -L ccr-<profile> ls`.
SOCKET="$SESSION"

mkdir -p "$STATE"
chmod 700 "$HOME/.ccr" "$STATE" 2>/dev/null || true
rm -f "$STATE/exited"

SETTINGS='{"statusLine":{"type":"command","command":"'"$REPO/sidecar/ccr-statusline"'"}}'

# Portable across GNU and BSD/macOS mktemp (the `-t PREFIX` form differs between
# them); also lands in the per-user $TMPDIR on macOS rather than shared /tmp.
RUN_CONF="$(mktemp "${TMPDIR:-/tmp}/ccr-tmux.XXXXXX")"
trap 'rm -f "$RUN_CONF"' EXIT
cp "$REPO/sidecar/ccr.tmux.conf" "$RUN_CONF"

# Clean re-launch.
tmux -L "$SOCKET" kill-session -t "$SESSION" 2>/dev/null || true

# These strings are handed to `sh -c` by tmux — ONE parsing layer, so ordinary
# shell escaping is both necessary and sufficient. $STATE and $SESSION are not
# validated the way a profile name is (they come from $HOME and the CCR_SESSION
# / CCR_STATE_DIR overrides), and an apostrophe in either would otherwise end
# the quoting and run the remainder as a command.
STATE_Q="$(sq "$STATE")"
SESSION_Q="$(sq "$SESSION")"
SOCKET_Q="$(sq "$SOCKET")"
ENV_PREAMBLE="export CCR_STATE_DIR='$STATE_Q'"

# Pane 0: claude/ccs with --settings. On exit, drop the sentinel then close.
# Capture its pane id: the F2 hotkey below must target %N, never a relative
# index (see the binding comment further down).
CLAUDE_PANE="$(tmux -L "$SOCKET" new-session -d -P -F '#{pane_id}' -s "$SESSION" \
  "$ENV_PREAMBLE; $CC_CMD --settings '$SETTINGS'; touch '$STATE_Q/exited'; sleep 2; tmux -L '$SOCKET_Q' kill-session -t '$SESSION_Q' 2>/dev/null")"
tmux -L "$SOCKET" set-environment -t "$SESSION" CCR_STATE_DIR "$STATE"

# Pane 1: the live economy sidebar. Capture its pane id so we can scope a hook to it.
SIDEBAR_PANE="$(tmux -L "$SOCKET" split-window -t "$SESSION:0" -h -p "${CCR_SIDEBAR_PCT:-34}" -P -F '#{pane_id}' \
  "$ENV_PREAMBLE; \"$NODE\" \"$REPO/bin/ccr.js\" sidecar; read -r -p 'sidebar exited — Enter to close '")"

# The sidebar is a live dashboard — there is nothing to scroll. A stray mouse-wheel
# or PageUp over its narrow pane drops tmux into copy-mode, which freezes the pane
# at a snapshot and swallows the sidecar's per-second redraws — it looks like the
# sidebar "got lost" (the grid keeps updating underneath; only the view is frozen).
# Auto-cancel copy-mode the instant this pane enters it. PANE-scoped, so every other
# pane — and the Claude pane's scrollback — keeps normal copy-mode. The cancel
# re-fires this hook with pane_in_mode=0, so the guard stops it recursing. Best-effort:
# pane-scoped hooks need tmux >= 3.2; older tmux just skips the guard (|| true).
if [ -n "$SIDEBAR_PANE" ]; then
  tmux -L "$SOCKET" set-hook -p -t "$SIDEBAR_PANE" pane-mode-changed \
    "if-shell -F '#{pane_in_mode}' 'send-keys -t $SIDEBAR_PANE -X cancel'" 2>/dev/null || true
fi

# F2 → /clear: the one hotkey ccr ships. The text is a CONSTANT in this script —
# never configuration, never a prompt file, never blob content (the pane
# subsystem has no path to a key binding at all; docs/PANE-CONTRACT.md). It
# targets the pane id captured above, because a relative index like `.0`
# retargets after any split or swap. confirm-before makes a stray F2 cost one
# keypress rather than a whole context. If no pane id came back (a tmux too old
# for `new-session -P`), NO hotkey is bound — never an approximate target.
if [ -n "$CLAUDE_PANE" ]; then
  printf "bind-key -n F2 confirm-before -p 'send /clear to Claude? (y/n) ' \"send-keys -t %s '/clear' Enter\"\n" \
    "$CLAUDE_PANE" >> "$RUN_CONF"
fi

# F3 → cycle the sidebar's view (economy ⇄ each configured external pane).
# It runs `ccr cycle-view`, which records a request the sidecar picks up on its
# next tick; the sidecar never reads a keystroke itself, because an input
# channel is precisely the capability the pane threat model denies it
# (docs/PANE-CONTRACT.md). No confirm gate: cycling costs nothing and is undone
# by pressing again.
#
# The paths go in a generated SCRIPT, not into the binding. $STATE, $REPO and
# $NODE derive from $HOME, $CCR_STATE_DIR and the checkout location — none of
# which this script validates the way it validates a profile name — and a lone
# apostrophe in any of them used to close the quoting so the rest ran as a
# command (reproduced 2026-08-02, and again after a first "fix").
#
# Shell-escaping alone is NOT enough here, which is the subtle part: a binding
# in this file passes through TWO parsers. tmux reads the config line first and
# processes backslashes inside its double quotes, so a shell-level '\'' arrives
# at sh already stripped to '' — closing the quote after all. Escaping correctly
# for both layers at once is the kind of thing that looks right and isn't.
#
# So: one parsing layer each. The helper script holds the paths with ordinary
# shell quoting (sq is exactly right for that), and the config line names only
# the helper's own mktemp path inside tmux SINGLE quotes, where tmux performs no
# escape processing at all. If that path could itself contain a quote we bind
# nothing rather than emit a line we cannot reason about.
CYCLE_SH="$(mktemp "${TMPDIR:-/tmp}/ccr-cycle.XXXXXX")"
trap 'rm -f "$RUN_CONF" "$CYCLE_SH"' EXIT
{
  printf '#!/bin/sh\n'
  printf "exec '%s' '%s' cycle-view --state-dir '%s'\n" \
    "$(sq "$NODE")" "$(sq "$REPO/bin/ccr.js")" "$(sq "$STATE")"
} > "$CYCLE_SH"
chmod 700 "$CYCLE_SH"
case "$CYCLE_SH" in
  *\'*) echo "ccr: TMPDIR contains a quote — F3 (cycle view) not bound" >&2 ;;
  *) printf "bind-key -n F3 run-shell '%s'\n" "$CYCLE_SH" >> "$RUN_CONF" ;;
esac

tmux -L "$SOCKET" select-pane -t "$SESSION:0.0"
tmux -L "$SOCKET" source-file -t "$SESSION" "$RUN_CONF"
tmux -L "$SOCKET" attach -t "$SESSION"
