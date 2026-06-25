# Tool: fallbackNoWt()  in src/launch-win.js
# Spec: §2 (rejected: two windows kept as fallback), §5.1, §6  |  Acceptance: §8.7
# When Windows Terminal is absent, `ccr` must degrade gracefully — guidance, not a
# crash or stack trace.

Feature: Graceful fallback when Windows Terminal is absent
  As a Windows user without Windows Terminal
  I want `ccr` to guide me to the working native commands
  So that I never hit a dead end or a stack trace

  Background:
    Given the platform is win32
    And `wt.exe` is not resolvable on PATH

  @AC7
  Scenario: Bare `ccr` prints native-CLI guidance and exits non-zero
    When I run "ccr"
    Then it prints guidance pointing to the working native commands
    And the guidance mentions `ccr economy`, `ccr statusline`, and `ccr doctor`
    And it suggests installing Windows Terminal (winget) to get the sidecar
    And the process exits non-zero

  @AC7
  Scenario: The fallback never crashes
    When I run "ccr"
    Then no unhandled exception is raised
    And no stack trace is printed
