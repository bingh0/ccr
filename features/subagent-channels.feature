# Tool: ccr subagents — surviving whatever Claude Code emits next.
#
# Produced by a /scope interview on 2026-08-23 (scope 4.1.1, aBDD dogfood run).
# Rulings encoded here (Phase 3¼ evolvability, R35):
#
# - Fail-open parsing: an unrecognized record shape is skipped BY DESIGN — it
#   never crashes the render and never poisons the roster.
# - Total drift degrades honestly: if everything goes unreadable the view tells
#   the empty/stale truth, never a fabricated roster.
# - The Task -> Agent tool rename (Claude Code v2.1.63) is the concrete drift
#   case already observed in the wild; both names must yield one roster.
# - Doctor gains NOTHING for channels (R13): provenance surfaces are the pane
#   stale banner and ccr subagents --debug alone. This scenario pins that
#   negative space so a future doctor section is a visible decision.
# - The channel catalogue (which records are parsed, from where) is build
#   documentation, not runtime behavior — covered structurally in
#   USER-NEEDS.md, deliberately absent from this file.

Feature: Surviving whatever Claude Code emits next
  As whoever maintains ccr against a changing upstream
  I want unknown transcript shapes skipped by design and drift degraded honestly
  So that tomorrow's Claude Code cannot wedge today's view or lie to me

  Scenario: An unrecognized record is skipped without disturbing the roster
    Given a transcript gaining records of a shape this ccr has never seen
    When the roster derives
    Then the unknown records contribute no blocks
    And every recognized agent still renders as before

  Scenario: A flood of unknown shapes never wedges the redraw
    Given a transcript consisting mostly of unrecognized record shapes
    When redraw ticks fire under that feed
    Then each tick completes within one second of starting

  Scenario: The Agent tool's old name still yields the same roster
    Given a transcript recording dispatches under Claude Code's older Task tool name
    When the roster derives
    Then those dispatches appear as the same blocks Agent-name dispatches produce

  Scenario: When every record becomes unreadable the view tells the empty truth
    Given an upstream change that makes every known record shape unrecognizable
    When the roster derives
    Then the view shows the "no subagents" line rather than invented blocks

  Scenario: The doctor surface stays out of channel health
    Given channel reporting lives in the pane stale banner and ccr subagents --debug alone
    When ccr doctor runs on any instance
    Then doctor's checks and output are unchanged by this feature
