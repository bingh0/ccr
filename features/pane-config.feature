# Tool: ccr sidecar — where the list of pane blob paths comes from
# Contract: docs/PANE-CONTRACT.md (v1) — "Discovery is user configuration, not
# convention." That sentence left the config surface itself unruled through two
# sessions; this feature is the ruling, expressed as behaviour.
#
# The shape of the decision: configuration is the USER's, and only the user's.
# ccr never guesses a blob path, never walks up from the working directory to
# find a config, and never reads a config a repository could contain — the same
# reasoning that removed configurable prompt-file paths from the hotkey surface.
# A pane is a thing the human deliberately wired up, exactly like Claude Code's
# statusLine wiring.
#
# @security marks the scenarios holding that boundary rather than the
# convenience of the format. They are gate-mandatory (test/security-tags.test.js).

Feature: Pane blob discovery through user configuration
  As a user who wants another tool's status beside my burn rate
  I want to name that tool's blob file in my own config
  So that panes appear because I asked for them, never because something guessed

  # --- Where configuration lives ---

  @security
  Scenario: Configuration is read from the user's config directory
    Given no CCR_CONFIG override is set
    When ccr resolves its configuration path
    Then it reads "ccr/config.json" under the XDG config directory
    And it falls back to "~/.config" when XDG_CONFIG_HOME is unset

  @security
  Scenario: A repository can never introduce a pane
    Given a config file sitting in the current working directory
    And a config file in the user's config directory naming no panes
    When the sidecar loads its pane configuration
    Then no pane from the working-directory file is configured
    And ccr never searches upward from the working directory for configuration

  Scenario: Configuration lives outside the state directory ccr rewrites
    # ~/.ccr holds state ccr writes every second; user-authored configuration
    # kept there is one clobber away from being lost.
    When ccr resolves its configuration path
    Then the path is not inside ccr's state directory

  # --- Reading the pane list ---

  Scenario: Panes are rendered in configuration order
    Given a configuration naming three blob paths in a deliberate order
    When the sidecar loads its pane configuration
    Then the three panes are configured in exactly that order

  Scenario: Two entries naming the same path are two panes
    # The contract says so explicitly: identical paths are not de-duplicated,
    # because position in the cycle is the user's choice, not ccr's.
    Given a configuration naming the same blob path twice
    When the sidecar loads its pane configuration
    Then two panes are configured

  Scenario: A relative path resolves against the configuration file's directory
    # Never against the working directory: a pane's identity must not depend on
    # where the sidecar happened to be started from.
    Given a configuration naming a blob path relative to itself
    When the sidecar loads its pane configuration
    Then the pane path resolves against the configuration file's own directory

  Scenario: A leading tilde expands to the user's home directory
    Given a configuration naming a blob path beginning with a tilde
    When the sidecar loads its pane configuration
    Then the pane path resolves under the user's home directory

  Scenario: A tilde followed by a backslash expands too
    # A Windows user writes the separator their shell shows them. Accepting only
    # `~/` left `~\tools\blob.json` to resolve against the config directory
    # instead — a path that cannot exist, and whose only symptom was a pane that
    # never appeared. What the tilde means does not depend on what follows it.
    Given a configuration naming a blob path beginning with a tilde and a backslash
    When the sidecar loads its pane configuration
    Then the pane path begins at the user's home directory

  # --- Written on Windows ---

  Scenario: A configuration saved with a byte-order mark still parses
    # PowerShell writes UTF-8 WITH a BOM by default — Set-Content, Out-File, and
    # `>` under Windows PowerShell all do — and JSON.parse rejects it. So the
    # obvious way to write this file on Windows produced a malformed config, and
    # the only symptom was panes that never appeared. There is no configuration
    # for which a leading BOM is content, so it is stripped rather than reported.
    Given a configuration file saved with a UTF-8 byte-order mark
    When the sidecar loads its pane configuration
    Then the configured pane is read from it as normal
    And no configuration error is reported

  Scenario: A configuration saved as UTF-16 blames the encoding, not the JSON
    # The likelier Windows mistake, and NOT the one the BOM strip catches.
    # Windows PowerShell 5.1 writes UTF-16LE for `>` and Out-File by default —
    # Set-Content writes ANSI, only `-Encoding utf8` produces the UTF-8 BOM, and
    # PowerShell 7+ writes UTF-8 without one. Read as UTF-8 those bytes survive
    # trimming and reach the parser as NUL-interleaved text, so the parse fails
    # and "not valid JSON" sends someone hunting a syntax error in a file whose
    # syntax is perfectly fine.
    Given a configuration file saved as UTF-16
    When the sidecar loads its pane configuration
    Then no panes are configured
    And the configuration error is named as "looks like UTF-16 — save it as UTF-8"

  # --- A bad config costs the panes, never the panel ---

  @security
  Scenario: A malformed configuration yields no panes and no exception
    Given a configuration file that is not parseable JSON
    When the sidecar loads its pane configuration
    Then no panes are configured
    And loading the configuration raises nothing
    And the configuration error is named as "not valid JSON"

  Scenario: A configuration with no pane list is named, not silently ignored
    Given a configuration file whose top level has no pane list
    When the sidecar loads its pane configuration
    Then no panes are configured
    And the configuration error is named as "no panes array"

  Scenario: A broken configuration says so on the panel
    # The panes are gone either way. What changed is that the panel no longer
    # looks IDENTICAL to one belonging to a user who configured nothing at all,
    # which is what made a typo indistinguishable from never having tried.
    Given a configuration file that is not parseable JSON
    When the sidecar renders its panel
    Then the panel names the configuration as the problem
    And the panel still shows the economy view

  Scenario: Entries that are not objects with a string path are skipped
    Given a configuration whose pane list mixes valid entries with junk
    When the sidecar loads its pane configuration
    Then only the valid entries become panes

  @security
  Scenario: A configuration entry carrying a prototype key cannot pollute
    Given a configuration whose pane entry also carries a "__proto__" key
    When the sidecar loads its pane configuration
    Then the pane is configured from its path alone
    And no property of any shared prototype has been altered

  Scenario: No configuration file at all is simply no panes
    Given no configuration file exists
    When the sidecar loads its pane configuration
    Then no panes are configured
    And the sidecar still renders its own economy view
    # The discriminating half of the error state: without this, a loader that
    # reported an error unconditionally would satisfy every scenario above.
    And no configuration error is reported

  @security
  Scenario: The configuration file itself is read under the safe-read rules
    # Config is trusted more than a blob — the user wrote it — but it is still a
    # file on disk, and a fifo would block the render loop just as effectively.
    Given the configuration path is a pipe that never yields bytes
    When the sidecar loads its pane configuration
    Then loading completes without blocking
    And no panes are configured
