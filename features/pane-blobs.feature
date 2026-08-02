# Tool: ccr sidecar — external tool panes rendered from pane blobs
# Contract: docs/PANE-CONTRACT.md (v1)  |  Golden fixture: docs/pane-blob.golden.json
# ccr reads a blob FILE listed in user config, VALIDATES it against the contract,
# and renders a full-height pane. The whole acquisition path is "safely read bytes
# from a configured path": no subprocess, no database, no producer code, no
# knowledge of the producing tool. Blob strings are UNTRUSTED display data —
# stripped of control bytes before any render (the src/sanitize.js invariant
# transcripts already pin). Honesty rules flow through: dark survives distinctly,
# broken confesses, age is always shown, error states recover, and a configured
# pane never silently disappears from the cycle.
#
# @security marks the scenarios that hold the trust boundary rather than the
# look of the pane. They are gate-mandatory: once their steps land they must
# bind and pass even while the rest of this feature sits in `wip`
# (test/features.test.js), and they may never carry @skip or @todo. The gate
# (test/security-tags.test.js) lands together with the step bindings — a gate
# that `wip` can switch off is not a gate, so it is written to ignore `wip`.
# The T2 invariants — the sidecar's module graph importing no child_process and
# no network builtin, and never reading stdin — are structural rather than
# behavioural, and are pinned in test/sidecar-capabilities.test.js.

