# Acceptance criteria for the transcript reader (src/transcripts.js) — the shared
# spine for the tool/skills feed and the resume list. Steps drive the real parser
# with hand-built JSONL lines (no filesystem).

Feature: Reading Claude Code session transcripts
  As ccr
  I want to extract tool/skill activity, token usage, and session identity from a transcript
  So that the feed and the resume list have one trustworthy, read-only source

  # --- Tool calls become a feed of (tool, arg) events ---

  Scenario: Tool calls are surfaced with a compact argument summary
    Given a transcript
    And an assistant runs Bash described "run tests"
    And an assistant edits file "/home/u/proj/economy.js"
    When the transcript is parsed
    Then the feed lists a "Bash" event with arg "run tests"
    And the feed lists a "Edit" event with arg "economy.js"
    And the tool counts show "Bash" once and "Edit" once

  # --- Skills / slash-commands (logged as <command-name> in current CC) ---

  Scenario: Slash-commands tagged in user messages are detected as commands
    Given a transcript
    And the user runs the slash command "/code-review"
    When the transcript is parsed
    Then the feed includes a command "/code-review"
    And the command count is 1

  Scenario: A Skill tool_use is also detected as a command
    Given a transcript
    And an assistant invokes the Skill "deep-research"
    When the transcript is parsed
    Then the feed includes a command "deep-research"

  # --- Session identity + title for the resume list ---

  Scenario: Title and last-prompt are taken from the freshest markers
    Given a transcript
    And an ai-title "Early title"
    And an ai-title "Fix sidebar overlay"
    And a last-prompt "commit sidebar fixes"
    When the transcript is parsed
    Then the session title is "Fix sidebar overlay"
    And the last prompt is "commit sidebar fixes"

  Scenario: Session metadata is extracted
    Given a transcript on branch "main" in cwd "/home/u/proj"
    And an assistant runs Bash described "ls"
    When the transcript is parsed
    Then the git branch is "main"
    And the cwd is "/home/u/proj"

  # --- Token rollup for per-session stats ---

  Scenario: Assistant token usage is rolled up
    Given a transcript
    And an assistant turn using 100 input and 200 output tokens
    And an assistant turn using 50 input and 25 output tokens
    When the transcript is parsed
    Then the input token total is 150
    And the output token total is 225

  # --- Robustness ---

  Scenario: Malformed lines are skipped, not fatal
    Given a transcript
    And a malformed line
    And an assistant runs Bash described "still works"
    When the transcript is parsed
    Then parsing does not throw
    And the feed lists a "Bash" event with arg "still works"

  # --- Control chars are stripped from displayed fields (terminal-injection guard) ---

  Scenario: Control characters are stripped from displayed fields
    Given a transcript
    And an ai-title carrying an escape sequence
    And an assistant edits a file whose name carries an escape sequence
    And an assistant runs a tool whose name carries an escape sequence
    When the transcript is parsed
    Then the title has no control characters
    And no event argument has control characters
    And no tool-count label has control characters

  # --- The current transcript path is confined to ~/.claude/projects ---

  Scenario: A snapshot path inside the projects dir is accepted
    Given a projects dir "/home/u/.claude/projects"
    And a captured snapshot with transcript_path "/home/u/.claude/projects/x/s.jsonl"
    Then the resolved transcript path is "/home/u/.claude/projects/x/s.jsonl"

  Scenario: A snapshot path outside the projects dir is rejected
    Given a projects dir "/home/u/.claude/projects"
    And a captured snapshot with transcript_path "/etc/passwd.jsonl"
    Then the transcript path is rejected

  Scenario: A path traversal escaping the projects dir is rejected
    Given a projects dir "/home/u/.claude/projects"
    And a captured snapshot with transcript_path "/home/u/.claude/projects/../../../etc/shadow.jsonl"
    Then the transcript path is rejected

  Scenario: A non-transcript file inside the projects dir is rejected
    Given a projects dir "/home/u/.claude/projects"
    And a captured snapshot with transcript_path "/home/u/.claude/projects/x/evil.txt"
    Then the transcript path is rejected
