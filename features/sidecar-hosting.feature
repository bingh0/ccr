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
