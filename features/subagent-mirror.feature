# Tool: ccr subagents — the machine door: reading the roster without the panel.
#
# Produced by a /scope interview on 2026-08-23 (scope 4.1.1, aBDD dogfood run).
# Rulings encoded here:
#
# - Door choice (R12): a CLI command, not a state-dir file. Owner asked for the
#   agent-perspective recommendation; discoverability (`ccr --help`) and free
#   multi-instance resolution beat tribal path knowledge. Roads-not-taken:
#   snapshot JSON file, both-doors.
# - Read-only (R12/R30): the reading derives from Claude Code's transcripts and
#   writes nothing into the instance's state dir.
# - Mirror parity: single-instance mode carries exactly what the pane shows,
#   including the staleness marker (adversarial-pass parity ruling).
# - `--all` (R40): cross-instance aggregation, CLI-only by design; panes stay
#   strictly own-session.
# - `-i` family semantics inherited: output heads with the resolved name;
#   an unresolvable target refuses loudly (instance-resolution law).
# - `--debug` (R34): channels read + each channel's last event age. Zero
#   standing surface beyond this flag.

Feature: Reading the roster without the panel
  As a script or agent working alongside ccr
  I want the subagent roster through a CLI door in JSON
  So that programs consume the same facts my eyes get

  Scenario: The reading matches the pane fact for fact
    Given the fan-out of 2 live agents and 1 finished agent that the pane is rendering
    When ccr subagents -i 2 runs
    Then the reading reports for every agent its type, task, state, age, token count and latest words
    And no pane-visible fact is missing from the reading

  Scenario: Silence reaches the reader too
    Given the transcript has been silent for 30 seconds while the session lives
    When ccr subagents -i 2 runs
    Then the reading marks the roster stale by the same staleness the pane shows

  Scenario: A session that never fanned out reads as an empty roster
    Given an instance whose session has spawned no subagents
    When ccr subagents -i 2 runs
    Then it exits 0 with an empty roster

  Scenario: Retired agents are absent from both doors alike
    Given a finished agent retired from the pane roster under the shipped retirement policy
    When ccr subagents -i 2 runs
    Then the reading does not list that agent either

  Scenario: Reading never disturbs the instance
    Given any live instance
    When ccr subagents -i 2 runs twice
    Then neither reading writes anything into that instance's state dir

  Scenario: An explicit -i answers headed by the name it resolved
    Given live instances named alpha and beta
    When ccr subagents -i beta runs
    Then the output begins with beta's name

  Scenario: A -i that resolves to nothing refuses loudly
    Given no ninth instance exists
    When ccr subagents -i 9 runs
    Then it exits nonzero
    And stderr names the -i flag and the failure

  Scenario: The aggregate mode rolls up every live instance
    Given 3 live instances each holding its own fan-out
    When ccr subagents --all runs
    Then the reading contains all 3 rosters
    And each roster is labelled with its instance's name

  Scenario: The debug flag names the channels and their freshness
    Given any live instance
    When ccr subagents -i 2 --debug runs
    Then the debug output lists every channel read for this instance
    And each named channel carries its last event age
