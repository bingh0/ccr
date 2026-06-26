# Tool: temp settings file + inline statusLine command (statusLine wiring)
# Spec: §4.2 step 5, §5.3  |  Acceptance: §8.8
# Claude Code must call ccr's statusline on every tick WITHOUT mutating any file
# under ~/.claude. Injection is per-launch via `claude --settings <temp-file>`.

Feature: statusLine injection without config mutation
  As the launcher
  I want statusLine wired in per-launch via a temp settings file
  So that the user's ~/.claude config and CCS symlinks are never touched

  @AC8
  Scenario: A temp settings file is written and passed to claude
    When I run "ccr"
    Then a settings file is written under %TEMP% (e.g. "ccr-settings-XXXX.json")
    And it contains a statusLine object of type "command"
    And `claude` is launched with "--settings <that file>"

  @AC8
  Scenario: No file under ~/.claude is modified
    Given a snapshot of "~/.claude" before launch
    When I run "ccr" and then the window closes
    Then no file under "~/.claude" has changed
    And credentials and CCS symlinks are untouched

  @AC8
  Scenario: The temp settings file is cleaned up after the window closes
    When I run "ccr" and the window closes
    Then the temp settings file is removed on a best-effort basis

  Scenario: Inline command form resolves node and ccr.js by path
    Given the launcher uses the inline statusLine form
    Then the command value is a quoted node path, the ccr.js path, and "statusline"
    And it embeds cleanly in the settings JSON with no shell-quoting hazards
