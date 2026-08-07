# Tool: `ccr` — how an instance gets its name. Scoped 2026-08-06 via /scope
# (instance layout interview). NOT YET BUILT: registered in
# test/wip-register.js until its steps bind.
#
# Identity is the slot number; the name is a friendly label on top. The
# character mapping below is LOAD-BEARING FOR SECURITY, not cosmetics: the
# autoname derives from a directory name, `git clone` names the directory
# after the repo, and the name reaches the terminal title inside an escape
# sequence. Some terminals can echo the title back as terminal INPUT, so a
# repo named "; rm -rf ~" is plain ASCII that no control-byte filter touches.
# Constraining the character set is the guard. Nobody may later relax it as
# cosmetic. The mapping scenarios below earn @security tags when their steps
# bind — recorded in features/OUT-OF-SCOPE.md as deliberate debt.
#
# Asymmetry, ruled: a DERIVED name is mapped (the user didn't choose it); an
# EXPLICIT name is rejected (they typed it, and a human is right there to fix
# it). The rejection message matches the launcher's existing profile message.

Feature: Choosing a name
  As someone with several instances at once
  I want each instance to get a sensible name without my typing one
  So that I can tell my instances apart

  Scenario: The default name is the repository directory's name
    Given the launch directory is a git repository checked out at "~/code/gitrepo"
    When a bare ccr launches
    Then the instance's name is "gitrepo"

  Scenario: Outside a repository the working directory names the instance
    Given the launch directory "~/notes" is not inside a git repository
    When a bare ccr launches
    Then the instance's name is "notes"

  Scenario Outline: Characters outside the allowed set become dashes
    Given the launch directory's basename is "<dirname>"
    When a bare ccr launches
    Then the instance's name is "<name>"

    Examples:
      | dirname        | name           |
      | my repo        | my-repo        |
      | café           | caf-           |
      | ; rm -rf ~     | --rm--rf--     |
      | .hidden-file_1 | .hidden-file_1 |

  Scenario: A name with nothing legal falls back to the slot number
    Given the launch directory's basename is "###"
    And the launch takes slot 2
    When a bare ccr launches
    Then the instance's name is "2"

  Scenario: A second instance from the same repository gets a suffix
    Given a live instance named "gitrepo"
    When a bare ccr launches from another directory also named "gitrepo"
    Then the new instance's name is "gitrepo2"

  Scenario: The suffix is the lowest free among live names, not the slot number
    # The failing world: a suffix derived from the slot. With "gitrepo" on
    # slot 1 and "gatrepo" on slot 2, the new launch lands on slot 3 and a
    # slot-derived suffix would read "gitrepo3" — the third gitrepo that
    # never existed.
    Given a live instance named "gitrepo" on slot 1
    And a live instance named "gatrepo" on slot 2
    When a bare ccr launches from a directory named "gitrepo"
    Then the new instance takes slot 3
    And the new instance's name is "gitrepo2"

  Scenario: A generated name steps past every live name
    # "gitrepo2" here is a real directory's name, not a generated suffix. The
    # generator checks ALL live names, so the two cannot collide.
    Given a live instance named "gitrepo"
    And a live instance named "gitrepo2"
    When a bare ccr launches from a directory named "gitrepo"
    Then the new instance's name is "gitrepo3"

  Scenario: Suffixes go double-digit rather than wrapping
    Given live instances named "gitrepo" and "gitrepo2" through "gitrepo9"
    When a bare ccr launches from a directory named "gitrepo"
    Then the new instance's name is "gitrepo10"

  Scenario: A dead instance's name is free again
    # Accepted consequence of ephemerality: this launch's "gitrepo" is
    # younger than the still-running "gitrepo2".
    Given instance "gitrepo" has exited while instance "gitrepo2" lives
    When a bare ccr launches from a directory named "gitrepo"
    Then the new instance's name is "gitrepo"

  Scenario: An explicit name is taken as given
    Given the launch directory is a git repository named "gitrepo"
    When ccr launches with --name "a-is-awesome"
    Then the instance's name is "a-is-awesome"

  Scenario: An illegal explicit name is rejected, not mapped
    When ccr launches with --name "my repo"
    Then the launch fails
    And the error reads "ccr: invalid instance name 'my repo' (allowed: letters, digits, . _ -)"

  Scenario: An explicit name colliding with a live instance is refused
    # Ruled 2026-08-06 ("refuse makes the most sense"): names must be unique
    # among live instances for -i to resolve, and an explicit name is
    # rejected rather than repaired — silently suffixing it would make the
    # address you typed target someone else's instance.
    Given a live instance named "side-project"
    When ccr launches with --name "side-project"
    Then the launch fails
    And the error says "side-project" is already live

  Scenario: A bare positional stays a CCS profile even beside --name
    # The owner's own proof: launching a profile WITH a name needs two
    # values, and one positional cannot carry both. If the positional were
    # the name, this scenario's combination would have no expressible form.
    When ccr launches with positional "cc1" and --name "a-is-awesome"
    Then the launch targets CCS profile "cc1"
    And the instance's name is "a-is-awesome"