Feature: External tool panes from pane blobs
  As a user running agent tooling beside a Claude session
  I want the sidecar to render other tools' status blobs as first-class panes
  So that one glance covers my burn rate and my tools' health without coupling them

  Background:
    Given a pane blob path listed in the sidecar configuration

  # --- Discovery: configuration, never convention ---

  @security
  Scenario: A pane exists only because configuration names its blob path
    Given no other blob paths are configured
    When the sidecar starts
    Then exactly one external pane joins the view cycle
    And the sidecar reads no path it was not given

  @security
  Scenario: Acquisition is safely reading the configured file and nothing else
    Given a valid v1 blob at the configured path
    When the pane renders
    Then the sidecar's only filesystem access for that pane is the configured path
    And the sidecar has spawned no process and opened no database for it

  # --- Rendering a healthy blob ---

  Scenario: The golden fixture renders with every row and its chrome
    Given the golden fixture blob at the configured path
    When the pane renders
    Then the pane shows the title "trace" and the tool "gherkin-trace"
    And all seven rows render in blob order
    And the row "attention" shows "3" with the alert light

  Scenario: Every pane shows its basis verbatim and its write age from the file
    Given a valid v1 blob whose basis reads "refresh" at "2026-08-01 14:10"
    And the blob file was written 3 minutes ago
    When the pane renders
    Then the pane chrome shows "refresh" and "2026-08-01 14:10" unparsed
    And the pane chrome shows "blob written 3m ago"

  Scenario Outline: Write age renders on the unit ladder
    Given a valid v1 blob whose file was written <elapsed> ago
    When the pane renders
    Then the pane chrome shows "blob written <shown> ago"

    Examples:
      | elapsed    | shown |
      | 20 seconds | 20s   |
      | 3 hours    | 3h    |
      | 2 days     | 2d    |

  Scenario: A sparkline renders from a row's own values
    Given a valid v1 blob with a row carrying spark values 2, 5, 3, and 8
    When the pane renders
    Then the row shows a four-glyph sparkline whose tallest glyph is the 8

  Scenario: An empty rows array is a named empty body, not a misrender
    Given a valid v1 blob whose rows array is empty
    When the pane renders
    Then the pane shows a named no-rows body
    And the title, basis, and age chrome render intact

  # --- The status vocabulary: five renders, all distinct where it matters ---

  Scenario: Dark and off in one blob render differently, and dark is never quiet
    Given a valid v1 blob with a row "binding" at status "dark" and a row "extras" at status "off"
    When the pane renders
    Then the row "binding" shows the dark marker
    And the row "extras" shows the dim off render
    And the two renders are visibly different from each other and from the green light

  Scenario: An unrecognized row status renders as dark, never green, never dropped
    Given a valid v1 blob with a row whose status reads "okay"
    When the pane renders
    Then that row renders with the dark marker
    And the row is not dropped and shows no green light

  # --- Untrusted strings: blob bytes never become terminal control ---

  @security
  Scenario: Control bytes in blob strings render as inert text
    Given a v1 blob whose title, labels, values, details, and message embed escape and control bytes
    When the pane renders
    Then every rendered field shows the text with control bytes stripped
    And the terminal receives no escape sequence originating from blob content
    And the clipboard, window title, and pane chrome are untouched by the blob

  @security
  Scenario: An overlong field is clamped to its cell, never costing the pane
    Given a valid v1 blob with a detail of four hundred lines
    When the pane renders
    Then the detail renders clamped to its single-line cell
    And the basis and age chrome remain visible
    And the pane does not fall back to an error state

  # --- The verifier: one choke point, one named failure ---

  @security
  Scenario: A blob missing a required field is the named invalid state
    Given a blob at the configured path that parses as JSON but carries no basis
    When the pane renders
    Then the pane shows an invalid state naming the configured path
    And no byte of the file's content appears in the pane
    And the invalid state is visibly distinct from the unreadable and waiting states

  @security
  Scenario: A broken blob with no message is invalid, never a silent healthy render
    Given a blob with status "broken" whose message is absent
    When the pane renders
    Then the pane shows the invalid state
    And no rows from that blob are rendered

  @security
  Scenario: A blob carrying a prototype key cannot reach the rendered object
    Given a valid v1 blob that also carries a "__proto__" key at the top level and in a row
    When the pane renders
    Then the pane renders exactly as it does for the same blob without those keys
    And no property of any shared prototype has been altered

  @security
  Scenario: A malformed blob costs a pane state, never the sidecar
    Given the file at the configured path is malformed in a way that fails validation
    When the sidecar ticks three times
    Then all three ticks complete on schedule
    And the economy view still renders in the cycle

  Scenario: A non-finite spark value drops the sparkline, not the row
    Given a valid v1 blob with a row whose spark carries a value that parses to infinity
    When the pane renders
    Then that row renders without a sparkline
    And the row's label, value, and status render normally

  # --- Forward compatibility ---

  Scenario: Unknown fields in a v1 blob change nothing
    Given the golden fixture blob carrying extra unrecognized fields at the top level and in a row
    When the pane renders
    Then the pane renders exactly as it does for the golden fixture alone

  # --- Honesty states: broken, missing, unreadable, unsupported, cannot-read ---

  Scenario: A broken blob renders its producer's failure, not stale health
    Given a v1 blob with status "broken" and the message "refresh failed partway"
    When the pane renders
    Then the pane shows a failure state carrying "refresh failed partway" with the basis chrome
    And any rows in the broken blob are ignored
    And no rows from any earlier healthy blob are shown

  Scenario: A configured pane with no blob yet is a named waiting state
    Given no file exists at the configured path
    When the pane renders
    Then the pane shows a waiting state naming the configured path
    And the pane is not skipped from the view cycle

  @security
  Scenario: An unreadable blob is a named state that shows no file content
    Given the file at the configured path is not parseable JSON this tick
    When the pane renders
    Then the pane shows an unreadable state naming the path
    And no byte of the file's content appears in the pane

  @security
  Scenario: A blob that cannot be read is distinct from one not yet written
    Given the configured path exists but cannot be read as a regular file
    When the pane renders
    Then the pane shows a cannot-read state naming the path and the reason class
    And the state is visibly distinct from the waiting state

  @security
  Scenario: A special file at the blob path never blocks the loop
    Given the configured path is a pipe that never yields bytes
    When the sidecar ticks three times
    Then all three ticks complete on schedule
    And the pane shows the cannot-read state

  @security
  Scenario: A symlink at the blob path is refused, never followed
    Given the configured path is a symlink pointing at another file
    When the pane renders
    Then the pane shows the cannot-read state naming the path
    And the sidecar never opens the symlink's target

  @security
  Scenario: An oversized blob is refused by name
    Given a blob file larger than the size cap
    When the pane renders
    Then the pane shows an oversized state naming the path
    And the file's content is not rendered

  Scenario: An unsupported blob version is named, never misrendered
    Given a blob whose version field reads 99
    When the pane renders
    Then the pane shows an unsupported-version state naming version 99
    And no rows from that blob are rendered

  Scenario: Error states recover the moment the blob becomes valid
    Given the pane showed the unreadable state last tick
    And the file at the configured path is now a valid v1 blob
    When the next tick renders
    Then the pane shows the healthy view
    And no trace of the error state remains

  Scenario: The waiting state yields to the first blob without user input
    Given the pane showed the waiting state last tick
    And a valid v1 blob has now appeared at the configured path
    When the next tick renders
    Then the pane shows the healthy view

  # --- Hotkeys: a host capability, defined by ccr's code, never by a pane ---

  Scenario: A host hotkey types text defined by ccr's code, not by configuration
    Given the tmux host binds ccr's clear hotkey
    And the configuration names which key it is but supplies no text
    When the key is pressed and confirmed
    Then the text typed into the Claude pane is the constant from ccr's source
    And no word of it is interpreted as a key name
    And exactly one submit follows

  @security
  Scenario: Keystrokes target the captured Claude pane id, not an index
    Given the Claude pane's id was captured at launch
    And the panes have since been rearranged
    When a host hotkey is pressed and confirmed
    Then the text is typed into the originally captured Claude pane
    And no other pane receives any keystroke

  @security
  Scenario: A vanished Claude pane makes the key do nothing, not retarget
    Given the captured Claude pane no longer exists
    When a host hotkey is pressed
    Then nothing is typed anywhere

  @security
  Scenario: A destructive hotkey requires confirmation
    Given the tmux host binds ccr's clear hotkey
    When the key is pressed once
    Then nothing is typed and a confirmation prompt appears
    When the confirmation is declined
    Then nothing is typed into the Claude pane

  @security
  Scenario: A host with no captured pane id has no hotkeys at all
    Given a host where no Claude pane id was captured at launch
    When the session comes up
    Then no hotkey is bound
    And no approximate target is substituted for the captured pane id

  @security
  Scenario: Blob content can never propose, label, or bind a hotkey
    Given a valid v1 blob that also carries an action-like field naming a key and a command
    When the pane renders and every bound key is pressed
    Then the blob's action-like field is ignored and displayed nowhere
    And the pane shows no label claiming a key exists
    And nothing from the blob is ever typed into the Claude pane

  # --- The pane surface: full-height views, cycled ---

  Scenario: External panes join the style cycle in config order with a position indicator
    Given a second pane blob path listed after the first in the sidecar configuration
    And the sidecar offers its own economy view
    When the user cycles the sidecar style
    Then each external pane appears as a whole-pane view in configuration order
    And the chrome shows the pane's position in the cycle
    And no view is truncated to stack beside another

  Scenario: Row overflow collapses honestly inside a pane
    Given a valid v1 blob with more rows than the pane has lines, one hidden row being dark
    When the pane renders
    Then the visible rows are followed by a final line stating how many more rows exist
    And that line carries the dark marker, the worst status among the hidden rows
