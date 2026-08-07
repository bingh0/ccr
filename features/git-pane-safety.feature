# Tool: ccr sidecar — what the git pane must never do to the sidebar.
# Scoped 2026-08-04 via /scope. Steps bound 2026-08-06
# (test/steps/git-pane-safety.steps.js).
#
# A repository is not trusted input. Branch names and commit subjects are
# written by whoever wrote them, including whoever wrote the last thing you
# cloned, so they reach the sidebar as display data and nothing more. The
# wedging scenarios come from a failure already met in this codebase: a planted
# file that blocked a write froze the whole draw loop with no error at all, so a
# new reader of on-disk state gets the same scrutiny.
#
# The @security tags below LANDED WITH THE BINDINGS, as the scoping record
# required: carrying them earlier would have claimed a guarantee the pane could
# not yet make, and test/security-tags.test.js refuses a tagged scenario that
# does not bind — the gate ignores `wip` entirely, by design.

Feature: Refusing to harm the sidebar
  As someone whose sidebar is the only thing still running
  I want a bad repository to spoil at most its own pane
  So that a glance is never the thing that breaks my session

  @security
  Scenario: A commit subject carrying terminal escapes is shown as plain text
    Given the newest commit's subject contains a terminal escape sequence
    When the git pane renders
    Then the pane emits no escape sequence taken from that subject
    And the pane shows the printable characters of that subject

  @security
  Scenario: A branch name carrying terminal escapes is shown as plain text
    Given the checked-out branch name contains a terminal escape sequence
    When the git pane renders
    Then the pane emits no escape sequence taken from that branch name

  @security
  Scenario: A repository whose git data cannot be read degrades inside the pane
    Given the repo's git data cannot be read
    When the git pane renders
    Then the pane shows "git data unavailable"
    And cycling still reaches the economy panel

  Scenario: The repository is deleted while the pane is live
    Given the git pane is showing the repo "ccr"
    When the repo directory is deleted
    And the git pane redraws
    Then the pane shows "not a git repository"
    And the sidebar redraws again on its next tick

  @security
  Scenario: The pane never writes to the repository
    Given the git pane is showing the repo "ccr"
    When the git pane renders 100 times
    Then no file in the repo is created, changed or deleted
    And the pane holds no capability to run a command
