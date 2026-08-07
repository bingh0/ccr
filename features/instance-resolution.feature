# Tool: `ccr` — finding the instance you meant. Scoped 2026-08-06 via /scope
# (instance layout interview). NOT YET BUILT: registered in
# test/wip-register.js until its steps bind.
#
# The chain, ruled: CCR_STATE_DIR wins → else the live instance whose launch
# directory contains the cwd (longest match) → else the single live one →
# else list them and refuse. `-i <name>` selects from the LIVE SET — the same
# set the final branch lists — and is honored by exactly three commands:
# economy, sidecar, cycle-view. Every other command refuses it LOUDLY,
# because the option parser is global: a silently swallowed -i would let
# "ccr resume -i side-project" look targeted while targeting nothing.
# The safeguard replacing any account bound: every instance-targeted command
# heads its output with the name it resolved to.
#
# CCR_STATE_DIR naming the container is refused — that is the old
# container/member confusion arriving by env var instead of by layout. This
# scenario earns a @security tag when its steps bind — recorded in
# features/OUT-OF-SCOPE.md as deliberate debt.

Feature: Finding the one you meant
  As someone with several live instances
  I want ccr's commands to resolve the instance I meant, or say why not
  So that a panel about one instance is never read as a panel about another

  Scenario: An explicit state dir wins the resolution
    Given instance "a" is live and was launched in the current directory
    And CCR_STATE_DIR names instance "b"'s state dir
    When ccr economy resolves its instance
    Then it resolves to instance "b"

  Scenario: The instance whose launch directory contains the cwd is chosen
    Given instance "a" was launched in "~/code/app"
    And instance "b" was launched in "~/notes"
    And the current directory is "~/code/app/src"
    When ccr economy resolves its instance
    Then it resolves to instance "a"

  Scenario: The longest matching launch directory wins
    Given instance "a" was launched in "~/code"
    And instance "b" was launched in "~/code/app"
    And the current directory is "~/code/app/src"
    When ccr economy resolves its instance
    Then it resolves to instance "b"

  Scenario: A single live instance is chosen from anywhere
    Given only instance "a" is live
    And the current directory is inside no instance's launch directory
    When ccr economy resolves its instance
    Then it resolves to instance "a"

  Scenario: Several candidates and no signal lists them and refuses
    # Ruled 2026-08-06: "you list and offer the prompt, because you have no
    # idea what the user is looking for."
    Given instances "a" and "b" are live
    And the current directory is inside no instance's launch directory
    When ccr economy resolves its instance
    Then the command fails
    And the output lists "a" and "b"
    And the output offers -i as the way to choose

  Scenario: Two instances launched from the same directory are listed, not guessed
    # Ruled 2026-08-06 against rendered screens: the collision-suffix ruling
    # creates exactly this world (two bare launches from one repo), the
    # containment branch ties at equal length, and the account-shared meter
    # rows are identical on both instances — a silently picked panel would
    # be wrong only in its subtlest rows. "You list and offer the prompt,
    # because you have no idea what the user is looking for."
    Given instance "gitrepo" was launched in "~/code/gitrepo"
    And instance "gitrepo2" was launched in "~/code/gitrepo"
    And the current directory is "~/code/gitrepo"
    When ccr economy resolves its instance
    Then the command fails
    And the output lists "gitrepo" and "gitrepo2"
    And the output offers -i as the way to choose

  Scenario: -i selects among the live instances
    Given instances "side-project" and "main-work" are live
    When ccr economy runs with -i "side-project"
    Then the panel is headed "side-project"

  Scenario: A mistyped -i matches nothing and errors
    Given instance "side-project" is live
    When ccr economy runs with -i "side-projct"
    Then the command fails
    And the error names "side-projct" as not live

  Scenario Outline: Commands that do not target an instance refuse -i
    When ccr <command> runs with -i "side-project"
    Then the command fails
    And the error says -i applies to economy, sidecar and cycle-view

    Examples:
      | command    |
      | resume     |
      | doctor     |
      | statusline |
      | launch     |

  Scenario: An instance-targeted command names what it resolved to
    # The safeguard that replaced bounding names by account: the mistake a
    # user actually makes is reading the right panel about the wrong
    # instance. The heading catches it.
    Given instances "side-project" and "main-work" are live
    And the current directory is inside "main-work"'s launch directory
    When ccr economy runs
    Then the panel is headed "main-work"

  Scenario: CCR_STATE_DIR pointing at the container is refused
    Given CCR_STATE_DIR names the ccr home itself
    When ccr economy resolves its instance
    Then the command fails
    And the error says the ccr home is a container, not an instance
