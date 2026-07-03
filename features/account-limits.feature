# Acceptance criteria for cross-profile meter reconciliation — the "the sidecars
# don't agree on 5h/weekly" bug.
#
# The 5h and weekly walls are ONE account-wide resource, but each ccr profile
# (cq/cw/ce/cr, …) only captures them when its own Claude session renders the
# status line. An idle profile's panel therefore lags a busy one. We reconcile the
# meters across sibling profiles ON THE SAME ACCOUNT so their sidecars agree — and,
# because the snapshot has no account id, we guard against ever mixing DIFFERENT
# accounts by matching the account-wide buckets' reset instants exactly.

Feature: Account-wide meters agree across profiles
  As a user running several ccr profiles side-by-side on one account
  I want every sidecar's 5h/weekly meters to show the freshest shared numbers
  So that two panels don't disagree just because one session has been idle

  # --- The reported bug: idle profile lags the busy one ---

  Scenario: An idle profile catches up to a busier sibling on the same account
    Given the local profile last captured 5h at 15% and weekly at 18%
    And a sibling profile on the same account shows 5h at 16% and weekly at 19%
    When the meters are reconciled
    Then the local 5h meter reads 16%
    And the local weekly meter reads 19%

  Scenario: The model in use does not matter (Opus and Fable reconcile)
    # cq runs Opus 4.8, cw runs Fable 5 — same account, same account-wide buckets.
    Given the local profile last captured 5h at 15% and weekly at 18%
    And a sibling profile on the same account shows 5h at 16% and weekly at 19%
    When the meters are reconciled
    Then the local weekly meter reads 19%

  Scenario: Reconciliation never drives a meter backwards
    Given the local profile last captured 5h at 40% and weekly at 50%
    And a sibling profile on the same account shows 5h at 16% and weekly at 19%
    When the meters are reconciled
    Then the local 5h meter reads 40%
    And the local weekly meter reads 50%

  # --- The guard: DIFFERENT accounts must never be mixed ---

  Scenario: A sibling on a different account is ignored wholesale
    Given the local profile last captured 5h at 15% and weekly at 18%
    And a sibling profile on a different account shows 5h at 99% and weekly at 99%
    When the meters are reconciled
    Then the local 5h meter reads 15%
    And the local weekly meter reads 18%

  Scenario: A different account cannot bump even a coincidentally-aligned window
    # Its 5h happens to reset at the same instant, but its weekly does not — so the
    # whole sibling is distrusted and the aligned 5h is left untouched too.
    Given the local profile last captured 5h at 15% and weekly at 18%
    And a sibling whose 5h reset aligns but whose weekly reset differs shows 5h at 88%
    When the meters are reconciled
    Then the local 5h meter reads 15%

  Scenario: A stale sibling from an already-rolled window is not treated as fresh
    Given the local profile last captured 5h at 15% and weekly at 18%
    And a sibling whose 5h window has already rolled shows 5h at 2%
    When the meters are reconciled
    Then the local 5h meter reads 15%

  # --- Robustness ---

  Scenario: The freshest value wins across several same-account siblings
    Given the local profile last captured 5h at 15% and weekly at 18%
    And same-account siblings report weekly at 17%, 22% and 19%
    When the meters are reconciled
    Then the local weekly meter reads 22%
