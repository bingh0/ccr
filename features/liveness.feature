# Acceptance criteria for liveness / staleness — the "times out too quickly"
# annoyance.
# Core principle: status-line emission cadence is NOT a liveness signal. CC does
# not tick during a single long operation, so tick-age must never blank the
# dashboard. Only the explicit exit sentinel means "ended".

Feature: Liveness without false timeouts
  As a user running long operations in Claude Code
  I want the economy dashboard to stay up while CC is working
  So that a multi-minute agent run or build does not look like a dead session

  Background:
    Given a live economy frame was last rendered from a valid status snapshot
    And no exit sentinel is present

  # --- The reported bug: long operations must not blank the screen ---

  Scenario: A six-minute operation keeps the dashboard visible
    Given the status snapshot has not been updated for 6 minutes
    And no exit sentinel is present
    When the sidecar renders
    Then the economy dashboard is still shown with the last-known numbers
    And the screen is not replaced with "no active connection"
    And the screen is not replaced with "idle — waiting for input"

  # --- Freshness is a quiet annotation, never a takeover ---

  Scenario Outline: Stale state shows a dim freshness marker, not a wipe
    Given the status snapshot was last updated <age> minutes ago
    When the sidecar renders
    Then the dashboard remains visible
    And a dim "updated <age>m ago" marker is appended

    Examples:
      | age |
      | 3   |
      | 8   |
      | 15  |

  Scenario: The staleness marker threshold is configurable
    Given CCR_STALE_MS is set to 600000
    And the status snapshot was last updated 4 minutes ago
    When the sidecar renders
    Then no freshness marker is shown yet
    And the dashboard renders normally

  # --- The only authoritative "ended" signal ---

  Scenario: A clean exit shows the ended screen
    Given the exit sentinel is present
    When the sidecar renders
    Then the screen shows "session ended"
    And it shows the last-known session summary

  Scenario: Stale state alone never claims the session ended
    Given the status snapshot has not been updated for 20 minutes
    And no exit sentinel is present
    When the sidecar renders
    Then the screen does not claim the session ended
    And the dashboard remains visible with a freshness marker

  # --- No fragile external process probing in core ---

  Scenario: Liveness does not depend on pstree or tmux process inspection
    When the sidecar determines whether to show the ended screen
    Then the decision uses only the exit sentinel and the snapshot age
    And it does not shell out to pstree or tmux to inspect a process tree
