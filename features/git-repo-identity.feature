# Tool: ccr sidecar — the git pane's identity line.
# Scoped 2026-08-04 via /scope. NOT YET BUILT: registered in the `wip` list in
# test/features.test.js until its steps are bound.
#
# The reported problem: up to six terminal tabs, each labelled with an instance
# name and nothing else, so nothing on screen says which repo a tab is sitting
# in. The pane answers that before it shows anything else. The launch repo is
# the tab's stable identity; the current repo follows the session, because a
# session can move and a pane that quietly describes somewhere else is worse
# than one that admits it.

Feature: Knowing which repo this tab is
  As someone running several ccr instances at once
  I want each pane to name the repo it is describing
  So that one glance at a tab tells me where I am

  Scenario: The session is working in the repo ccr was launched from
    Given ccr was launched in the repo "ccr" on branch "main"
    And the session is editing files in the repo "ccr"
    When the git pane renders
    Then the pane shows the current repo as "ccr"
    And the pane shows the branch as "main"

  Scenario: The session moves to another repo and the launch repo stays pinned
    Given ccr was launched in the repo "ccr" on branch "main"
    And the session is editing files in the repo "docs-site"
    When the git pane renders
    Then the pane shows the current repo as "docs-site"
    And the pane shows the launch repo as "ccr"

  Scenario: A detached HEAD has no branch to name
    Given ccr was launched in the repo "ccr"
    And the repo has no branch checked out
    When the git pane renders
    Then the pane shows the current repo as "ccr"
    And the pane shows "detached" where a branch name would be

  Scenario: The directory is not a git repository
    Given ccr was launched in the directory "/home/me/scratch"
    And no git repository contains that directory
    When the git pane renders
    Then the pane shows "not a git repository"
    And the pane shows no branch name

  # Added 2026-08-05 on the owner's ruling. The build had shipped a bare repo as
  # "not a git repository" and recorded it as a known limit — the reasoning being
  # that a bare repo has no working tree, so no session is really sitting in one.
  # That reasoning does not license a false sentence: it IS a repository, and the
  # pane's whole job is naming the one you are in. "bare", not "empty" — a bare
  # repo can hold a thousand commits, so "empty" would be a different claim.
  Scenario: A repository with no working tree says which kind it is
    Given ccr was launched in the bare repo "mirror.git"
    When the git pane renders
    Then the pane shows the current repo as "mirror.git"
    And the pane shows "bare repository" where a branch name would be

  Scenario Outline: A name too long for the pane is shortened, never wrapped
    Given the pane is 40 columns wide
    And ccr was launched in the repo "<repo>" on branch "<branch>"
    When the git pane renders
    Then the identity line occupies exactly 1 row
    And the identity line is at most 40 columns wide
    And the identity line contains "<shown>"

    Examples:
      | repo                               | branch                             | shown       |
      | ccr                                | main                               | ccr         |
      | claude-code-runrate-prototype-fork | feature/instance-slot-owner-rework | claude-code |
      | a                                  | wip                                | a           |
