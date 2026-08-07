# Design tier: the decision rules of src/git-working-tree.js — the stat-vs-
# content modified check, the ignore subset the untracked walk honors, the walk
# budget, and the renderer's row-budget arithmetic. Outside the visionary's
# review contract; see git-index-format.feature's header for the tier's rules.
#
# RECORDED LIMITS, so they are decisions and not oversights:
# - The walk honors `.gitignore` files and `.git/info/exclude`, and does NOT
#   consult the user's global excludesFile — a config lookup away, but its
#   patterns describe the user's machine rather than the repository, and the
#   far-side oracle pins this reader against `git status` run with global
#   config disabled.
# - Paths are compared case-SENSITIVELY everywhere (no core.ignorecase). On a
#   case-insensitive filesystem a repository whose on-disk case has drifted
#   from its index case (a case-only rename made on another machine) would
#   double-report that path as modified-and-untracked until a checkout
#   normalizes it. Surfaced by the phase's blind:surface pass, 2026-08-06;
#   accepted because the state is rare, transient, and honestly displayed.

Feature: Deciding what is uncommitted
  As the working-tree section
  I want each path's state decided the way git decides it
  So that the pane and `git status` never tell different stories

  Scenario: A same-size edit is caught by content, not by stat
    Given a repo whose committed file "a.txt" holds "aaaa"
    And the working copy of "a.txt" was edited to "bbbb" at a new timestamp
    When the working tree is computed
    Then "a.txt" is marked "M"

  Scenario: A touched but unchanged file stays clean
    Given a repo whose committed file "a.txt" holds "aaaa"
    And the working copy of "a.txt" was touched without changing it
    When the working tree is computed
    Then nothing is marked

  Scenario: A file ignored by .gitignore is not untracked
    Given a repo ignoring "*.log"
    And the working tree holds the file "debug.log"
    When the working tree is computed
    Then nothing is marked

  Scenario: A negated pattern re-includes what a broader one ignored
    Given a repo ignoring "*.log" except "keep.log"
    And the working tree holds the file "debug.log"
    And the working tree holds the file "keep.log"
    When the working tree is computed
    Then "keep.log" is marked "?"
    And "debug.log" is not listed

  Scenario: A deeper .gitignore overrides a shallower one
    Given a repo ignoring "*.tmp"
    And the directory "sub" re-includes "*.tmp" in its own .gitignore
    And the working tree holds the file "top.tmp"
    And the working tree holds the file "sub/inner.tmp"
    When the working tree is computed
    Then "sub/inner.tmp" is marked "?"
    And "top.tmp" is not listed

  Scenario: The repository-local exclude file is honored
    Given a repo whose exclude file ignores "*.secret"
    And the working tree holds the file "notes.secret"
    When the working tree is computed
    Then nothing is marked

  Scenario: A staged deletion is a staged change
    Given a repo whose committed file "gone.txt" is staged for deletion
    When the working tree is computed
    Then "gone.txt" is marked "+"

  Scenario: The untracked walk stops at its budget and says so
    Given a repo holding more untracked files than a 10-entry walk budget
    When the working tree is computed with that budget
    Then the result is marked truncated

  # The cap's APPLICATION, held here until the product scenario that names it
  # binds with the commit graph (test/wip-register.js): the arithmetic outline
  # below proves the budget, this proves the list actually obeys it.
  Scenario: The file list is cut at its budget and the remainder counted
    Given a working tree of 240 modified entries
    And a pane 20 rows tall
    When the working-tree lines are rendered
    Then 8 file rows are rendered
    And a rendered row says "232 more"

  Scenario Outline: The file list's row budget
    Given a pane <rows> rows tall
    When the file-row budget is computed
    Then the list may use <fileRows> rows

    Examples:
      | rows | fileRows |
      | 20   | 8        |
      | 12   | 2        |
      | 5    | 2        |
      | 60   | 16       |
