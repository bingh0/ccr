# Tool: ccr sidecar (now hosted in pane 1) + exit sentinel round-trip
# Spec: §1 (sidecar loop), §6  |  Acceptance: §8.3, §8.4, §8.5
# The pure-Node sidecar loop is reused unchanged; this feature pins the behavior
# that must hold once it is hosted inside the Windows Terminal pane.

Feature: Live sidecar hosting
  As a Windows user with the split window open
  I want the sidecar to show live economy + tool/skills data and a clean end state
  So that the side-by-side experience matches upstream

  @AC3
  Scenario: Sidecar waits before the first status tick
    Given the split window has just opened
    And Claude has not yet produced a status tick
    When the sidecar pane renders
    Then it shows "waiting for the first status tick…"

  @AC3
  Scenario: Sidecar renders the live economy panel after a tick
    Given Claude has written a snapshot to CCR_STATE_DIR/last-status.json
    When the sidecar redraws
    Then it renders the economy panel with correct block glyphs (▓ ░ ●) and colors
    And the meters carry the snapshot's numbers, not placeholders

  @AC4
  Scenario: The tool/skills feed updates as the session runs
    Given the session transcript grows as Claude works
    When the sidecar tails the transcript
    Then the tool/skills feed updates roughly once a second

  @AC3
  Scenario: A quiet spell annotates the panel instead of freezing it
    # CC does not emit the status line during a long single operation, so the
    # snapshot legitimately ages — the panel must say so, not look dead.
    Given Claude wrote a snapshot 8 minutes ago and then went quiet
    When the sidecar redraws after the quiet spell
    Then the economy panel is still shown with a dim "updated 8m ago" marker

  @AC5
  Scenario: Exiting Claude flips the sidecar to a session-ended state
    Given the sidecar is rendering the live panel
    When Claude (pane 0) exits and drops the "exited" sentinel in the state dir
    Then the sidecar shows the "session ended" state
    And the sentinel round-trips without manual intervention

  @AC6
  Scenario: A stray scroll can't freeze the sidebar in copy-mode
    # A mouse-wheel or PageUp over the narrow sidebar pane drops tmux into copy-mode,
    # which freezes the view at a snapshot while the sidecar keeps redrawing
    # underneath — the sidebar looks "lost" even though the meters are live. The tmux
    # launcher scopes an auto-cancel hook to the sidebar pane so it exits copy-mode
    # the instant it enters, while the Claude pane keeps its normal scrollback.
    Given the tmux launcher script scripts/launch.sh
    When it splits the sidebar pane
    Then it captures the new pane id with "-P -F '#{pane_id}'" into SIDEBAR_PANE
    And it sets a pane-scoped pane-mode-changed hook that cancels copy-mode only while the pane is in a mode

  # --- Cycling views without giving the sidecar an input channel ---

  @security
  Scenario: The view is cycled by a host key, never by the sidecar reading input
    # The sidecar renders untrusted blob content, so it must hold no input
    # channel — that is a structural invariant, not a preference. Cycling
    # therefore arrives from a host key, the same division of labour as the
    # clear hotkey: the host owns the key, ccr owns the behaviour.
    Given the tmux launcher script scripts/launch.sh
    When it binds the view-cycle key
    Then the key runs ccr's own cycle-view command against this profile's state dir
    And the sidecar reads no keystroke of its own

  @security
  Scenario: Cycling holds no capability beyond changing which pane is shown
    # The first implementation read the sidecar's pid from its heartbeat and
    # sent SIGUSR1 — whose default disposition is to terminate. Because that
    # file is writable by anything running as the user, naming a victim's pid
    # in it turned a cosmetic hotkey into a kill primitive (reproduced).
    # No guard fixes that, since pid and freshness both come from the attacker's
    # own file, so the mechanism is a request the sidecar reads instead.
    Given a state directory an attacker can write
    When the view-cycle command runs
    Then it sends no signal to any process
    And the only thing it can change is which pane is displayed

  Scenario: A recorded request advances the view exactly once per press
    Given a state directory with no view requests yet
    When the view-cycle command runs twice
    Then the sidecar sees two pending advances
    And a sidecar that was already up to date sees none

  Scenario: Cycling with no sidecar running is a quiet no-op
    Given a state directory with no live sidecar
    When the view-cycle command runs
    Then the command still exits cleanly

  @security
  Scenario: The request file is read under the safe-read rules
    # It lives in the same writable directory as everything else here, so a
    # fifo planted at that path would hang whichever process read it — and
    # under tmux run-shell every keypress would leak another hung process.
    Given the view-request path is a pipe that never yields bytes
    When the sidecar checks for pending advances
    Then the check completes without blocking
    And no advance is reported

  # --- The launcher must fail loudly, never silently ---

  Scenario: A machine with no nvm gets a clear error instead of silence
    # The launcher prefers the newest nvm-installed node and falls back to PATH.
    # Under `set -euo pipefail` the glob missing made `ls` fail, pipefail
    # propagated it, and the failing command substitution aborted the whole
    # script — exit 2, no message, no sidebar, and the PATH fallback two lines
    # below never reached. That is exactly the "plain Claude Code, no nvm" user.
    Given a machine with no ~/.nvm and no node on PATH
    When the tmux launcher runs
    Then it reports that node was not found
    And it does not abort before reaching that check

  @security
  Scenario: A non-regular file at the heartbeat path cannot wedge the sidebar
    # Everything in the state dir is writable by anything running as the user.
    # A symlink there would turn a heartbeat into an arbitrary-file write; a FIFO
    # is quieter and worse — opening one for write blocks until a reader appears,
    # which freezes the draw loop with no error at all. Instance slots multiplied
    # the plantable state dirs, so the guard covers anything not a regular file.
    Given a fifo planted where the sidecar writes its heartbeat
    When the sidecar beats
    Then the beat completes without blocking
    And the heartbeat is a regular file again

  Scenario: Concurrent profiles are isolated on per-profile tmux sockets
    # All instances used to share the default tmux server — a single point of
    # failure. One kill-server (2026-08-02: an agent inside one instance ran
    # exactly that as post-verification "cleanup"), one crash, one cgroup
    # teardown killed every concurrent profile at once; and root-table
    # bindings like F2 were server-global, so the last launch stole the
    # hotkey for all instances. Each instance now runs its own tmux server,
    # bounding any failure's blast radius to one profile.
    Given the tmux launcher script scripts/launch.sh
    When it talks to tmux
    Then it derives a per-instance socket name from the session name
    And every tmux invocation names that socket with -L
    And the in-pane teardown kill-session names the same socket
