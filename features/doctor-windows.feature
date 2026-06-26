# Tool: src/doctor.js  (Windows branch)
# Spec: §5.4  |  Acceptance: §8.1
# `ccr doctor` must report the real Windows setup — including a Windows Terminal
# check — and drop all "use WSL" language.

Feature: doctor Windows environment check
  As a Windows user verifying my setup
  I want `ccr doctor` to reflect the native Windows Terminal sidecar
  So that I can tell whether the sidecar will work

  Background:
    Given the platform is win32

  @AC1
  Scenario: doctor reports a healthy Windows setup
    Given Node 18.3+ is installed
    And `ccr` is on PATH
    And `wt.exe` is resolvable
    When I run "ccr doctor"
    Then it reports node OK
    And it reports ccr-on-PATH OK
    And it reports "✓ Windows Terminal (sidecar host)"
    And the output contains no "use WSL" / "WSL-only" language

  @AC1
  Scenario: doctor flags missing Windows Terminal without failing the CLI
    Given `wt.exe` is not resolvable
    When I run "ccr doctor"
    Then it warns that Windows Terminal was not found
    And it suggests "winget install Microsoft.WindowsTerminal"
    And it notes the CLI still works

  @AC1
  Scenario: doctor reports optional ccs and existing cross-platform checks
    When I run "ccr doctor"
    Then ccs presence is reported as optional
    And the capture-status check is reported
    And the executable-bit (0o111) check is skipped on Windows
