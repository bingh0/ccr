// @ts-check
'use strict';
// scripts/release-gate.js — refuse to publish while a whole product surface
// has acceptance criteria that have never executed.
//
// This is ported from a sibling project, which learned it the expensive way. Its
// 0.0.9-beta added `journal-install.feature` and shipped in the same commit
// with all thirteen of its scenarios unbound; five field-reported defects then
// walked past a suite containing prose describing every one of them. The debt
// register was honest throughout — it said "awaiting the binding wave".
// Nothing required anyone to read it before cutting the release.
//
// ccr carries the same hazard with more consequence, because ccr actually
// publishes: a version on npm reaches people who did not read the feature
// files. `runFeatures` already ratchets the wip list in both directions, so
// the list cannot rot — but a green suite with a whole feature held open is
// still green, and green is what people check before publishing.
//
// It is not a veto. Some releases genuinely do not touch the unbound surface,
// and the owner is entitled to say so. It only demands that saying so be
// deliberate and on the record for THAT release:
//
//   CCR_RELEASE_ACCEPTS_UNBOUND="git-pane-safety" npm publish
//
// Each named feature must match a ruling. Naming one that is not ruled (or
// misspelling one) fails rather than silently waving everything through, and
// a bare `=1` catch-all is deliberately unsupported: the override has to name
// what is being accepted.
//
// ── The second check ──────────────────────────────────────────────────────
//
// The first check asks whether the release describes behavior that exists. The
// second asks whether publishing its HISTORY would disclose something. They
// are unrelated hazards that share one chokepoint, because the chokepoint is
// the last moment either can be caught.
//
// 0.4.0 is why, though not as a near-miss: its tree grepped clean while
// fourteen of the twenty-three commits behind the tip still carried a string
// the release had removed, and that string was later ruled publishable anyway.
// What the episode actually demonstrated is that nothing in the release path
// could see those fourteen commits, and that the only reason anyone looked was
// that someone chose to. This check looks every time, so publishing a flat
// scrubbed tip is a rule the release obeys rather than a habit it relies on.
//
// See scripts/history-privacy.js for what counts as a disclosure and why the
// specifics live outside this repository.

const { WHOLE_FEATURE_WIP } = require('../test/wip-register');
const { fixtureLiterals } = require('../test/privacy-fixtures');
const { discoverRepo } = require('../src/git-repo');
const { resolveHead, resolveRef } = require('../src/git-objects');
const { scanHistory, loadPrivatePatterns } = require('./history-privacy');

const ENV_KEY = 'CCR_RELEASE_ACCEPTS_UNBOUND';
const HISTORY_ENV_KEY = 'CCR_RELEASE_ACCEPTS_PRIVATE_HISTORY';
const PUBLIC_REF_KEY = 'CCR_PUBLIC_REF';
const DEFAULT_PUBLIC_REF = 'refs/remotes/origin/main';

/** Short form used in output and in the override list. */
const short = (/** @type {string} */ oid) => oid.slice(0, 7);

/**
 * Refuse to publish a history that would disclose something the published tree
 * does not already say.
 *
 * Fails CLOSED on an unresolvable published ref, matching the pre-push hook: a
 * check that cannot establish what is already public cannot clear anything.
 * Skips — loudly — when there is no repository at all, which is the ordinary
 * case of publishing from an unpacked tarball.
 *
 * Called two ways. At publish time it works out the range itself: HEAD against
 * whatever remote-tracking ref names the public branch. At PUSH time the hook
 * has already resolved both ends — the live public tip via `git ls-remote`, and
 * the exact sha being pushed, which is not necessarily HEAD — and passes them
 * in. The pushed range is the honest one: it is what the remote will actually
 * gain, and it does not trust a remote-tracking ref that may be stale.
 *
 * @param {{ tip?: string|null, published?: string|null, verb?: 'publish'|'push' }} [opts]
 * @returns {boolean} True to continue, false when the caller should exit 1.
 */
