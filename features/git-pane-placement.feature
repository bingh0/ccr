# Tool: ccr sidecar — where the git pane sits among the views, and across tabs.
# Scoped 2026-08-04 via /scope. NOT YET BUILT: registered in the `wip` list in
# test/features.test.js until its steps are bound.
#
# Settled before the interview began: this is an EXTRA view cycled alongside the
# economy panel, never a replacement for it. The isolation scenarios are the
# motivating problem stated as a rule — six tabs, six repos, and no leakage
# between them, which is also the promise the instance-slot work makes.

Feature: Living alongside the economy panel
  As someone with six tabs open on six repos
  I want each tab's views to answer for that tab only
  So that adding the git pane costs me neither the economy panel nor clarity

  Scenario: Cycling reaches the git pane in addition to the economy panel
    Given the sidebar is showing the economy panel
    When the view is cycled once
    Then the sidebar shows the git pane

  Scenario: Cycling onward from the git pane comes back to the economy panel
    Given the sidebar is showing the git pane
    When the view is cycled until the economy panel returns
    Then the sidebar shows the economy panel
    And the economy panel shows the meters it showed before

  Scenario: Six instances each describe their own repo
    Given six ccr instances are running in six different repos
    When each instance's git pane renders
    Then each pane names the repo of its own instance

  Scenario: One instance's changes never reach another instance's pane
    Given two ccr instances are running in the repos "ccr" and "docs-site"
    And the pane for "ccr" shows 6 changes
    When 20 files are modified in "docs-site"
    Then the pane for "ccr" shows 6 changes
