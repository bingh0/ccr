# Tool: ccr sidecar — reaching a view when the host binds no key.
# DRAFT, 2026-08-05: written from a build ruling rather than a /scope interview,
# and awaiting the visionary's review of the text. The behaviour is built and
# these steps bind.
#
# Under tmux the launcher binds F3 and tmux runs `ccr cycle-view`; the sidecar
# never sees a key. VS Code and its forks bind nothing, and their split leaves
# both panes running a foreground process — Claude in one, the panel in the
# other — so there is not even a free shell prompt to type the command into.
# Before the git pane that cost nothing, because a user with no configured panes
# had a one-view cycle. Now every instance has two built-in views.
#
# The answer keeps the renderer's trust boundary exactly where it was: the key
# reader is a SEPARATE PROCESS that owns the terminal's input and runs the panel
# as a child with its stdin closed. That is tmux's own separation with ccr
# standing in for the host, and it is pinned structurally rather than by prose in
# test/sidecar-capabilities.test.js.

Feature: Reaching every view on a host that binds no key
  As someone running the sidebar in VS Code, Cursor, Positron or Antigravity
  I want a key in the sidecar's own pane
  So that the views I have are ones I can actually get to

  Scenario: A key press asks the sidebar to advance
    Given the sidecar is started with a key reader
    When the cycle key is pressed
    Then the sidebar is asked to advance 1 view

  Scenario: A burst of presses is never collapsed
    Given the sidecar is started with a key reader
    When the cycle key is pressed 3 times in one burst
    Then the sidebar is asked to advance 3 views

  Scenario: A key the sidebar does not own is ignored
    Given the sidecar is started with a key reader
    When the key "x" is pressed
    Then the sidebar is not asked to advance

  # The whole reason this is a second process: the panel renders text a producer
  # wrote, and a renderer that can read the terminal is a renderer whose input
  # channel has to be filtered rather than being absent.
  Scenario: The panel never receives the terminal's input
    Given the sidecar is started with a key reader
    Then the panel was started with its input closed

  Scenario: Interrupting closes the panel and hands the terminal back
    Given the sidecar is started with a key reader
    When the interrupt key is pressed
    Then the panel is asked to stop
    And the terminal is taken out of raw mode

  # A terminal left in raw mode outlives ccr: the user's shell stops echoing and
  # stops handling Ctrl-C. It must be handed back on every exit, not just the
  # one the user chose.
  Scenario: The terminal is handed back when the panel exits by itself
    Given the sidecar is started with a key reader
    When the panel exits with code 0
    Then the terminal is taken out of raw mode
    And the key reader exits with code 0

  Scenario: The terminal is handed back when the panel cannot start at all
    Given the sidecar is started with a key reader
    When the panel fails to start
    Then the terminal is taken out of raw mode

  Scenario: Somewhere with no terminal, the panel still runs
    Given stdin is not a terminal
    When the sidecar is started with a key reader
    Then the panel is started
    And raw mode is never asked for

  Scenario Outline: The panel opens on the view it was asked for
    Given the sidecar is asked to open on view <view>
    When it draws its first frame
    Then the frame is drawn for view <view>

    Examples:
      | view |
      | 0    |
      | 1    |

  Scenario: A view index that is not one is refused rather than guessed
    When ccr is run with "sidecar --view banana"
    Then it exits with code 2
    And stderr names the view flag
    And no panel is started
