# Acceptance criteria for the live tool/skills feed (src/render/feed.js). Steps
# drive the real renderer with an accumulated feed object.

Feature: Live tool/skills feed
  As a Claude Code user watching the sidebar
  I want a compact feed of recent tool and skill calls plus rolling stats
  So that I can see what the session is doing and where its work is going

  Scenario: Recent tool calls are listed with a compact argument
    Given a feed
    And a tool event "Edit" with arg "economy.js"
    And a tool event "Bash" with arg "run tests"
    When the feed renders
    Then the feed shows "Edit" with "economy.js"
    And the feed shows "Bash" with "run tests"

  Scenario: The header summarizes tool counts
    Given a feed
    And the tool counts are Bash 36, Edit 12, Read 12
    When the feed renders
    Then the header line contains "Bash 36"
    And the header line contains "Edit 12"

  Scenario: Skills and slash-commands are shown distinctly
    Given a feed
    And a command event "/code-review"
    When the feed renders
    Then the feed shows a command "/code-review"

  Scenario: Only the most recent events are shown
    Given a feed
    And 9 tool events named "Bash"
    When the feed renders with a max of 5
    Then the feed shows 5 event lines

  Scenario: Rolling stats summarize files touched and work generated
    Given a feed
    And the rolling stats are 3 files and 53000 output tokens
    When the feed renders
    Then the feed shows "3 files"
    And the feed shows "53K generated"

  # --- Narrow panes: every feed line fits the width it is given ---
  # The same bug report as the economy row's missing reset (features/economy.feature,
  # "Narrow panes"): the frame clamps to the pane with no ellipsis, so a feed line
  # that overran its width read "Fix console encoding and rerun ru". The width the
  # feed is given is the pane, in columns, and no line may exceed it.

  Scenario: Every feed line fits the width the feed is given
    Given a feed
    And a tool event "Bash" with arg "Fix console encoding and rerun the whole ruler regression"
    And a tool event "mcp__treecontext__treecontext_insert" with arg "content"
    And a command event "/code-review-ultra-with-a-very-long-name"
    And the tool counts are Bash 36, Edit 12, Read 12
    And the rolling stats are 18 files and 210000 output tokens
    When the feed renders at a width of 39
    Then every feed line fits in 39 columns
    And the feed shows "Bash" with a shortened argument ending in "…"
    And the feed shows "mcp__treecontext__treecontext_insert" cut short with "…"

  Scenario: A wide pane leaves a short argument whole
    Given a feed
    And a tool event "Bash" with arg "run tests"
    When the feed renders at a width of 80
    Then the feed shows "Bash" with "run tests"
    And no feed line ends with "…"

  Scenario: An empty feed renders nothing
    Given a feed
    When the feed renders
    Then the feed output is empty
