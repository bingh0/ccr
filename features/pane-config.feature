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

  # --- A bad config costs the panes, never the panel ---

  @security
  Scenario: A malformed configuration yields no panes and no exception
    Given a configuration file that is not parseable JSON
    When the sidecar loads its pane configuration
    Then no panes are configured
    And loading the configuration raises nothing

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

  @security
  Scenario: The configuration file itself is read under the safe-read rules
    # Config is trusted more than a blob — the user wrote it — but it is still a
    # file on disk, and a fifo would block the render loop just as effectively.
    Given the configuration path is a pipe that never yields bytes
    When the sidecar loads its pane configuration
    Then loading completes without blocking
    And no panes are configured
