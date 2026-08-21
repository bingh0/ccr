# Tool: src/launch-win.js  (cmdLaunch dispatch on win32)
# Spec: §4.2, §5.1, §5.2  |  Acceptance: §8.2, §8.6, §8.10
# The launcher replaces the bash/tmux launch layer on native Windows. It opens
# one Windows Terminal window split into two panes — Claude Code and ccr sidecar
# — wiring CCR_STATE_DIR into both and never mutating ~/.claude.

Feature: Windows native launcher
  As a Windows user running `ccr`
  I want Claude Code and the live sidecar launched side-by-side without WSL
  So that I get the sidebar experience natively

  Background:
    Given the platform is win32
    And Node 18.3+ is installed
    And `claude` is resolvable on PATH
    And `wt.exe` (Windows Terminal) is resolvable on PATH

  @AC2
  Scenario: Bare `ccr` opens a split Windows Terminal window
    When I run "ccr"
    Then exactly one Windows Terminal window opens with two panes
    And the left pane runs Claude Code via `claude --settings <temp-file>`
    And the right pane runs `ccr sidecar` at approximately 34% width
    And both panes receive CCR_STATE_DIR pointing at "~/.ccr/instances/1"
    And the process exits 0

  # Windows Terminal does NOT inherit the caller's directory the way `tmux
  # new-session` does — without `-d` a pane opens in the WT *profile's*
  # startingDirectory (default %USERPROFILE%). The launcher already knows the
  # right answer: it records process.cwd() as the tab's launch dir. These pin
  # that the same directory also reaches the panes.
  @AC10
  Scenario: Claude Code opens in the directory ccr was launched from
    Given ccr is run from the directory "C:\work\app"
    When I run "ccr"
    Then both panes are given the starting directory "C:\work\app"
    And the recorded launch directory is "C:\work\app"

  # `%` is legal in a Windows path and harmless as a standalone argv token —
  # cmd never sees it. The cmd-payload validator rejects `%`, and reusing it
  # here would refuse a perfectly valid directory.
  @AC10
  Scenario: A launch directory containing a percent sign is passed through unharmed
    Given ccr is run from the directory "C:\100%done"
    When I run "ccr"
    Then both panes are given the starting directory "C:\100%done"

  # `;` is legal in a Windows path AND is wt's own pane separator, and Node
  # only quotes an argv token that contains a space. Refusing to launch over a
  # legal directory name would trade one broken launch for another, so the
  # launch proceeds and says where it landed.
  @AC10
  Scenario: A launch directory Windows Terminal cannot be given still launches
    Given ccr is run from the directory "C:\my;dir\app"
    When I run "ccr"
    Then no starting directory is given to Windows Terminal
    And stderr explains the panes open in the default directory
    And exactly one Windows Terminal window opens with two panes
    And the process exits 0

  @AC2
  Scenario: The default sidecar width honors CCR_SIDEBAR_PCT
    Given the environment sets CCR_SIDEBAR_PCT to "50"
    When I run "ccr"
    Then the sidecar pane is split at approximately 50% width

  @AC6
  Scenario: `ccr <profile>` targets the CCS profile state dir
    Given `ccs` is resolvable on PATH
    And the CCS profile directory "~/.ccs/instances/c1" exists
    When I run "ccr c1"
    Then the left pane runs Claude Code via `ccs c1 --settings <temp-file>`
    And both panes receive CCR_STATE_DIR pointing at "~/.ccr/instances/1"
    And the profile launch slots like a bare one, session "ccr"

  @AC6
  Scenario: Unknown CCS profile errors clearly and lists available profiles
    Given `ccs` is resolvable on PATH
    And the CCS profile directory "~/.ccs/instances/nope" does not exist
    When I run "ccr nope"
    Then stderr explains the profile was not found
    And stderr lists the available profiles
    And the process exits non-zero
    And no Windows Terminal window is opened

  @AC6
  Scenario: `ccr <profile>` requires ccs on PATH
    Given `ccs` is not resolvable on PATH
    When I run "ccr c1"
    Then stderr explains that `ccs` must be installed to use a profile
    And the process exits non-zero

  Scenario Outline: Invalid profile names are rejected before any spawn
    When I run "ccr <profile>"
    Then stderr reports an invalid profile name
    And the allowed character set "letters, digits, . _ -" is shown
    And the process exits non-zero
    And no command is spawned

    Examples:
      | profile      |
      | ../escape    |
      | a b          |
      | name;rm      |
      | "quoted"     |

  Scenario: Stale exited sentinel is cleared before launch
    Given a stale file "exited" exists in the resolved state dir
    When I run "ccr"
    Then the "exited" sentinel is removed before the panes start
    And the secure state dir is ensured to exist
