# Design tier: the contract of scripts/history-privacy.js — which commits a release
# would newly publish, and which strings in them count as a disclosure. This is
# release-process machinery, not product behavior: outside the visionary's
# review contract, see git-index-format.feature's header for the tier's rules.
#
# The far side is real git: test/history-privacy.test.js holds this scanner to
# the same answer `git grep` gives over `git rev-list published..tip`, on this
# repository's own history.

Feature: What a release would newly publish
  As the release gate
  I want the unpublished commits read out of the object store
  So that a scrubbed tip cannot vouch for the history behind it

  Scenario: A private string reachable only from an unpublished commit is a finding
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds "notes.md" saying "mail me at real.person@corp.example.io"
    When the unpublished history is scanned
    Then the scan refuses, naming "real.person@corp.example.io"

  Scenario: A string the published tree already contains is not a new disclosure
    Given a published commit whose tree holds "docs.md" saying "contact real.person@corp.example.io"
    And an unpublished commit whose tree holds "notes.md" saying "contact real.person@corp.example.io"
    When the unpublished history is scanned
    Then the scan is clean

  Scenario: Commits already published are not scanned
    Given a published commit whose tree holds "docs.md" saying "mail me at real.person@corp.example.io"
    And an unpublished commit whose tree holds "notes.md" saying "nothing to see"
    When the unpublished history is scanned
    Then the scan is clean

  # The gate prints the commits an operator would have to accept. Naming only
  # the first one that reaches a blob would invite accepting that one and
  # publishing the rest — this repository's own 0.4.0 history carried the same
  # blob through fourteen commits.
  Scenario: Every commit carrying the string is named, not just the first
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And a chain of 3 unpublished commits each carrying "notes.md" saying "mail me at real.person@corp.example.io"
    When the unpublished history is scanned
    Then the scan refuses, naming 3 commits

  Scenario: A noreply alias is not a finding
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds "notes.md" saying "by someone@users.noreply.github.com"
    When the unpublished history is scanned
    Then the scan is clean

  Scenario: A home path naming a real account is a finding
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds "notes.md" saying "logs in /home/jrivera/scratch"
    When the unpublished history is scanned
    Then the scan refuses, naming "/home/jrivera"

  Scenario: A home path naming a placeholder is not a finding
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds "notes.md" saying "put it in /home/user/somewhere"
    When the unpublished history is scanned
    Then the scan is clean

  # The supplement carries lineage names that must never appear anywhere. The
  # baseline argument does not apply to them: already having leaked one is not
  # a reason to leak it again.
  Scenario: A private pattern fires even where the published tree already matches
    Given the private pattern "widgetworks"
    And a published commit whose tree holds "docs.md" saying "built on widgetworks"
    And an unpublished commit whose tree holds "notes.md" saying "built on widgetworks"
    When the unpublished history is scanned
    Then the scan refuses, naming 1 commits

  Scenario: A binary blob is not searched
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds a binary "logo.png" containing "real.person@corp.example.io"
    When the unpublished history is scanned
    Then the scan is clean

  Scenario: Nothing unpublished is clean without reading anything
    Given a published commit whose tree holds "docs.md" saying "mail me at real.person@corp.example.io"
    When the tip and the published commit are the same
    Then the scan is clean
    And no commits were scanned

  Scenario: An unreadable object store reaches no conclusion
    Given a published commit whose tree holds "docs.md" saying "nothing to see"
    And an unpublished commit whose tree holds "notes.md" saying "nothing to see"
    But the unpublished commit object is removed
    When the unpublished history is scanned
    Then the scan is unavailable
