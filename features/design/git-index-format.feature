# Design tier: the byte-level contract of src/git-index.js. This directory is
# OUTSIDE the visionary's review contract (features/OUT-OF-SCOPE.md, "Deferred
# to the design tier") — the visionary reviews features/ and only features/;
# these criteria are the build holding itself to git's on-disk formats, run by
# test/design-features.test.js with its own wip register.
#
# The far side of every scenario here is test/git-working-tree.test.js, where
# the same parser reads index files REAL git wrote — so a fixture drifting
# from git's actual format cannot stay green from both directions.

Feature: Parsing the index file
  As the working-tree section
  I want the staging area read from git's own bytes
  So that what is staged never depends on a git binary being installed

  Scenario: A version 2 index yields its entries in order
    Given an index written at version 2 with the paths "a.txt" and "lib/b.txt"
    When the index is read
    Then 2 entries come back
    And entry 0 is "a.txt" at stage 0

  Scenario: A version 3 entry carrying extended flags is stepped over
    Given an index written at version 3 whose entry "a.txt" carries extended flags
    When the index is read
    Then 1 entries come back
    And entry 0 is "a.txt" at stage 0

  Scenario: A version 4 index reconstructs its compressed paths
    Given an index written at version 4 with the paths "src/deep/one.js" and "src/deep/two.js"
    When the index is read
    Then 2 entries come back
    And entry 1 is "src/deep/two.js" at stage 0

  Scenario: A conflicted path carries its three stages
    Given an index holding "clash.txt" at stages 1, 2 and 3
    When the index is read
    Then 3 entries come back
    And every entry is "clash.txt" with a distinct stage

  Scenario: A sha-256 repository's ids are read at their full width
    Given a sha-256 repository whose index holds "a.txt"
    When the index is read
    Then entry 0's id is 64 hex characters

  Scenario: A truncated index is refused rather than guessed at
    Given an index written at version 2 and then truncated mid-entry
    When the index is read
    Then the read refuses

  Scenario: An index whose entry count lies is refused
    Given an index claiming 40 entries but holding 1
    When the index is read
    Then the read refuses

  Scenario: A missing index reads as empty
    Given a git directory with no index file
    When the index is read
    Then 0 entries come back
