// @ts-check
'use strict';
// test/_links.js — planting link fixtures on every platform we support.
// Specified by features/design/test-link-fixtures.feature.
//
// A dozen tests across the suite plant a link and assert that production code
// refuses to follow it. On Windows fs.symlinkSync throws EPERM unless the
// process is elevated or Developer Mode is on, so nine of them failed on the
// FIXTURE rather than on the guard — no Windows contributor could get
// `npm test` green, which also puts `prepublishOnly` out of reach.
//
// Two problems hide behind that one error, and they have different answers:
//
//   DIRECTORY targets — a junction is faithful. Windows lets an unprivileged
//   process create one, Node reports it as isSymbolicLink() === true, and
//   src/instance-slot.js's defaultDirUsable() rejects it exactly as it rejects
//   a POSIX symlink. The property under test is preserved, so these run for
//   real on Windows via plantDirLink().
//
//   FILE targets — there is no unprivileged equivalent. A junction cannot
//   point at a file, and a hardlink INVERTS the property under test: writing
//   through a hardlink does reach the target, which is the opposite of what
//   these tests assert. Substituting one would turn a real guard into a green
//   test proving its own negation. So they skip, by name and with a reason, on
//   a machine that cannot build the fixture — and run normally on one that
//   can, which includes an elevated shell and GitHub's Windows runners.
//
// Like the other `_`-prefixed modules here this is picked up by `node --test`
// as a zero-test file, which is harmless.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

/**
 * Can this process create a symlink to a FILE? Answered by doing it, not by
 * inspecting the platform: the answer depends on Developer Mode, on the
 * token's privilege level, and on the filesystem underneath — none of which
 * Node exposes, and all of which fail the same way for our purposes.
 *
 * Uncached and self-cleaning, so it can be called again to check the cache is
 * telling the truth.
 *
 * @returns {boolean}
 */
function probeFileSymlinks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-linkprobe-'));
  try {
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @type {boolean | null} */
let cached = null;

/** probeFileSymlinks(), measured once per process. */
function fileSymlinksAvailable() {
  if (cached === null) cached = probeFileSymlinks();
  return cached;
}

// Named so the runner's output says what the machine is missing, not merely
// that something was skipped. A skip nobody can act on is the debt this tier
// exists to refuse.
const SKIP_REASON = 'needs a symlink to a FILE, which this machine cannot create '
  + '— enable Developer Mode on Windows, or run elevated';

/**
 * A node:test `skip` value for a test that must plant a symlink to a file:
 * a reason string where that is impossible, `false` where it works.
 *
 * @param {boolean} [available] override the probe (used by the spec itself)
 * @returns {string | false}
 */
function skipWithoutFileSymlinks(available) {
  const can = available === undefined ? fileSymlinksAvailable() : available;
  return can ? false : SKIP_REASON;
}

/**
 * Plant a link at `linkPath` pointing at the DIRECTORY `target`. A junction on
 * Windows, an ordinary directory symlink elsewhere; both satisfy
 * isSymbolicLink(), which is the property every caller is testing. Node
 * normalizes a junction's target to an absolute path for us.
 *
 * @param {string} target @param {string} linkPath
 */
function plantDirLink(target, linkPath) {
  fs.symlinkSync(target, linkPath, isWin ? 'junction' : 'dir');
}

/**
 * Plant a link at `linkPath` pointing at the FILE `target`. Guard the call
 * with skipWithoutFileSymlinks() — where the privilege is missing this throws
 * EPERM, and that is the honest outcome rather than a weaker substitute.
 *
 * @param {string} target @param {string} linkPath
 */
function plantFileLink(target, linkPath) {
  fs.symlinkSync(target, linkPath, 'file');
}

/**
 * Say, where the runner's output is read, that a step declined because this
 * platform cannot build its fixture.
 *
 * A Gherkin scenario whose steps quietly no-op still reports as PASSING, which
 * is how a ratified @security scenario came to assert nothing on Windows while
 * looking green. test/gherkin.js refuses `@skip` for the same reason ("debt
 * with no ledger entry"), and announces a misbehaving @todo with console.error
 * — so that is the channel used here too.
 *
 * @param {string} fixture what could not be built
 * @param {string} limit why this platform cannot build it
 * @param {(s: string) => void} [write] injectable sink, for the spec
 */
function announceUnbuildable(fixture, limit, write) {
  (write || console.error)(`fixture not buildable here: ${fixture} — ${limit}`);
}

module.exports = {
  isWin,
  SKIP_REASON,
  probeFileSymlinks,
  fileSymlinksAvailable,
  skipWithoutFileSymlinks,
  plantDirLink,
  plantFileLink,
  announceUnbuildable,
};
