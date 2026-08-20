# Design tier: how the suite builds LINK fixtures on each platform it runs on.
# Outside the visionary's review contract; see git-index-format.feature's
# header for the tier's rules.
#
# WHY THIS EXISTS. A dozen tests plant a symlink and assert that production
# code refuses to follow it. On Windows fs.symlinkSync throws EPERM without
# Developer Mode or elevation, so nine of them failed on the FIXTURE, not on
# the guard — which is every Windows contributor's `npm test`.
#
# RECORDED LIMITS, so they are decisions and not oversights:
# - A junction stands in for a DIRECTORY target on win32. It is unprivileged,
#   Node reports it as isSymbolicLink(), and defaultDirUsable() rejects it
#   exactly as it rejects a POSIX symlink — the property under test survives.
# - FILE targets have NO unprivileged Windows equivalent. A junction cannot
#   point at a file, and a hardlink INVERTS the property under test: writing
#   through one DOES reach the target. Faking it would turn a real guard into
#   a green test that proves the opposite of what it claims.
# - A skip is therefore a platform fact, never a silent pass.

Feature: Planting link fixtures the suite can trust
  As the test suite
  I want link fixtures built from what each platform actually allows
  So that a guard's test either proves the guard or says why it could not run

  Scenario: A directory stand-in is a symbolic link on every platform
    Given a real directory for the link to point at
    When the suite plants a directory link beside it
    Then the planted link reports as a symbolic link
    And the slot directory check accepts the real directory and refuses the link

  Scenario: The file-symlink probe answers by attempting one
    When the suite is asked whether file symlinks can be created
    Then the answer matches what creating one on this machine actually does
    And the probe leaves nothing behind on disk

  Scenario: A test needing a file link is skipped by name where none can exist
    Given a machine that cannot create a symlink to a file
    When the suite decides whether such a test should run
    Then it yields a skip reason naming the privilege that is missing

  Scenario: A test needing a file link runs where one can exist
    Given a machine that can create a symlink to a file
    When the suite decides whether such a test should run
    Then it yields no skip at all

  Scenario: A fixture the platform cannot build is announced, not passed over
    Given a scenario step that cannot build its fixture here
    When the step declines to run
    Then the reason is written to the runner's error output
    And the message names both the fixture and the platform limit
