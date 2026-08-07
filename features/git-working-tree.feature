# Tool: ccr sidecar — the git pane's working-tree section.
# Scoped 2026-08-04 via /scope. Steps bound 2026-08-06
# (test/steps/git-working-tree.steps.js), the long-list scenario's final Then
# binding last, with the commit graph it draws.
#
# The second half of the reported problem: not remembering what is finished and
# what is in flight. Finished is the commit graph; in flight is this section.
# It sits above the graph and below the identity line, so it competes with the
# graph for vertical space — which is why the long-list case has a stated cap
# rather than being left to run.

Feature: Seeing what is uncommitted
  As someone returning to a tab after working elsewhere
  I want the pane to show what is changed but not yet committed
  So that I can pick up where I left off without asking

  Scenario: Staged, modified and untracked files are listed with their state
    Given the repo has the staged file "src/git-pane.js"
    And the repo has the modified file "bin/ccr.js"
    And the repo has the untracked file "test/git-pane.test.js"
    When the git pane renders
    Then the pane shows 3 changes in total
    And "src/git-pane.js" is listed with "+"
    And "bin/ccr.js" is listed with "M"
    And "test/git-pane.test.js" is listed with "?"

  Scenario: A clean tree says so instead of showing an empty list
    Given the repo has no staged, modified or untracked files
    When the git pane renders
    Then the pane shows "clean"
    And the pane lists no file paths

  Scenario: A long list of changes is capped and the remainder counted
    Given the repo has 240 modified files
    And the pane has room for 8 file rows
    When the git pane renders
    Then the pane lists 8 file paths
    And the pane shows "232 more"
    And the commit graph is still drawn below the list

  Scenario: A rebase in progress is named and its conflicts marked
    Given the repo is part-way through a rebase
    And the repo has the conflicted file "src/sidecar.js"
    When the git pane renders
    Then the pane shows "rebase in progress"
    And "src/sidecar.js" is listed with "!"

  Scenario Outline: A path too long for the pane keeps its file name
    Given the pane is 40 columns wide
    And the repo has the modified file "<path>"
    When the git pane renders
    Then the file row is at most 40 columns wide
    And the file row ends with "<tail>"

    Examples:
      | path                                          | tail              |
      | bin/ccr.js                                    | bin/ccr.js        |
      | src/render/panes/git/commit-graph-renderer.js | graph-renderer.js |
      | a.js                                          | a.js              |
