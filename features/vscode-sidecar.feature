# Tool: src/launch-vscode.js  (VS Code integrated-terminal split launcher)
# Spec: §10  |  Acceptance: §10.1–10.6
# A shell process cannot trigger VS Code's terminal split itself, so `ccr` wires
# everything AROUND it: runs Claude in the current pane and hands the user a
# clipboard-copied one-liner for the split pane. Not Windows-only — the same path
# serves macOS/Linux VS Code users (opt-in via CCR_VSCODE=1, since tmux already
# works there).

Feature: VS Code split-terminal sidecar
  As a VS Code user running `ccr` in the integrated terminal
  I want the sidecar wired up with a one-paste split
  So that I get the live sidebar without a separate window or WSL

  Background:
    Given `ccr` is running inside a VS Code integrated terminal
    And `claude` is resolvable on PATH

  @AC10
  Scenario: Bare `ccr` runs Claude in the current pane and shows the split steps
    When I run "ccr"
    Then Claude starts in the current pane via `claude --settings <temp-file>`
    And a prominent banner shows the split keybinding and the sidecar one-liner
    And the process exits with Claude's exit code

  @AC10
  Scenario Outline: The split keybinding matches the platform
    When I run "ccr" on "<os>"
    Then the banner shows the split keybinding "<key>"

    Examples:
      | os      | key          |
      | macOS   | Cmd+\        |
      | Windows | Ctrl+Shift+5 |
      | Linux   | Ctrl+Shift+5 |

  @AC10
  Scenario: The sidecar one-liner carries the state dir and is copied to the clipboard
    When I run "ccr"
    Then the sidecar one-liner targets the resolved state dir by argument
    And it is copied to the clipboard via an OSC 52 escape

  @AC10
  Scenario: Exiting Claude flips the sidecar to the session-ended state
    When I run "ccr" and Claude exits
    Then the "exited" sentinel is dropped in the state dir
    And the temp settings file is cleaned up

  @AC10
  Scenario: `ccr sidecar --hint` reprints the steps without launching Claude
    When I run "ccr sidecar --hint"
    Then a banner with the split steps is printed
    And no Claude process is started

  @AC10
  Scenario: `ccr <profile>` targets the CCS profile state dir
    Given `ccs` is resolvable on PATH
    And the CCS profile directory for "c1" exists
    When I run "ccr c1"
    Then Claude starts via `ccs c1 --settings <temp-file>`
    And the sidecar one-liner targets the "~/.ccr/c1" state dir

  @AC10
  Scenario: Unknown CCS profile errors clearly and starts nothing
    Given `ccs` is resolvable on PATH
    And the CCS profile directory for "nope" does not exist
    When I run "ccr nope"
    Then stderr explains the profile was not found
    And no Claude process is started
