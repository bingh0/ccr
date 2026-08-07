# Tool: `ccr` — showing which instance you're in. Scoped 2026-08-06 via
# /scope (instance layout interview). NOT YET BUILT: registered in
# test/wip-register.js until its steps bind.
#
# Three surfaces, three jobs, ruled together:
#   - the terminal TITLE is the tab's ADDRESS: `[profile / ]name`, composed
#     at launch, never retitled — a tab you are scanning for must not rename
#     itself while you look, and the title must keep matching the name -i
#     accepts.
#   - the STATUS LINE is the ORIENTATION surface: identity first, and its
#     repository half is LIVE — "at the bottom makes the most sense, because
#     that's where someone is typing and knowing which session they are in
#     reduces errors."
#   - the SIDEBAR names its instance once you are looking at it.
# Marquee scrolling and alternate flashing were rejected: Claude re-renders
# the status line per turn, not on a clock, so both freeze exactly when the
# user is idle and orienting. Ellipsis is deterministic instead.

Feature: Showing which instance you're in
  As someone with several terminal tabs each running ccr
  I want every tab, status line and sidebar to say which instance it is
  So that long sessions never leave me typing into the wrong one

  Scenario: The title is the instance's name
    Given a bare ccr launched from repository "a"
    When the terminal title is composed
    Then the terminal title is "a"

  Scenario: A profile prefixes the title
    Given ccr launched with CCS profile "cc1" from repository "a"
    When the terminal title is composed
    Then the terminal title is "cc1 / a"

  Scenario: An explicit name replaces the derived one in the title
    Given ccr launched from repository "a" with --name "a-is-awesome"
    When the terminal title is composed
    Then the terminal title is "a-is-awesome"

  Scenario: Profile and explicit name compose in the title
    Given ccr launched with CCS profile "cc1" and --name "a-is-awesome"
    When the terminal title is composed
    Then the terminal title is "cc1 / a-is-awesome"

  Scenario: The title is never retitled mid-session
    # The title is an address, and the pane is the surface that is honest
    # about movement. The failing world: a title that follows the session,
    # renaming the tab out from under the user scanning for it.
    Given an instance titled "a" whose session has changed directory into repository "b"
    When the terminal title is observed after the move
    Then the terminal title is still "a"

  Scenario: The status line leads with the instance identity
    Given an instance named "a-is-awesome" launched in repository "ccr"
    When the status line renders
    Then the status line begins with "a-is-awesome @ ccr"

  Scenario: The status line's repository follows a mid-session move
    Given an instance named "a-is-awesome" launched in repository "ccr"
    And the session has changed directory into repository "docs-mirror"
    When the status line renders
    Then the status line begins with "a-is-awesome @ docs-mirror"

  Scenario: An imminent limit outranks the identity
    Given an instance named "a-is-awesome" in repository "ccr"
    And the binding window has 20 minutes left
    When the status line renders
    Then the imminent-limit marker appears before "a-is-awesome"

  Scenario: A location matching the name is not repeated
    # Ruled 2026-08-06: the location half appears only when it has something
    # to add — the same rule the git pane ratified for launch names. A bare
    # launch inside a repo derives its name from that repo, so repeating it
    # says nothing twice.
    Given a bare ccr launched from repository "ccr"
    When the status line renders
    Then the status line begins with "ccr"
    And the status line does not contain "ccr @ ccr"

  Scenario: Outside a repository the location is the directory itself
    Given a bare ccr launched from directory "~/notes"
    And the session has changed directory into repository "gitrepo"
    When the status line renders
    Then the status line begins with "notes @ gitrepo"

  Scenario: A long name is shortened deterministically and the repository stays whole
    # The repository is the orienting half, so it survives untouched; the
    # name takes a stable middle ellipsis. The third Then is the anti-marquee
    # pin: two renders of the same state are identical, so nothing slides,
    # blinks or alternates.
    Given an instance named "a-very-long-instance-name-indeed" in repository "docs-mirror"
    When the status line renders into 34 columns
    Then the identity shows "docs-mirror" in full
    And the instance name is shortened with an ellipsis
    And a second render of the same state is identical to the first

  Scenario: The sidebar names its instance
    Given an instance named "side-project"
    When its sidebar draws
    Then the sidebar shows the name "side-project"
