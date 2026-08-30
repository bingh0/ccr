# Tool: ccr sidecar — the fourth built-in view: who is working inside one session.
#
# Produced by a /scope interview on 2026-08-23 (scope 4.1.1, aBDD dogfood run).
# The fence that goes with it lives in features/OUT-OF-SCOPE.md ("The subagent
# observability views"). Rulings encoded here, in the interviewer's shorthand:
#
# - Shape S2, chosen over auto-detail (owner: "risky because user [may]
#   experience FOMO") and bare roster ("barely tells you more than what claude
#   code tells you now"): pure roster, one block per agent, activity inline.
#   NO detail zone, NO navigation keys — the only key anywhere is F3.
# - Task column = Claude's own dispatch words (R10); empty prompt -> type
#   alone (R18); huge prompt truncates head-first on one row (R19).
# - Activity line = latest WORDS with an age marker (R11 final + objection-3
#   ruling); ladder when wordless: latest tool call (R20), else quiet "...".
# - Burst cap (R15): LIVE agents own slots first, finished fill leftovers,
#   overflow line NAMES live work beyond the cap (adversarial ruling R36).
# - Retirement (R16/R24/R37): keyed to upstream completion timestamps, never
#   observation time; clocks run while unwatched; missing timestamp -> stays
#   until session end. Default policy values below are builder-tunable, the
#   observables bind.
# - Failures render AS failures carrying what Claude Code surfaced (R17).
# - Stale banner (R22): whole-transcript silence while the session lives;
#   30s default constant builder-tunable; last-known words freeze (never erase).
#   Recovery is bound too (owner ruling 2026-08-24): the mark clears within
#   one redraw tick once the feed speaks again.
# - Leftover-slot ordering (owner ruling 2026-08-24): finished agents fill
#   the slots live agents leave, NEWEST completion first — the same upstream
#   timestamp clock retirement uses.
# - Verbatim words pinned directly (owner ruling 2026-08-24, upgrades N11):
#   secret-shaped strings render unmasked, character for character.
# - Dead session defers to the existing session-ended screen (R23).
# - Nesting (R39): flat roster, lineage prefix, display only.
# - Hostile text inherits the house law unchanged (R21): pane text renders
#   inert, never executes, never wedges the redraw.
# - DEBT (like git-pane-safety before it): no @security tags yet —
#   test/security-tags.test.js refuses an unbound @security scenario even in
#   wip. The escape-sequence and verbatim-secrets scenarios below earn the
#   tag when their steps bind.

