# Tool: ccr sidecar — external tool panes rendered from pane blobs
# Contract: docs/PANE-CONTRACT.md (v1)  |  Golden fixture: docs/pane-blob.golden.json
# Prior art: treecontext-mcp wrapper (blob-and-renderer seam, pager, F2/F3)
# ccr reads a blob FILE listed in user config and renders a full-height pane.
# The whole acquisition path is "safely read bytes from a configured path":
# no subprocess, no database, no knowledge of the producing tool. Blob strings
# are UNTRUSTED display data — stripped of control bytes before any render
# (the src/sanitize.js invariant transcripts already pin). Honesty rules flow
# through: dark survives distinctly, broken confesses, age is always shown,
# error states recover, and a configured pane never silently disappears.

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

  Scenario: Control bytes in blob strings render as inert text
    Given a v1 blob whose title, labels, values, details, and message embed escape and control bytes
    When the pane renders
    Then every rendered field shows the text with control bytes stripped
    And the terminal receives no escape sequence originating from blob content
    And the clipboard, window title, and pane chrome are untouched by the blob

  Scenario: An overlong field is clamped to its cell, chrome intact
    Given a valid v1 blob with a detail of four hundred lines
    When the pane renders
    Then the detail renders clamped to its single-line cell
    And the basis and age chrome remain visible

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

  Scenario: An unreadable blob is a named state that shows no file content
    Given the file at the configured path is not parseable JSON this tick
    When the pane renders
    Then the pane shows an unreadable state naming the path
    And no byte of the file's content appears in the pane

  Scenario: A blob that cannot be read is distinct from one not yet written
    Given the configured path exists but cannot be read as a regular file
    When the pane renders
    Then the pane shows a cannot-read state naming the path and the reason class
    And the state is visibly distinct from the waiting state

  Scenario: A special file at the blob path never blocks the loop
    Given the configured path is a pipe that never yields bytes
    When the sidecar ticks three times
    Then all three ticks complete on schedule
    And the pane shows the cannot-read state

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

  # --- Action keys: host-configured, never blob-driven ---

  Scenario: A configured action key types its text literally with one submit
    Given the sidecar configuration maps a key to a prompt file containing three lines
    When the key is pressed
    Then the three lines are typed into the Claude pane as one space-joined literal line
    And exactly one submit follows
    And no word of the prompt is interpreted as a key name

  Scenario: A prompt file that other principals can write is rejected at config load
    Given the sidecar configuration maps a key to a group-writable prompt file
    When the configuration loads
    Then the key binding is refused with a visible notice naming the file
    And pressing the key types nothing

  Scenario: A prompt file inside a blob directory or working tree is rejected
    Given the sidecar configuration maps a key to a prompt file under a configured blob's directory
    When the configuration loads
    Then the key binding is refused with a visible notice
    And pressing the key types nothing

  Scenario: Keystrokes target the captured Claude pane id, not an index
    Given the Claude pane's id was captured at launch
    And the panes have since been rearranged
    When a configured action key is pressed
    Then the text is typed into the originally captured Claude pane
    And no other pane receives any keystroke

  Scenario: A vanished Claude pane makes the key refuse, not retarget
    Given the captured Claude pane no longer exists
    When a configured action key is pressed
    Then nothing is typed anywhere
    And a visible notice says the Claude pane is gone

  Scenario: A destructive action key requires confirmation
    Given the sidecar configuration maps a key to the destructive text "/clear"
    When the key is pressed once
    Then nothing is typed and a confirmation prompt appears
    When the confirmation key is pressed
    Then the literal text "/clear" is typed into the Claude pane with one submit

  Scenario: Blob content can never cause input injection
    Given a valid v1 blob that also carries an action-like field naming a key and a command
    When the pane renders and every configured key is pressed
    Then the blob's action-like field is ignored and displayed nowhere
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
