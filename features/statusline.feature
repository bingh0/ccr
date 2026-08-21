# Acceptance criteria for the one-line status bar summary (src/render/statusline.js).
# This is what Claude Code actually invokes via statusLine; it must be plain text
# (no ANSI), name the binding window, and degrade on API sessions.
# Steps drive the real renderer with a normalized view. (Phrasings are kept
# distinct from the economy feature's for readers; collisions are impossible
# anyway — step registries are scoped per feature, see test/steps/index.js.)

Feature: Status-line one-line summary
  As a Claude Code user with ccr wired into the status bar
  I want a compact one-line read on the binding limit, context, and cost
  So that I can glance at pacing without opening the full panel

  Scenario: The binding window and its time-to-limit lead the line
    Given a status view on model "Sonnet 4.6"
    And a 5h limit at 40% used, resetting in 4h00m, burning 0.05%/min
    And a weekly limit at 90% used, resetting in 5d00h, burning 0.02%/min
    And status context of 150K tokens in a 1.0M window
    And a status session cost of 2.50 USD
    When the status line renders
    Then the line contains the model "Sonnet 4.6"
    And the line names the weekly window as the binding limit
    And the line shows the context percentage "ctx 15%"
    And the line shows the cost "$2.50"
    And the line contains no ANSI colour codes

  Scenario: An imminent limit is flagged with a warning marker
    Given a status view on model "Opus 4.8"
    And a 5h limit at 95% used, resetting in 4h00m, burning 2.0%/min
    When the status line renders
    Then the line contains the warning marker

  # --- Critical-zone progressive disclosure: precise used% only near the wall ---
  # The line stays a single glanceable beat by default. Only when the binding
  # window enters the critical zone does it earn the precise (truncated) used%,
  # so floor(shown) still matches /usage. A percentage that is always there stops
  # being a signal at the moment it starts to matter.

  Scenario: In the critical zone the binding window earns its precise used%
    Given a status view on model "Opus 4.8"
    And a 5h limit at a raw 98.76% used, resetting in 4h00m, burning 2.0%/min
    When the status line renders
    Then the line shows the binding used% as "5h 98.7%"
    And the line contains no ANSI colour codes

  Scenario: Below the critical zone the status line stays lean
    Given a status view on model "Opus 4.8"
    And a 5h limit at a raw 80.40% used, resetting in 4h00m, burning 0.10%/min
    When the status line renders
    Then the binding window shows time-to-limit but no used% figure

  Scenario: An API session with no rate-limit meters degrades to a plain note
    Given a status view on model "Opus 4.8" with no rate limits
    When the status line renders
    Then the line states there are no limits
    And the line shows no fabricated time-to-limit