Feature: Watching a session's subagents at a glance
  As someone running Claude Code sessions that fan work out to subagents
  I want one sidecar view naming who is alive, what each last said, and what each has spent
  So that orchestration stops being a black box I cannot watch

  Scenario: A glance at a working fan-out
    Given an explore agent spawned 3m12s ago with task "map auth flow" holding 18000 tokens whose latest words were "grepping src/auth"
    And a general-purpose agent spawned 31s ago with task "fix failing tests" holding 2000 tokens whose latest words were "running npm test"
    When the sidecar renders the subagents view
    Then each block shows its type, its task, its age, and its token count
    And each block's activity line quotes that agent's latest words

  Scenario: The view says so when no subagents exist
    Given the session has spawned no subagents
    When the sidecar renders the subagents view
    Then the view shows a "no subagents" line
    And no agent blocks are drawn

  Scenario: A new spawn reaches the roster within one redraw tick
    Given the subagents view is showing 1 live agent
    When Claude spawns another agent
    Then within one redraw tick the roster shows 2 live agents

  Scenario: The task column carries Claude's own dispatch words
    Given Claude dispatched an agent with the prompt "Map the auth flow before touching tests"
    When the block renders
    Then the task column reads "Map the auth flow before touching tests"

  Scenario: An enormous dispatch prompt keeps its head and fits one row
    Given Claude dispatched an agent with a prompt 2000 characters long beginning "Audit every config file"
    When the block renders
    Then the task column occupies exactly 1 row inside the pane width
    And the task column starts with the head of that prompt

  Scenario: An empty dispatch leaves the type to carry the row
    Given Claude dispatched an agent with no prompt text
    When the block renders
    Then the block shows the agent type alone where a task would stand

  Scenario Outline: The activity line ages visibly beside the words
    Given an explore agent whose latest words arrived <age> ago
    When the block renders
    Then the activity line shows those words marked <age> old

    Examples:
      | age |
      | 0m  |
      | 4m  |
      | 12m |

  Scenario: A wordless agent falls back to its latest tool call
    Given an agent 10 seconds old that has made a Bash call but written no words
    When the block renders
    Then the activity line names that Bash call
    And no words are invented

  Scenario: An agent with neither words nor tool calls stays quiet
    Given an agent 5 seconds old that has produced nothing observable yet
    When the block renders
    Then the activity line is the quiet placeholder

  Scenario: A burst of a hundred agents never evicts a live worker
    Given the roster is filled to its slot count with live agents
    When the session's live agent count reaches 100
    Then every roster slot still holds a live agent
    And the overflow line counts the agents beyond the slots

  Scenario: The overflow line names live work beyond the cap
    Given the session holds 100 live subagents and the roster shows 4 of them
    And the agents just beyond the slots are named review, migrate, explore and explore
    When the view renders the overflow line
    Then the overflow line counts the 96 agents beyond the slots
    And the overflow line names review, migrate and the explores among them

  Scenario: Finished agents take only the slots live agents leave
    Given 2 live agents and 6 finished agents compete for 4 roster slots
    When the view renders
    Then the roster holds the 2 live agents and the 2 newest finishes
    And no finished agent displaces a live one

  Scenario: A finished block retires itself on Claude's own timestamp
    Given a finished agent showing in the roster whose completion Claude stamped 60 seconds ago
    When the next redraw happens
    Then that block is gone from the roster
    And nothing was pressed to remove it

  Scenario: A finish without a recorded timestamp stays until the session ends
    Given a finished agent showing in the roster whose completion carries no timestamp
    When redraws happen for the remainder of the session
    Then that block stays until the session ends

  Scenario: Resuming a session never resurrects ancient finishes
    Given a resumed session whose transcript holds completions stamped days ago
    When the roster derives for the first time
    Then none of the ancient finishes appear

  Scenario: A crashed agent reads as a failure, never as done
    Given an agent whose death Claude recorded as a rate-limit failure saying "rate limited"
    When the block renders
    Then the block shows a failure state carrying "rate limited"
    And the block does not carry the done glyph

  Scenario: Whole-transcript silence marks the facts stale
    Given 2 live agents showing and the session alive
    When the transcript produces nothing new for 30 seconds
    Then the view marks its facts stale and states how stale they are

  Scenario: A stale view freezes its last known words instead of erasing them
    Given the view went stale 30 seconds into silence
    When further redraws come and go with the feed still quiet
    Then each block keeps the words it held when the feed went quiet

  Scenario: The staleness mark clears once the feed speaks again
    Given the view went stale 30 seconds into silence
    When the transcript produces a new event
    Then within one redraw tick the staleness mark is gone
    And each block resumes live words

  Scenario: A dead session yields to the session-ended screen
    Given the subagents view is showing 2 live agents
    When the session exits and drops its sentinel
    Then the panel shows the session-ended screen like any other view

  Scenario: A nested subagent gets its own block with a lineage prefix
    Given an explore agent spawned by another explore agent rather than by the main session
    When the roster renders
    Then the nested agent holds its own block
    And that block carries a prefix tying it to its parent

  Scenario: Escape sequences inside agent words render inert
    Given an agent whose latest words contain terminal escape sequences
    When the block renders
    Then those words appear as plain inert text
    And the panel redraws normally afterwards

  Scenario: Words quoting secrets render verbatim, never masked
    Given an agent whose latest words contain "sk-ant-api03-9f2e7b1c4d6e"
    When the block renders
    Then those exact characters appear in the block, unmasked and whole

  Scenario: One tab never shows another tab's agents
    Given 3 live ccr instances each with its own fan-out
    When the sidecar of instance 2 renders the subagents view
    Then every block on that pane belongs to instance 2's session

  Scenario: The subagents view sits fourth among the built-in views
    Given an instance with no external panes configured
    When F3 cycles the views starting from the economy panel
    Then the order visits the git pane, then the feed, then subagents

  Scenario: An optional view never lands between built-ins
    Given treecontext contributes an optional sidecar view
    When the rotation is assembled
    Then the optional view follows subagents
    And economy, git pane, feed and subagents keep their relative order
