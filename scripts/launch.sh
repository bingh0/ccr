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

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-}"

# Validate the profile name: it goes into filesystem paths and the launched
# command, so allow only a safe identifier (letters, digits, . _ -).
if [ -n "$PROFILE" ] && ! printf '%s' "$PROFILE" | grep -qE '^[A-Za-z0-9._-]+$'; then
  echo "ccr: invalid profile name '$PROFILE' (allowed: letters, digits, . _ -)" >&2
  exit 1
fi

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
tmux kill-session -t "$SESSION" 2>/dev/null || true

ENV_PREAMBLE="export CCR_STATE_DIR='$STATE'"

# Pane 0: claude/ccs with --settings. On exit, drop the sentinel then close.
tmux new-session -d -s "$SESSION" \
  "$ENV_PREAMBLE; $CC_CMD --settings '$SETTINGS'; touch '$STATE/exited'; sleep 2; tmux kill-session -t '$SESSION' 2>/dev/null"
tmux set-environment -t "$SESSION" CCR_STATE_DIR "$STATE"

# Pane 1: the live economy sidebar.
tmux split-window -t "$SESSION:0" -h -p "${CCR_SIDEBAR_PCT:-34}" \
  "$ENV_PREAMBLE; \"$NODE\" \"$REPO/bin/ccr.js\" sidecar; read -r -p 'sidebar exited — Enter to close '"

tmux select-pane -t "$SESSION:0.0"
tmux source-file -t "$SESSION" "$RUN_CONF"
tmux attach -t "$SESSION"