function historyCheck(opts = {}) {
  const verb = opts.verb === 'push' ? 'push' : 'publish';
  const repo = discoverRepo(process.cwd());
  if (!repo.found || !repo.gitDir) {
    console.log('release-gate: no repository here — the history privacy scan did not run.');
    return true;
  }
  const gitDir = repo.gitDir;

  const tip = opts.tip || resolveHead(gitDir);
  if (tip === null) {
    console.error(`release-gate: REFUSING to ${verb} — HEAD does not resolve to a commit.`);
    return false;
  }

  const ref = process.env[PUBLIC_REF_KEY] || DEFAULT_PUBLIC_REF;
  const published = opts.published || resolveRef(gitDir, ref);
  if (published === null) {
    console.error(`release-gate: REFUSING to ${verb} — cannot resolve the published ref ${ref}.`);
    console.error('             Without it there is no way to know which commits are new.');
    console.error(`             Fetch it, or name the right one: ${PUBLIC_REF_KEY}=refs/remotes/<remote>/<branch>\n`);
    return false;
  }

  const priv = loadPrivatePatterns();
  if (priv.invalid.length > 0) {
    console.error(`release-gate: REFUSING to ${verb} — unparseable private patterns in ${priv.source}:`);
    for (const s of priv.invalid) console.error(`               ${s}`);
    return false;
  }

  const result = scanHistory(gitDir, {
    tip, published, privatePatterns: priv.patterns, allow: fixtureLiterals(),
  });

  if (result.state === 'unavailable') {
    console.error(`release-gate: REFUSING to ${verb} — the object store could not be read,`);
    console.error('             so the history privacy scan reached no conclusion.');
    return false;
  }

  const accepted = new Set((process.env[HISTORY_ENV_KEY] || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
  const blocking = result.hits.filter((h) => !accepted.has(short(h.commit)));

  if (blocking.length === 0) {
    const scope = result.commitsScanned === 0
      ? 'nothing unpublished'
      : `${result.commitsScanned} unpublished commit(s), ${result.blobsScanned} blob(s)`;
    const supplement = priv.configured
      ? `private patterns from ${priv.source}`
      : 'NO private pattern list configured — generic detectors only';
    console.log(`release-gate: history privacy scan clean — ${scope}; ${supplement}.`);
    if (result.truncated) {
      console.log('release-gate: NOTE — the walk hit its commit ceiling; older commits went unscanned.');
    }
    if (result.hits.length > 0) {
      console.log(`release-gate: ${result.hits.length} finding(s) accepted via ${HISTORY_ENV_KEY}.`);
    }
    return true;
  }

  console.error(`release-gate: REFUSING to ${verb}.\n`);
  console.error('These commits are not public yet, and carry strings the published tree');
  console.error(`does not already contain. ${verb === 'push' ? 'Pushing' : 'Publishing'} this history would disclose them:\n`);

  /** @type {Map<string, typeof blocking>} */
  const byCommit = new Map();
  for (const h of blocking) {
    const list = byCommit.get(h.commit) || [];
    list.push(h);
    byCommit.set(h.commit, list);
  }
  for (const [commit, list] of byCommit) {
    console.error(`  ${short(commit)}`);
    for (const h of list.slice(0, 10)) {
      const what = h.literal ? `${h.literal} — ${h.why}` : h.why;
      console.error(`    ${h.path}: ${what}`);
    }
    if (list.length > 10) console.error(`    … and ${list.length - 10} more in this commit`);
    console.error('');
  }

  console.error('The remedy is the flat squash: publish the scrubbed tip as ONE commit, so');
  console.error('the commits above never reach the public repository.\n');
  console.error(`  git checkout -B release-staging ${DEFAULT_PUBLIC_REF.replace('refs/remotes/', '')}`);
  console.error('  git merge --squash <your branch>');
  console.error('  git commit\n');
  console.error('If a finding is genuinely publishable, name the commits that carry it:\n');
  console.error(`  ${HISTORY_ENV_KEY}="${[...byCommit.keys()].map(short).join(',')}" ${verb === 'push' ? 'git push' : 'npm publish'}\n`);
  return false;
}

/**
 * Refuse to publish while a whole product surface has never executed.
 * @returns {boolean} True to continue, false when the caller should exit 1.
 */
function wipCheck() {
  if (WHOLE_FEATURE_WIP.length === 0) {
    console.log('release-gate: no whole-feature wip rulings — every feature surface is bound.');
    return true;
  }

  const accepted = (process.env[ENV_KEY] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ruled = new Set(WHOLE_FEATURE_WIP.map((r) => r.feature));
  const unknown = accepted.filter((a) => !ruled.has(a));
  if (unknown.length > 0) {
    console.error(`release-gate: ${ENV_KEY} names features with no whole-feature ruling: ${unknown.join(', ')}`);
    console.error(`             ruled surfaces are: ${[...ruled].join(', ')}`);
    return false;
  }

  const blocking = WHOLE_FEATURE_WIP.filter((r) => !accepted.includes(r.feature));
  if (blocking.length === 0) {
    console.log(`release-gate: proceeding — this release accepts ${accepted.join(', ')} as unbound.`);
    return true;
  }

  console.error('release-gate: REFUSING to publish.\n');
  console.error('These product surfaces have acceptance criteria that have never executed:\n');
  for (const r of blocking) {
    console.error(`  ${r.feature}   (ruled ${r.ruledOn})`);
    console.error(`    ${r.reason}\n`);
  }
  console.error('Bind the feature, or state that this release does not need it:\n');
  console.error(`  ${ENV_KEY}="${blocking.map((r) => r.feature).join(',')}" npm publish\n`);
  return false;
}

/**
 * A sha the CALLER supplied rather than one this script resolved. Fails closed
 * on anything that is not a full object id: a truncated or mistyped value would
 * otherwise scan some other range and report it clean, which is worse than not
 * scanning at all because it looks like an answer.
 * @param {string|null|undefined} value
 * @param {string} what
 * @returns {string|null}
 */
function requireOid(value, what) {
  if (typeof value === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return value.toLowerCase();
  console.error(`release-gate: REFUSING to push — ${what} is not a full object id: ${value || '(missing)'}`);
  return null;
}

/**
 * @param {string[]} argv
 * @returns {{ prePush: boolean, tip: string|null, published: string|null }|null}
 *   null means the arguments themselves were bad; the caller exits rather than
 *   guessing what was meant.
 */
function parseArgs(argv) {
  /** @type {{ prePush: boolean, tip: string|null, published: string|null }} */
  const out = { prePush: false, tip: null, published: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pre-push') out.prePush = true;
    else if (a === '--tip') out.tip = argv[++i] || null;
    else if (a === '--published') out.published = argv[++i] || null;
    else {
      console.error(`release-gate: unknown argument ${a}`);
      console.error('             usage: release-gate [--pre-push --tip <sha> --published <sha>]');
      return null;
    }
  }
  return out;
}

// Both publish-time checks always run. Short-circuiting would hand the operator
// one reason, let them fix it, and then hand them the second — two round trips
// to learn what one run already knew.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) process.exit(2);

  if (args.prePush) {
    // The PUSH path runs the history scan only. "Does this release describe
    // behaviour that exists" is a question about a release, not about a push,
    // and a hook that refused ordinary pushes over it would get switched off —
    // taking the privacy scan with it. The scan is the reason this path exists:
    // a push is the moment history becomes public, and the publish-time check
    // sees nothing by then because the commits are already on the remote.
    const tip = requireOid(args.tip, 'the pushed tip (--tip)');
    const published = requireOid(args.published, 'the live public tip (--published)');
    if (tip === null || published === null) process.exit(1);
    process.exit(historyCheck({ tip, published, verb: 'push' }) ? 0 : 1);
  }

  const wipOk = wipCheck();
  const historyOk = historyCheck();
  if (!wipOk || !historyOk) process.exit(1);
}

if (require.main === module) main();

module.exports = { parseArgs, requireOid };
