# Tool: buildWtArgs() / findWindowsTerminal()  in src/launch-win.js
# Spec: §5.2, §6, §9 (risks)  |  Acceptance: §8.9 (pure logic gets unit coverage)
# Pure arg-building: no spawning. These are the unit-testable scenarios that pin
# the exact wt.exe argv so the `;` separator and per-pane env injection cannot
# regress.

Feature: Windows Terminal argv construction
  As the launcher
  I want a deterministic, correctly-quoted wt.exe argument vector
  So that the two panes start with the right command and environment

  @AC9
  Scenario: Build the canonical two-pane argv for plain `claude`
    Given node resolves to "C:\Program Files\nodejs\node.exe"
    And ccrJs resolves to the packaged "bin/ccr.js"
    And the state dir is "C:\Users\me\.ccr"
    And the settings file is "C:\Temp\ccr-settings-ab12.json"
    And the Claude command is "claude"
    And the sidebar percentage is 34
    When I build the wt.exe args
    Then the first pane is a "new-tab" titled "Claude"
    And the first pane command sets CCR_STATE_DIR then runs `claude --settings` with the settings file
    And a "split-pane" token "-V" with size "0.34" follows
    And the pane separator ";" is a standalone argv token
    And the second pane command sets CCR_STATE_DIR then runs node with ccrJs and "sidecar"

  @AC9
  Scenario: Per-pane environment is injected via cmd /c, not wt global env
    When I build the wt.exe args
    Then each pane command is wrapped in `cmd /c set CCR_STATE_DIR=...&& ...`
    And CCR_STATE_DIR is present in both panes' commands

  @AC9
  Scenario: The launch reuses the current window and sweeps closed on exit
    When I build the wt.exe args
    Then the args target the current window with "-w 0"
    And the sidecar pane carries "--exit-on-end" so it sweeps closed on session end

  @AC9
  Scenario: Pane 0 appends the exit sentinel after Claude exits
    When I build the wt.exe args
    Then pane 0's command appends a write of the "exited" sentinel into the state dir

  @AC9 @AC8
  Scenario: The settings file path is passed by path, never inline JSON
    When I build the wt.exe args
    Then the claude command references the settings file by path
    And no raw JSON object appears on the command line

  @AC7
  Scenario: findWindowsTerminal returns null when wt.exe is absent
    Given `wt.exe` is not resolvable on PATH
    When findWindowsTerminal is called
    Then it returns null
    And it does not throw
