// @ts-check
'use strict';
// test/privacy-fixtures.js — invented strings that LOOK private, and the
// reason each one is not.
//
// The history privacy scan (src/history-privacy.js) judges a detector hit
// against what the published tree already contains, so it needs no allowlist
// for anything real: an address already on npm is silent because it is already
// out there. Test fixtures are the one exception, and they are unavoidable —
// the scenario that proves the real-inbox detector FIRES has to contain an
// address the detector fires on, or it proves nothing.
//
// Reserved names (RFC 2606 / 6761: `.invalid`, `.test`, `.example`,
// `example.com`) cover every fixture that does NOT need to trip a detector,
// and those are handled in the detector itself rather than listed here. What
// remains is the short list below: strings deliberately shaped to look real.
//
// This is a register in the sense test/wip-register.js is one — an entry costs
// a written reason, it is visible in the diff that adds it, and it is read at
// release time by machinery that would otherwise refuse. Anything here is
// PUBLISHED. Never add a string that is actually private; the remedy for one
// of those is to stop committing it, not to list it.

/**
 * @typedef {object} FixtureLiteral
 * @property {string} literal  Exact string the detectors would otherwise flag.
 * @property {string} where    The file that needs it, so a stale entry is findable.
 * @property {string} reason   Why it is invented, not disclosed.
 */

/** @type {FixtureLiteral[]} */
const FIXTURE_LITERALS = [
  {
    literal: 'real.person@corp.example.io',
    where: 'features/design/release-history-privacy.feature',
    reason:
      'The address the real-inbox scenarios fire on. `example.io` is NOT a '
      + 'reserved domain and deliberately so — a reserved one would be filtered '
      + 'by the detector under test, and the scenario would pass whether the '
      + 'detector worked or not.',
  },
  {
    literal: '/home/jrivera',
    where: 'features/design/release-history-privacy.feature',
    reason:
      'The home path the home-path scenario fires on. Invented name, chosen to '
      + 'not match the placeholder list the detector skips (`user`, `runner`, '
      + '`ci`, …) — same reasoning as the address above.',
  },
];

/** The literals alone, which is all the scanner needs. */
const fixtureLiterals = () => FIXTURE_LITERALS.map((f) => f.literal);

module.exports = { FIXTURE_LITERALS, fixtureLiterals };
