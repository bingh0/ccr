# Tool: `ccr` — moving existing users to the container layout. Scoped
# 2026-08-06 via /scope (instance layout interview); REDRAFTED same day under
# the profiles-removal ruling ("remove the unnecessary directories"). Steps
# bound in test/steps/instance-migration.steps.js.
#
# There is no profiles/ tree. The only persistent content the 0.3 profile
# dirs ever held was account burn history, misplaced there because the
# logger wrote to whatever the state dir was. Migration therefore HARVESTS:
# burnlogs move to the container's top level, the profile dirs and their
# ephemeral droppings (captured status, exited, sidecar-alive) are swept,
# and ".layout" is written LAST so an interrupted migration is
# indistinguishable from one that has not started. Migration runs AT LAUNCH
# ONLY — never from `ccr statusline`, which Claude invokes headlessly
# mid-session — refuses while any live instance exists, and STOPS AND
# CHANGES NOTHING when the source is not what it expects (which is also the
# whole handling of an entry named "instances": declined as real scope, the
# stop makes it fail loudly for free). Migration is removed at 1.0.0.

Feature: Moving existing users to the new layout
  As someone upgrading ccr from 0.3
  I want my burn history kept and the leftover clutter gone, once, safely
  So that nothing I had is lost and nothing half-moved is trusted

  Scenario: An old layout is migrated at launch
    Given a ccr home in the 0.3 layout holding profile dir "cq" with burnlog "burnlog-abc123.jsonl" and a captured status
    When a bare ccr launches
    Then "burnlog-abc123.jsonl" is at the container's top level
    And the profile dir "cq" is gone
    And the ".layout" marker is present
    And every directory the migration created is owner-only

  Scenario: Loose droppings at the container root are swept by migration
    # 0.3's bare launches used ~/.ccr itself as their state dir, so the root
    # holds a dead instance's captured status and sentinel beside the burn
    # history that must survive.
    Given a ccr home in the 0.3 layout holding a loose captured status and burnlog "burnlog-def456.jsonl"
    When a bare ccr launches
    Then the loose captured status is gone
    And "burnlog-def456.jsonl" is still at the container's top level

  Scenario: A migrated home is not migrated again
    # The failing world: a launch that ignores the marker re-runs the
    # harvest against the new layout's own entries.
    Given a migrated ccr home whose ".layout" marker is present
    And burnlog "burnlog-abc123.jsonl" is at the container's top level
    When a bare ccr launches
    Then "burnlog-abc123.jsonl" is still at the container's top level
    And no container entry has moved

  Scenario: Migration refuses while an instance is live
    Given a ccr home in the 0.3 layout
    And a live 0.3 instance is running
    When a bare ccr launches
    Then the launch fails
    And the error names the live instance to close first

  Scenario: An interrupted migration is completed by the next launch
    # ".layout" is written last and the harvest is move-if-present, so a
    # crash mid-migration leaves a resumable state, never a half-trusted one.
    Given a migration that was interrupted before writing the ".layout" marker
    And profile dir "cq" still holds burnlog "burnlog-abc123.jsonl"
    When a bare ccr launches
    Then "burnlog-abc123.jsonl" is at the container's top level
    And the profile dir "cq" is gone
    And the ".layout" marker is present

  Scenario: An unexpected entry stops the migration untouched
    Given a ccr home in the 0.3 layout with an unrecognized entry named "instances"
    When a bare ccr launches
    Then no file or directory has moved
    And the launch fails naming "instances"

  Scenario: A session file the new statusline already wrote does not stop migration
    # Upgrading while a session is open leaves the 0.4 statusline ticking
    # against a still-unmigrated home: it writes the session join key to the
    # container root before any launch has run migration. That file is ccr's
    # own, already at its final location — kept in place, never a surprise.
    Given a ccr home in the 0.3 layout where a 0.4 statusline already wrote session file "session-abc123.jsonl"
    When a bare ccr launches
    Then "session-abc123.jsonl" is still at the container's top level
    And the ".layout" marker is present

  Scenario: ccr statusline never migrates
    Given a ccr home in the 0.3 layout
    When ccr statusline runs
    Then no file or directory has moved

  Scenario: A 0.3 session's leftovers are swept after re-upgrade
    # A downgrade-then-re-upgrade merges the day's burn history for free —
    # 0.3 already wrote burnlogs where the pool now is. What 0.3 also leaves
    # is a loose captured status and heartbeat from a session now over: a
    # dead instance's live state, which the ephemeral rule says dies.
    Given a migrated ccr home where a 0.3 ccr later wrote a loose captured status and heartbeat
    And that 0.3 session has ended
    When a bare ccr launches
    Then the loose captured status and heartbeat are gone
    And that 0.3 session's burnlog is still present
