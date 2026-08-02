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
