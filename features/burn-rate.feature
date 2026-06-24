# Acceptance criteria for the burn-rate and clear-ROI calculations.
# Covers the binding window (5h vs weekly), window inference, resets_at parsing
# (epoch or ISO), model-scoping, and the clear-ROI bounds.
# Steps drive src/burn.js (windowEstimate / binding / clearROI) directly with
# sample buffers.

Feature: Burn-rate and clear-ROI calculations across subscription plans
  As a user on any Claude subscription plan
  I want the burn rate and "minutes left" to reflect the limit that actually binds me
  So that the headline number is true on Pro and on Max, not just one of them

  # --- Plan-agnostic rate from the percentage meter ---

  Scenario Outline: Burn rate is derived from the plan's own percentage meter
    Given the 5h meter moved from <u0>% to <u1>% over <minutes> minutes on one model
    When the burn rate is computed
    Then the rate is approximately <rate> percent per minute
    And the minutes-left equals (100 - <u1>) divided by the rate
    And the calculation does not depend on the plan's absolute token cap

    Examples:
      | u0 | u1 | minutes | rate |
      | 40 | 50 | 20      | 0.50 |
      | 20 | 26 | 30      | 0.20 |

  # --- Model scoping ---

  Scenario: Samples from a prior model do not pollute the active-model rate
    Given a sample buffer with 3 slow Sonnet samples followed by 4 fast Opus samples
    And the active model is Opus
    When the burn rate is computed
    Then only the Opus tail is used for the rate
    And the rate reflects the fast Opus burn, not the blended average
    And the result is flagged as having switched models

  # --- Gap 1: the binding window (5h vs weekly) ---

  Scenario: On a Max plan the weekly window can be the binding constraint
    Given a Max session where the 5h window is 30% used and resets in 2h00m
    And the weekly window is 92% used and resets in 4d
    When the burn rate and time-to-limit are computed
    Then both windows have their own burn rate and minutes-left
    And the reported time-to-limit is the smaller of the two horizons
    And the screen indicates the weekly window is the wall

  Scenario: On a Pro session with only a 5h window, that window binds
    Given a Pro session where the 5h window is 60% used
    And there is no weekly rate-limit meter present
    When the time-to-limit is computed
    Then it is based on the 5h window
    And the absence of a weekly meter does not blank the screen

  # --- Gap 1 continued: ROI capped at the nearest reset, whichever window ---

  Scenario: Clearing cannot buy more time than the nearest reset across both windows
    Given the 5h window resets in 2h00m and the weekly window resets in 30m
    And clearing would sharply reduce the projected burn
    When the clear-ROI is computed
    Then the minutes bought are capped at 30 minutes
    And the figure never exceeds the nearest reset horizon

  # --- ROI blow-up guard ---

  Scenario: A near-zero projected post-clear burn cannot produce absurd budget bought
    Given a calibrated context-to-burn line that extrapolates below zero at baseline
    And the current budget already outlasts the reset horizon
    When the clear-ROI is computed
    Then the projected post-clear burn is floored to a realistic minimum
    And the minutes bought never exceed the reset horizon
    And the screen never shows hundreds or more hours of budget bought

  # --- Gap 2: window inference for "% of window" normalization ---

  Scenario: A lightly used session prefers the live reported window over a guess
    Given the live status reports a context_window_size of 1000000
    And the session never exceeded 150K tokens
    When the working context is normalized to percent of window
    Then the window used is 1000000 from the live status
    And it is not under-estimated to a 200K tier

  Scenario Outline: Historical transcripts infer a window as a best-effort lower bound
    Given a transcript on model "<model>" whose max observed context is <maxCtx>
    When its window is inferred
    Then the inferred window is at least <window>

    Examples:
      | model            | maxCtx | window  |
      | claude-opus-4-7  | 150000 | 200000  |
      | claude-opus-4-8  | 700000 | 1000000 |
      | unknown-model    | 450000 | 512000  |

  # --- Smoothed estimator: steadier than the raw slope (chosen by backtest) ---

  Scenario: The smoothed burn rate is far steadier than the raw instantaneous slope
    Given a bursty meter series alternating fast and slow intervals
    When the smoothed rate and the raw last-interval slope are tracked across the series
    Then the smoothed rate's step-to-step jitter is much lower than the raw slope's

  # --- Gap 3: resets_at robustness ---

  Scenario Outline: resets_at is parsed whether epoch seconds or an ISO string
    Given a five_hour reset value of "<value>"
    When the time-to-reset is computed
    Then it yields a finite duration, not NaN

    Examples:
      | value                |
      | 1750000000           |
      | 2026-06-19T18:30:00Z |
