# Tool: src/launch-win.js  (cmdLaunch dispatch on win32)
# Spec: §4.2, §5.1, §5.2  |  Acceptance: §8.2, §8.6
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
    And both panes receive CCR_STATE_DIR pointing at "~/.ccr"
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
    And both panes receive CCR_STATE_DIR pointing at "~/.ccr/c1"
    And the tmux-equivalent session name is "ccr-c1"

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
