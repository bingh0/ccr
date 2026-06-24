# Acceptance criteria for the resume-cost advisor (src/resume.js + render/resume.js).
# It is NOT a picker — it annotates sessions with the economics CC's own --resume
# can't show, then defers selection to `claude --resume`.

Feature: Resume-cost advisor
  As a Claude Code user deciding which session to bring back
  I want each recent session annotated with what it will cost to resume
  So that I avoid resuming straight into a near-full context or a costly cold reload

  # --- The cost number: last turn's input side, share of window, cache state ---

  Scenario: Resume cost is the last turn's context, as a share of the model window
    Given a session whose last assistant turn re-feeds 70000 context tokens on model "claude-opus-4-8"
    And the session was last active 32 days ago
    When the advisor row is built
    Then the row context is 70000 tokens
    And the row cache is cold

  Scenario: A recent session is warm
    Given a session whose last assistant turn re-feeds 20000 context tokens on model "claude-opus-4-6"
    And the session was last active 2 minutes ago
    When the advisor row is built
    Then the row cache is warm
    And the row window percentage is 10

  # --- Rendering: columns, near-/clear flag, honest framing, handoff ---

  Scenario: The advisor lists sessions with cost columns and defers selection to CC
    Given an advisor row titled "Fix sidebar overlay" with 70K context at 35% cold
    When the advisor renders
    Then the output shows the title "Fix sidebar overlay"
    And the output shows "cold"
    And the output points to "claude --resume"
    And the output does not claim a percentage of the rate-limit window

  Scenario: A near-full session is flagged
    Given an advisor row titled "Long session" with 190K context at 95% warm
    When the advisor renders
    Then the output flags it as near /clear

  Scenario: An empty scope suggests widening
    Given no advisor rows
    When the advisor renders for the current project
    Then the output suggests "ccr resume all"
