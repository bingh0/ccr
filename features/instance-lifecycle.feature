# Tool: `ccr` — how an instance is born, how it dies, and what its death may
# touch. Scoped 2026-08-06 via /scope (instance layout interview). NOT YET
# BUILT: registered in test/wip-register.js until its steps bind.
#
# The layout this file assumes is 0.4.0's: ~/.ccr is a container; every
# instance lives under ~/.ccr/instances/<slot>. Instances are EPHEMERAL —
# literally deleted after exiting. The ruling that shapes the deletion
# scenarios: deletion needs a DEAD PROCESS, never a quiet heartbeat. The
# 5-second heartbeat window answers "should a duplicate sidecar stand down",
# a question whose wrong answer costs a redraw; deletion's wrong answer costs
# a running session's state. Two decisions, opposite costs, two thresholds.

Feature: An instance lives exactly as long as its session
  As someone running several ccr sessions at once
  I want each instance created at launch and gone after its session ends
  So that state never piles up and never outlives the session it described

  Scenario: A new instance's state lives under the instances container
    Given no ccr instance is running
    When a bare ccr launches
    Then the instance's state dir is "instances/1" under the ccr home
    And that directory is owner-only

  Scenario: A profile launch is an ephemeral instance like any other
    # Ruled 2026-08-06: there is no profiles/ tree. The profile selects the
    # ccs account, prefixes the title, and is recorded in the join key —
    # everything else about the launch is ordinary instance lifecycle.
    Given no ccr instance is running
    When ccr launches with CCS profile "cq"
    Then it takes slot 1
    And the instance's state dir is "instances/1" under the ccr home

  Scenario: Two launches of the same profile coexist
    # The reported kill-session destruction was still shipping for the
    # profile path: both launches got session "ccr-cq", and the second's
    # clean re-launch killed the first. Slots for every launch end it.
    Given a live instance of CCS profile "cq" holds slot 1
    When ccr launches with CCS profile "cq"
    Then it takes slot 2
    And the slot 1 instance is still live

  Scenario: Exiting politely deletes the instance
    Given a live instance named "gitrepo" on slot 1
    When its session ends
    Then the slot 1 instance directory is gone
    And the account's burn history is still present

  Scenario: A killed session's instance is swept at the next launch
    Given slot 2 holds an instance whose recorded process no longer exists
    When a bare ccr launches
    Then the slot 2 instance directory is gone

  Scenario: A quiet heartbeat alone never triggers deletion
    # A laptop suspend, a heavy test run, or Ctrl-Z all silence the heartbeat
    # for far longer than its display window while the session is alive. The
    # failing world for this Then is an mtime-based sweeper: it deletes a
    # running session's state dir here.
    Given a live instance on slot 1 whose heartbeat is 20 minutes stale
    And its recorded process still exists
    When a bare ccr launches
    Then the slot 1 instance directory is untouched

  Scenario: The thirty-second instance still gets a slot
    Given 31 live instances hold slots 1 through 31
    When a bare ccr launches
    Then it takes slot 32

  Scenario: A thirty-third instance is refused
    # 32 is not arbitrary: the account meter merge caps sibling reconciliation
    # at 32 profiles, so a larger live set would silently under-report the
    # shared 5h and weekly meters. The cap keeps the shipped guarantee true.
    # Ruled 2026-08-06: refusal replaces the old fall-back to the shared
    # ~/.ccr — that path is a container now, and the old worst case WAS the
    # reported bug.
    Given 32 live instances hold slots 1 through 32
    When a bare ccr launches
    Then the launch fails
    And the error says every slot is in use

  Scenario: Two instances keep their own panels while sharing the account meters
    # Both halves are load-bearing. The first Then fails if slot resolution
    # leaks one instance's snapshot into another — the defect this release
    # fixes. The second fails if reconciliation broke — asserting full
    # isolation would forbid a shipped feature.
    Given instance "a" on slot 1 has context at 40% and cost $1.00
    And instance "b" on slot 2 on the same account has burned the 5h window to 30%
    When instance "a" redraws its sidebar
    Then a's sidebar shows context at 40% and cost $1.00
    And a's 5h meter reads 30%

  Scenario: Launching modifies no configuration file
    # This is the adjacent guarantee that keeps shared MCP tooling working:
    # the status line is passed per-launch, so CCS symlinks, shared settings
    # and credentials are never edited.
    Given a user settings file with known contents
    When a bare ccr launches
    Then the settings file's contents are unchanged
    And the launched session is still handed the ccr status line

  Scenario: doctor finds a live instance's captured status
    # The one survival hole the existing corpus has: doctor scans the old
    # layout's depth, and its only nearby assertion matches "status captured"
    # and "no status captured" alike. This Then fails in a world where doctor
    # still scans ~/.ccr one level deep while instances live two levels down.
    Given a live instance on slot 2 has captured a status
    When ccr doctor runs
    Then doctor reports a captured status from slot 2's instance
