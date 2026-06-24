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

  Scenario: An empty feed renders nothing
    Given a feed
    When the feed renders
    Then the feed output is empty
