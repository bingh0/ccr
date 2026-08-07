# Tool: `ccr` (every launcher) — which state dir and session name a BARE launch
# gets. Implementation: src/instance-slot.js. Consumers: bin/ccr.js,
# src/launch-win.js, src/launch-vscode.js — and, through CCR_SESSION /
# CCR_STATE_DIR, scripts/launch.sh.
#
# Reported by a macOS beta tester running plain Claude Code (no CCS): two ccr
# instances could not be up at once. Bare `ccr` hardcoded session "ccr", tmux
# socket "ccr" and state dir ~/.ccr, so a second launch (1) ran the launcher's
# "clean re-launch" kill-session against the FIRST instance, (2) shared its
# snapshot and `exited` sentinel, and (3) took its sidebar's heartbeat away.
# Naming a CCS profile namespaced all three — but that requires CCS. Slots give a
# bare `ccr` the same isolation with no name to type.

Feature: A second terminal can just run ccr
  As someone running plain Claude Code in two terminals
  I want the second `ccr` to get its own sidebar and state
  So that starting one session never disturbs the other

  # --- The lone-instance case ---

  Scenario: The only instance takes slot 1
    # Slot 1 keeps the historical SESSION name — `tmux -L ccr attach` still
    # works for a lone instance — but its state dir is a member of the
    # instances container like every slot's: under the 0.4.0 layout ~/.ccr
    # itself is a container, never a state dir. (Text updated at build, as
    # sanctioned in features/OUT-OF-SCOPE.md.)
    Given no ccr instance is running
    When a bare ccr picks its namespace
    Then it takes slot 1
    And its state dir is the slot 1 directory
    And its session name is "ccr"

  # --- The reported bug ---

  Scenario: A second instance launched alongside the first gets its own namespace
    Given a live session holds slot 1
    When a bare ccr picks its namespace
    Then it takes slot 2
    And its state dir is the slot 2 directory
    And its session name is "ccr-2"

  Scenario: A third instance steps past both
    Given a live session holds slot 1
    And a live session holds slot 2
    When a bare ccr picks its namespace
    Then it takes slot 3

  # --- Freeing a slot: slots are reused, never minted ---

  Scenario: An attached sidebar whose session ended does not hold its slot
    # The VS Code sidebar deliberately outlives its session — it stays attached
    # and picks the next one up rather than making the user split a new pane. So
    # "a sidecar is beating here" must NOT mean "occupied": relaunching in that
    # same terminal has to land back on the same state dir, or the attached pane
    # is stranded watching a slot nobody will use again.
    Given a sidebar is attached to slot 1 but its session has ended
    When a bare ccr picks its namespace
    Then it takes slot 1

  Scenario: Closing the sidebar does not hand a running session's slot away
    # The heartbeat tracks the SIDEBAR, not the session. An earlier draft asked
    # only that question, so closing or crashing the sidebar pane freed the slot
    # out from under a live Claude — and the next bare `ccr`, landing on the same
    # session name, had launch.sh kill-session it. That is the reported bug,
    # re-armed. The launcher process is what actually spans the session.
    Given a live session holds slot 1
    And its sidebar has been closed
    When a bare ccr picks its namespace
    Then it takes slot 2

  Scenario: A detached session still holds its slot
    # Detaching from tmux ends the launcher but not the session, so here the
    # sidebar's heartbeat is the signal that survives.
    Given slot 1 has a beating sidebar and no launcher
    When a bare ccr picks its namespace
    Then it takes slot 2

  Scenario: A slot whose instance is entirely gone is free again
    Given slot 1 was left by an instance that is no longer running
    When a bare ccr picks its namespace
    Then it takes slot 1

  Scenario: A launch still starting up holds its slot before any sidebar exists
    # Ownership begins the instant the slot is taken, so there is no window in
    # which a starting instance looks free to the next launcher.
    Given another launcher holds slot 1 and its sidebar has not started
    When a bare ccr picks its namespace
    Then it takes slot 2

  # --- Racing launchers ---

  Scenario: Two launchers racing for the same free slot cannot both win it
    Given no ccr instance is running
    When two launchers pick a namespace against the same free slot
    Then they take different slots
    And one of them takes slot 1

  Scenario: Two launchers reusing the same ended session's slot cannot both win it
    # An earlier draft took an ATTACHED slot without reserving it at all. Because
    # the `exited` sentinel outlives every normal session — launch.sh writes it on
    # exit and only the NEXT launch clears it — two launchers starting together
    # both read "attached" and both took slot 1, and one kill-sessioned the other.
    # Reuse has to go through the same exclusive reservation as a free slot.
    Given a sidebar is attached to slot 1 but its session has ended
    When two launchers pick a namespace against the same free slot
    Then they take different slots
    And one of them takes slot 1

  Scenario: Reusing an attached sidebar never disturbs it
    # Its heartbeat is mid-beat. Writing a newer nonce over it is exactly what
    # makes a sidebar stand down, so reusing that slot must leave the file alone.
    Given a sidebar is attached to slot 1 but its session has ended
    When a bare ccr picks its namespace
    Then it takes slot 1
    And the attached sidebar's heartbeat is untouched
    And the caller is told a sidebar is already attached

  # --- Slots must not collide with things that are not slots ---

  # (The "slot number that is also a CCS profile name" scenario is gone with
  # the profiles-removal ruling: profile launches slot like any other, so
  # `ccr 2` no longer names a distinct namespace a slot could collide with.)

  @security
  Scenario: A slot directory that is not a real directory is skipped
    # ccr picks these paths with no user input, and everything under ~/.ccr is
    # writable by anything running as the user. mkdir succeeds on a symlink to a
    # directory and chmod follows it, so using one would chmod 0700 someone
    # else's directory and redirect the whole instance's state into it.
    Given a live session holds slot 1
    And slot 2's directory has been replaced with a symlink
    When a bare ccr picks its namespace
    Then it takes slot 3
    And the symlink's target is untouched

  # --- An explicit choice always outranks an automatic one ---

  Scenario: Naming a CCS profile takes a slot like any launch
    # Ruled 2026-08-06 (profiles-removal): the old per-profile namespace let
    # two launches of the SAME profile kill-session each other — the reported
    # bug on a second path. Every launch slots.
    Given a live session holds slot 1
    When ccr picks its namespace for CCS profile "c1"
    Then it takes slot 2

  Scenario: An explicit state dir assigns no slot
    Given a live session holds slot 1
    And CCR_STATE_DIR names a directory of the user's choosing
    When a bare ccr picks its namespace
    Then no slot is assigned

  Scenario: An explicit session name assigns no slot
    Given a live session holds slot 1
    And CCR_SESSION names a session of the user's choosing
    When a bare ccr picks its namespace
    Then no slot is assigned

  # --- Bounds ---

  Scenario: With every slot busy the launch is refused
    # Ruled 2026-08-06: the old fallback target (the shared container) WAS the
    # reported bug, so refusal replaces it — and it takes 32 live instances to
    # ever see this.
    Given every slot is held by a live session
    When a bare ccr picks its namespace
    Then the launch is refused

  # --- How the slot reaches the launchers ---

  Scenario: The tmux launcher needs no knowledge of slots
    # The launcher already derived all three of its namespaces from these two
    # variables, so handing it a slot is enough — no new flag, no new argument.
    Given the tmux launcher script scripts/launch.sh
    When it resolves a bare launch
    Then it takes the session name from CCR_SESSION
    And it takes the state dir from CCR_STATE_DIR
    And the tmux socket name follows the session name

  # --- Account-wide meters across slots ---

  Scenario: Slot 1 catches up to a busier slot on the same account
    # The 5h/weekly walls are one account resource. Reconciliation engages for
    # the launcher's layout under ~/.ccr/instances. (Before the container
    # split, slot 1 WAS ~/.ccr itself, had no parent to scan, and was the one
    # instance that never caught up — precisely when a second instance was
    # burning the same account.)
    Given slot 1 last captured 5h at 15%
    And slot 2 on the same account shows 5h at 16%
    When slot 1's meters are reconciled from disk
    Then slot 1's 5h meter reads 16%
