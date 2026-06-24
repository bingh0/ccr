# Acceptance criteria for the economy screen: readability, intuitiveness, the
# API degrade case, the binding-window ("the wall") logic, and the classic-rock
# theme gating.
# Steps drive the real renderer (src/render/economy.js) with a normalized view.

Feature: Economy screen readability and intuitiveness
  As a Claude Code user on a subscription plan
  I want one glanceable screen that tells me when I'll hit the limit and whether to clear
  So that I can pace a session without doing token math in my head

  Background:
    Given a subscription session on model "Opus 4.8" with a 1.0M context window
    And the 5h window is 70% used and resets in 3h20m
    And the weekly window is 18% used and resets in 5d10h
    And the live context is 262K tokens

  # --- Hero metric: the one number that matters (R2, I5) ---

  Scenario: The time until the limit is the hero, not the percentage rate
    When the economy screen renders
    Then the most prominent line shows the time remaining until the binding limit
    And the screen does not headline a percentage-per-minute burn rate
    And the time figure reads as remaining budget, not as percentage used

  # --- The clear decision in plain language (I1) ---

  Scenario: The clear decision is stated as an outcome, not as jargon
    Given the projected post-clear context baseline is 14K tokens
    When the economy screen renders
    Then the clear line states how many more minutes clearing now would buy
    And it shows the context drop "262K → 14K"
    And the screen does not require the reader to know what "ROI" means

  Scenario: When context is already near baseline, clearing is not advised
    Given the live context is 16K tokens
    And the projected post-clear context baseline is 14K tokens
    When the economy screen renders
    Then the clear line says there is little to gain from clearing

  # --- No duplicate meters (R1) ---

  Scenario: Each rate meter appears exactly once
    When the economy screen renders
    Then the 5h window meter appears exactly once
    And the context meter appears exactly once
    And the weekly window meter appears exactly once

  # --- Used vs remaining are labelled (R3) ---

  Scenario Outline: Percentage meters are labelled as "used"
    When the economy screen renders
    Then the "<meter>" line is labelled as used, not left
    And any time figure labelled "left" or "until" refers to remaining budget

    Examples:
      | meter  |
      | 5h     |
      | weekly |

  # --- Plain-language labels, no opaque jargon (I2, I4) ---

  Scenario: Cache-read is not labelled with insider terms
    When the economy screen renders
    Then the screen does not contain the label "re-read"
    And cache efficiency, if shown, uses a self-evident word like "cached"

  # --- The wall: which window binds, in plain language ---

  Scenario: The binding window is marked as the wall
    When the economy screen renders
    Then the binding window is marked "the wall"

  # --- Graceful handling of any plan's buckets (grandfathered Pro / Pro / Max) ---

  Scenario: A model-scoped (Sonnet-only) weekly bucket is surfaced as its own wall
    Given a Sonnet-only weekly bucket is 95% used and resets in 2d
    When the economy screen renders
    Then a "weekly · Sonnet" meter is shown

  Scenario: A plan exposing only one bucket still renders
    Given the only bucket present is the 5h window at 80% used resetting in 1h00m
    When the economy screen renders
    Then the screen renders without error
    And the 5h window meter appears exactly once

  # --- Classic-rock theme: default plain, "mary" easter egg ---

  Scenario: The default theme uses plain, accessible language
    When the economy screen renders
    Then the screen does not use the phrase "bad moon rising"

  Scenario: The mary interface switch enables the CCR vocabulary
    Given the mary interface is enabled
    And the 5h window is 90% used and resets in 4h00m
    When the economy screen renders
    Then the screen uses the phrase "bad moon rising"

  # --- Graceful degrade for API users (decision: subscription-only) ---

  Scenario: An API session with no rate-limit meter degrades gracefully
    Given an API session with no five_hour or seven_day rate limit
    And the session cost so far is 4.20 USD
    When the economy screen renders
    Then the screen does not crash or render an empty panel
    And it states that window economy is for subscription plans
    And it still shows the session cost "$4.20"
    And it shows no fabricated burn rate or time-to-limit
