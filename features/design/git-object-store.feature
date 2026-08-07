# Design tier: the byte-level contract of src/git-objects.js — loose objects,
# pack index v2, both delta forms, and the flattened HEAD tree. Outside the
# visionary's review contract; see git-index-format.feature's header for the
# tier's rules and its far side.

Feature: Reading the object store
  As the git pane
  I want commits and trees read from the object store itself
  So that a packed repository is as readable as a fresh one

  Scenario: A loose object is read back
    Given a loose blob "hello pane"
    When that object is read
    Then it comes back as a "blob" holding "hello pane"

  Scenario: A packed object is found through the pack index
    Given a pack holding a blob "packed content"
    When that object is read
    Then it comes back as a "blob" holding "packed content"

  Scenario: An ofs-delta entry is rebuilt against its base
    Given a pack whose blob "base text" has an ofs-delta extending it with " and more"
    When the delta's object is read
    Then it comes back as a "blob" holding "base text and more"

  Scenario: A ref-delta entry is rebuilt against its base
    Given a pack whose blob "base text" has a ref-delta extending it with " and more"
    When the delta's object is read
    Then it comes back as a "blob" holding "base text and more"

  Scenario: A missing object is an answer, not an error
    Given an empty object store
    When an absent id is read
    Then the read answers nothing

  Scenario: An object claiming to inflate beyond the cap is refused
    Given a loose object that inflates far past the object cap
    When that object is read
    Then the read answers nothing

  Scenario: An unborn branch has an empty committed tree
    Given a repository whose HEAD names a branch with no commits
    When the committed tree is read
    Then it holds 0 paths

  Scenario: HEAD's tree is flattened to full paths
    Given a repository whose HEAD commit holds "src/a.js" and "docs/guide.md"
    When the committed tree is read
    Then it holds 2 paths
    And it maps "src/a.js" to that file's blob id
