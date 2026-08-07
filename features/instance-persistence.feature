# Tool: `ccr` — what outlives an instance. Scoped 2026-08-06 via /scope
# (instance layout interview). NOT YET BUILT: registered in
# test/wip-register.js until its steps bind.
#
# The split, ruled: ACCOUNT-SCOPED state lives in the container and outlives
# everything — burn history, the 5h/weekly meters, one session-summary join
# line per session. INSTANCE-SCOPED state dies with the session. Burn history
# stays at container level because slots are REUSED: a slot is a runtime
# identity, never a historical one.
#
# The join key is TWO-PHASE, ruled on the owner's words: "even partial
# information allows forensic reconstruction of what happened." It is written
# the moment the session id first exists and finalized by whoever sees the
# death — the exiting process if polite, the sweep if not. Deaths are exactly
# when writes cannot be trusted to happen, so the key is never written only
# at death.
#
# Retention, ruled shape-independent: content survives 30 full days after
# its session ends, gone at 31. Whether history is per-session files or a
# shared file is the builder's call (constraints recorded in
# features/OUT-OF-SCOPE.md); these scenarios bind against either.
#
# BINDING NOTE for the join-key scenarios: ground truth for "maps to" is
# Claude's own transcript on the far side — a binding that only reads back
# the log ccr wrote would be measuring a mirror.

Feature: What outlives the instance
  As someone whose instances are deleted the moment they exit
  I want account history to survive and instance state to die
  So that meters and forensics work across sessions without stale state piling up

  Scenario: Burn history survives the instance that wrote it
    Given instance "a" on slot 1 has logged burn samples for session "abc123"
    When instance "a" exits and its directory is deleted
    Then the burn history for session "abc123" is still present in the container

  Scenario: The join key is written at the first status capture
    Given instance "a-is-awesome" under profile "cc1" launched in "~/code/app"
    When its first status arrives carrying session id "abc123"
    Then the account's session log maps "abc123" to
      | name       | a-is-awesome |
      | profile    | cc1          |
      | launch dir | ~/code/app   |

  Scenario: A polite exit finalizes its own join key
    Given instance "a"'s join key for session "abc123" is open
    When instance "a" exits politely
    Then the session log's entry for "abc123" is marked ended

  Scenario: The sweep finalizes a dead instance's join key before deleting
    # The swept marker is itself forensic signal: it says this session died
    # badly, and the ended time is the last evidence available.
    Given slot 2 holds a dead instance whose join key for session "abc123" is open
    When a launch sweeps the dead instance
    Then the session log's entry for "abc123" is marked swept
    And its ended time is the dead instance's last heartbeat time
    And the slot 2 instance directory is gone

  Scenario Outline: History is kept thirty days past its session's end
    Given history from a session that ended <age> days ago
    When a bare ccr launches
    Then that session's history is <outcome>

    Examples:
      | age | outcome       |
      | 30  | still present |
      | 31  | gone          |

  Scenario: With no instance live the account panel still prints
    Given no ccr instance is running
    And the container holds burn history from past sessions
    When ccr economy runs
    Then the account's meters and burn history are printed
    And no per-instance panel is printed
