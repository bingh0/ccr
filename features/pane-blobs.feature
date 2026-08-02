# Tool: ccr sidecar — external tool panes rendered from pane blobs
# Contract: docs/PANE-CONTRACT.md (v1)  |  Prior art: treecontext-mcp wrapper
# ccr reads a blob FILE listed in user config and renders a full-height pane.
# The whole acquisition path is "read bytes from a configured path": no
# subprocess, no database, no knowledge of the producing tool. Honesty rules
# flow through: dark rows render as cannot-tell, broken blobs confess, age is
# always shown, and a configured pane never silently disappears.

Feature: External tool panes from pane blobs
  As a user running agent tooling beside a Claude session
  I want the sidecar to render other tools' status blobs as first-class panes
  So that one glance covers my burn rate and my tools' health without coupling them

  Background:
    Given a pane blob path listed in the sidecar configuration

  # --- Discovery: configuration, never convention ---

  Scenario: A pane exists only because configuration names its blob path
    Given no other blob paths are configured
    When the sidecar starts
    Then exactly one external pane joins the view cycle
    And the sidecar reads no path it was not given

  Scenario: Acquisition is reading the configured file and nothing else
    Given a valid v1 blob at the configured path
    When the pane renders
    Then the sidecar has read only the blob file for that pane
    And the sidecar has spawned no process and opened no database for it

  # --- Rendering a healthy blob ---

  Scenario: A v1 blob renders as a titled pane with traffic-lit rows
    Given a valid v1 blob titled "trace" with a row labeled "attention" valued "3" at status "alert"
    When the pane renders
    Then the pane shows the title "trace"
    And the row "attention" shows "3" with the alert light

  Scenario: Every pane shows its basis and its age
    Given a valid v1 blob whose basis reads "refresh" at "2026-08-01 14:10"
    And the blob file was written 3 minutes ago
    When the pane renders
    Then the pane chrome shows "refresh" and "2026-08-01 14:10"
    And the pane chrome shows an age of about 3 minutes

  Scenario: A dark row renders as cannot-tell, never as clear
    Given a valid v1 blob with a row labeled "binding" at status "dark"
    When the pane renders
    Then the row "binding" shows a distinct dark marker
    And the row "binding" shows neither the green light nor an empty slot

  Scenario: A sparkline renders when a row carries one
    Given a valid v1 blob with a row carrying spark values
    When the pane renders
    Then the row shows a sparkline drawn from those values

  # --- Honesty states: broken, missing, unreadable, unsupported ---

  Scenario: A broken blob renders its producer's failure, not stale health
    Given a v1 blob with status "broken" and the message "refresh failed partway"
    When the pane renders
    Then the pane shows a failure state carrying "refresh failed partway"
    And no rows from any earlier healthy blob are shown

  Scenario: A configured pane with no blob yet is a named waiting state
    Given no file exists at the configured path
    When the pane renders
    Then the pane shows a waiting state naming the configured path
    And the pane is not skipped from the view cycle

  Scenario: An unreadable blob is a named state that retries
    Given the file at the configured path is not parseable JSON this tick
    When the pane renders
    Then the pane shows an unreadable state naming the path
    And the next tick reads the file again

  Scenario: An unsupported blob version is named, never misrendered
    Given a blob whose version field reads 99
    When the pane renders
    Then the pane shows an unsupported-version state naming version 99
    And no rows from that blob are rendered

  # --- Action keys: host-configured, never blob-driven ---

  Scenario: A configured action key types its configured text into the Claude pane
    Given the sidecar configuration maps a key to the text "/clear"
    And the sidecar configuration maps another key to a prompt file
    When each key is pressed
    Then the literal text "/clear" is typed into the Claude pane for the first
    And the prompt file's contents are typed into the Claude pane for the second

  Scenario: Blob content can never cause input injection
    Given a valid v1 blob that also carries an action-like field naming a key and a command
    When the pane renders and every configured key is pressed
    Then the blob's action-like field is ignored
    And nothing from the blob is ever typed into the Claude pane

  # --- The pane surface: full-height views, cycled ---

  Scenario: External panes join the style cycle as full-height views
    Given a valid v1 blob at the configured path
    And the sidecar offers its own economy view
    When the user cycles the sidecar style
    Then the external pane appears as a whole-pane view in the cycle
    And no view is truncated to stack beside another
