# Tool: ccr sidecar — the git pane's commit graph.
# Scoped 2026-08-04 via /scope. Steps bound 2026-08-06
# (test/steps/git-commit-graph.steps.js).
#
# The visionary chose a multi-lane graph over a flat list, on the grounds that
# developers arrive with IDE git-graph habits. That choice is the reason the
# lane-overflow scenario below exists: it is the one form of this pane that can
# run out of horizontal room, and a graph that silently drops branches would be
# worse than the list it replaced.

Feature: Reading recent history
  As someone picking a tab back up
  I want the recent commits drawn with their branch structure
  So that what was finished reads the way it does in an IDE

  Scenario: A branch with no merges is drawn as one lane
    Given the branch "main" has 5 commits and no merges
    When the git pane renders
    Then the commits are drawn in 1 lane
    And the newest commit is on the first row
    And each commit row shows a short hash, a subject and a relative age

  Scenario: A merged side branch is drawn as a second lane
    Given the branch "main" has a side branch merged into it
    When the git pane renders
    Then the commits are drawn in 2 lanes
    And the merge commit joins the two lanes

  Scenario: A repository with no commits says so
    Given the repo has no commits
    When the git pane renders
    Then the pane shows "no commits yet"
    And the pane draws no lanes

  Scenario: More lanes than fit are collapsed and the remainder counted
    Given the history has 9 concurrent branches
    And the pane has room for 3 lanes
    When the git pane renders
    Then the commits are drawn in 3 lanes
    And the pane shows "6 more branches"

  Scenario Outline: A commit subject too long for the pane is shortened
    Given the pane is 40 columns wide
    And the newest commit's subject is "<subject>"
    When the git pane renders
    Then the commit row is at most 40 columns wide
    And the commit row contains "<shown>"

    Examples:
      | subject                                                       | shown    |
      | fix: typo                                                     | fix: typ |
      | feat(launcher): a second terminal can just run ccr end to end | feat(lau |
      | wip                                                           | wip      |
