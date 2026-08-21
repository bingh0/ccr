// @ts-check
'use strict';
// src/history-privacy.js — what a release would publish that is not published
// yet, read out of the object store rather than out of the working tree.
//
// Why this is not simply `git grep` over the working tree: a scrubbed tip says
// nothing about the blobs behind it. 0.4.0 made the shape concrete — its tree
// grepped clean while fourteen of the twenty-three commits behind that tip
// still carried a string the release had deliberately removed. Invisible to
// every check anyone ran, because every check ran on the tree.
//
// That particular string turned out to be publishable after all (ruled
// 2026-08-07; the flat squash it prompted cost nothing either way). The
// arithmetic is the lesson rather than the string: fourteen commits, none of
// them reachable from an inspection of the tip, and nothing in the release path
// that would have looked.
//
// The disclosures this repository has ACTUALLY had were both mail addresses —
// an owner address throughout early history, and a contributor's real address
// on a branch that reached the public remote in 2026-06. Neither was in the tip
// when it mattered. Both are what the real-inbox detector below is for.
//
// So the check reads history, not `HEAD`: every commit reachable from the tip
// and not from the published ref, every blob in each of their trees.
//
// TWO KINDS OF FINDING, deliberately different:
//
//   * DETECTORS (below) are generic and live here in the open, because they
//     describe SHAPES — an email that is not a noreply alias, an absolute home
//     path — not anyone's actual secrets. They cover both disclosures above.
//
//   * The PRIVATE SUPPLEMENT is a list of literal patterns supplied from
//     OUTSIDE the repository (see loadPrivatePatterns). Whatever belongs on it
//     is by definition a string this file must not contain: writing it into a
//     public file in order to scan for it would be the disclosure it prevents.
//
// Detector hits are judged against a BASELINE: whatever the published tree
// already contains is, by definition, already public and not news. That is why
// there is no allowlist to maintain — the npm contact alias in package.json is
// silent because it is already out there, and it would start speaking again
// the moment it appeared somewhere it had not been. Supplement hits ignore the
// baseline: those strings are never acceptable, published already or not.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readObject, parseTree } = require('./git-objects');

/** Commits walked before the scan gives up rather than grind. */
const MAX_COMMITS = 2000;
/** Distinct blobs read per scan. Trees and blobs are deduplicated by oid, so
 *  this counts real content, not path instances. */
const MAX_BLOBS = 20000;
/** A blob larger than this is not read. Secrets hide in text, and the object
 *  reader has its own ceiling anyway. */
const MAX_BLOB_BYTES = 1024 * 1024;
/** Bytes inspected for NUL before calling a blob binary and skipping it. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * A generic shape worth refusing to publish. `extract` returns the literal
 * strings found, which is what makes baseline comparison possible: the finding
 * is the STRING, so "already public" is a set membership test.
 *
 * @typedef {object} Detector
 * @property {string} name
 * @property {string} why      Printed to the operator, so it must explain itself.
 * @property {(text: string) => string[]} extract
 */

/**
 * Addresses that are aliases by construction. This is not an allowlist of
 * anyone's real mail — it is the set of names that CANNOT reach an inbox,
 * which is why a fixture is entitled to use them freely.
 *
 * The reserved names are RFC 2606 and RFC 6761: the `.invalid`, `.test`,
 * `.example` and `.localhost` TLDs, and the `example.com/org/net` domains.
 * They are matched as SUFFIXES, so `oracle@ccr.invalid` and
 * `someone@corp.example.com` are covered — an earlier version anchored on
 * `@invalid$` and flagged this repository's own test fixtures.
 */
const ALIAS_MAIL = /(@users\.noreply\.github\.com|@noreply\.[A-Za-z0-9.-]+|^noreply@|\.(invalid|test|example|localhost)$|(^|@|\.)example\.(com|org|net)$)/i;

const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * `/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\` — an absolute path
 * through somebody's home directory. Generic placeholders are not findings.
 */
const HOME_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g;
const PLACEHOLDER_USER = /^(user|username|you|me|someone|test|runner|ci|root|foo|bar|example|\$\{?\w+\}?)$/i;

/** @type {Detector[]} */
const DETECTORS = [
  {
    name: 'real-inbox',
    why: 'an email address that is not a noreply alias',
    extract: (text) => (text.match(MAIL_RE) || []).filter((m) => !ALIAS_MAIL.test(m)),
  },
  {
    name: 'home-path',
    why: 'an absolute path naming a home directory',
    extract: (text) => {
      /** @type {string[]} */
      const out = [];
      for (const m of text.matchAll(HOME_RE)) {
        if (!PLACEHOLDER_USER.test(m[1])) out.push(m[0]);
      }
      return out;
    },
  },
];

/**
 * The private supplement: literal ERE-ish patterns that must never appear,
 * supplied from outside the repository so the repository never states them.
 *
 * Sources, first one that exists wins:
 *   1. $CCR_PRIVATE_PATTERNS       — patterns inline, comma or newline separated
 *   2. $CCR_PRIVATE_PATTERNS_FILE  — a file of them, one per line, `#` comments
 *   3. ~/.config/ccr/private-patterns
 *
 * Absent all three the supplement is empty and `configured` is false, which
 * the gate reports rather than swallows: a check that quietly did not run is
 * worse than one that says so.
 *
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: () => string }} [deps]
 * @returns {{ configured: boolean, source: string|null, patterns: RegExp[], invalid: string[] }}
 */
function loadPrivatePatterns(deps = {}) {
  const env = deps.env || process.env;
  const home = (deps.homedir || os.homedir)();

  /** @type {string|null} */
  let raw = null;
  /** @type {string|null} */
  let source = null;

  if (env.CCR_PRIVATE_PATTERNS && env.CCR_PRIVATE_PATTERNS.trim()) {
    raw = env.CCR_PRIVATE_PATTERNS;
    source = '$CCR_PRIVATE_PATTERNS';
  } else {
    const file = env.CCR_PRIVATE_PATTERNS_FILE
      || path.join(home, '.config', 'ccr', 'private-patterns');
    try {
      raw = fs.readFileSync(file, 'utf8');
      source = file;
    } catch {
      raw = null;
    }
  }

  if (raw === null) return { configured: false, source: null, patterns: [], invalid: [] };

  /** @type {RegExp[]} */
  const patterns = [];
  /** @type {string[]} */
  const invalid = [];
  for (const line of raw.split(/[\n,]/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try {
      patterns.push(new RegExp(s, 'i'));
    } catch {
      invalid.push(s);
    }
  }
  return { configured: true, source, patterns, invalid };
}

/**
 * Commits reachable from `tip` and not from `published`.
 *
 * The exclusion side is walked first and in full, so a commit that is an
 * ancestor of the published ref is never reported no matter which order the
 * tip walk reaches it in.
 *
 * A commit whose object cannot be read is REPORTED, not skipped. Dropping it
 * would shrink the answer silently: an unreadable tip would walk to an empty
 * list, and an empty list of unpublished commits is indistinguishable from
 * having nothing to disclose. The caller must be able to tell those apart.
 *
 * @param {string} gitDir
 * @param {string} tip
 * @param {string|null} published  Null means "nothing is published yet".
 * @returns {{ commits: string[], unreadable: string[], truncated: boolean }}
 */
function unpublishedCommits(gitDir, tip, published) {
  const parentsOf = (/** @type {string} */ oid) => {
    const obj = readObject(gitDir, oid);
    if (obj === null || obj.type !== 'commit') return null;
    const header = obj.data.toString('utf8', 0, Math.min(obj.data.length, 8192));
    const end = header.indexOf('\n\n');
    const head = end === -1 ? header : header.slice(0, end);
    return [...head.matchAll(/^parent ([0-9a-f]{40}|[0-9a-f]{64})$/gm)].map((m) => m[1]);
  };

  /** @type {Set<string>} */
  const excluded = new Set();
  if (published !== null) {
    const stack = [published];
    while (stack.length > 0 && excluded.size < MAX_COMMITS) {
      const oid = /** @type {string} */ (stack.pop());
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      const ps = parentsOf(oid);
      if (ps !== null) stack.push(...ps);
    }
  }

  /** @type {string[]} */
  const commits = [];
  /** @type {string[]} */
  const unreadable = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const stack = [tip];
  let truncated = false;
  while (stack.length > 0) {
    const oid = /** @type {string} */ (stack.pop());
    if (seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    if (commits.length >= MAX_COMMITS) { truncated = true; break; }
    const ps = parentsOf(oid);
    if (ps === null) { unreadable.push(oid); continue; }
    commits.push(oid);
    stack.push(...ps);
  }
  return { commits, unreadable, truncated };
}

/**
 * Every blob in a commit's tree, as `path -> oid`, following subtrees and
 * skipping gitlinks (mode 0o160000 — a submodule pointer names a commit in
 * another repository, whose contents are not ours to read).
 *
 * @param {string} gitDir
 * @param {string} treeOid
 * @param {Set<string>} treesSeen  Shared across commits: sibling releases share
 *   almost all of their trees, and re-walking them is the whole cost.
 * @param {(path: string, oid: string) => void} onBlob
 */
function walkTree(gitDir, treeOid, treesSeen, onBlob, prefix = '') {
  if (treesSeen.has(treeOid)) return;
  treesSeen.add(treeOid);
  const obj = readObject(gitDir, treeOid);
  if (obj === null || obj.type !== 'tree') return;
  const entries = parseTree(obj.data, treeOid.length / 2);
  if (entries === null) return;
  for (const e of entries) {
    const full = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === 0o160000) continue;
    if (e.mode === 0o40000) walkTree(gitDir, e.oid, treesSeen, onBlob, full);
    else onBlob(full, e.oid);
  }
}

/**
 * Read a blob as text, or null when it is missing, oversized or binary.
 * @param {string} gitDir
 * @param {string} oid
 */
function readTextBlob(gitDir, oid) {
  const obj = readObject(gitDir, oid);
  if (obj === null || obj.type !== 'blob') return null;
  if (obj.data.length > MAX_BLOB_BYTES) return null;
  if (obj.data.indexOf(0, 0) !== -1
    && obj.data.indexOf(0, 0) < BINARY_SNIFF_BYTES) return null;
  return obj.data.toString('utf8');
}

/**
 * Every literal a detector finds anywhere in a tree — the baseline of what is
 * already public, so the same string appearing again is not a new disclosure.
 *
 * @param {string} gitDir
 * @param {string} treeOid
 * @returns {Set<string>}
 */
function baselineLiterals(gitDir, treeOid) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Set<string>} */
  const trees = new Set();
  /** @type {Set<string>} */
  const blobs = new Set();
  walkTree(gitDir, treeOid, trees, (_p, oid) => {
    if (blobs.has(oid) || blobs.size >= MAX_BLOBS) return;
    blobs.add(oid);
    const text = readTextBlob(gitDir, oid);
    if (text === null) return;
    for (const d of DETECTORS) for (const lit of d.extract(text)) found.add(lit);
  });
  return found;
}

/**
 * @typedef {object} PrivacyHit
 * @property {string} commit    Oid of the commit whose tree carries it.
 * @property {string} path      Path within that tree.
 * @property {string} kind      Detector name, or 'private-pattern'.
 * @property {string} why       Human sentence for the operator.
 * @property {string} [literal] The offending string, when it is safe to print
 *   (detector hits only — a supplement hit prints its pattern, never its match).
 */

/**
 * Scan the unpublished history.
 *
 * @param {string} gitDir
 * @param {object} opts
 * @param {string} opts.tip            Commit about to be published from.
 * @param {string|null} opts.published Commit currently public, or null.
 * @param {RegExp[]} [opts.privatePatterns]
 * @param {string[]} [opts.allow]      Literals known to be invented, joined to
 *   the baseline. Detector hits only — a private pattern is never waived here.
 * @returns {{ state: 'clean'|'hits'|'unavailable', hits: PrivacyHit[],
 *   commitsScanned: number, blobsScanned: number, truncated: boolean }}
 */
function scanHistory(gitDir, opts) {
  const priv = opts.privatePatterns || [];
  const walk = unpublishedCommits(gitDir, opts.tip, opts.published);
  const { commits, truncated } = walk;

  // ANY commit the object store could not answer for makes the whole scan
  // inconclusive, and inconclusive is not clean. A gate that cleared a release
  // because it failed to read the evidence would be worse than no gate: it
  // would report success in exactly the situation it exists to catch.
  if (walk.unreadable.length > 0) {
    return {
      state: 'unavailable', hits: [], commitsScanned: 0, blobsScanned: 0, truncated,
    };
  }

  if (commits.length === 0) {
    return { state: 'clean', hits: [], commitsScanned: 0, blobsScanned: 0, truncated };
  }

  // What the published tree already says. Absent a published ref there is no
  // baseline and every detector hit is news, which is the correct reading of
  // a first publication.
  /** @type {Set<string>} */
  let baseline = new Set(opts.allow || []);
  if (opts.published !== null) {
    const obj = readObject(gitDir, opts.published);
    if (obj !== null && obj.type === 'commit') {
      const m = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(
        obj.data.toString('latin1', 0, Math.min(obj.data.length, 256)));
      // Merged, not assigned: the allow list must survive the published tree's
      // own literals being read in on top of it.
      if (m) for (const lit of baselineLiterals(gitDir, m[1])) baseline.add(lit);
    }
  }

  /** @type {PrivacyHit[]} */
  const hits = [];
  let unreadable = 0;
  let blobCeiling = false;

  // Reading and matching a blob is the expensive half and is done ONCE per
  // oid. Attribution is the cheap half and is done per commit: the same blob
  // usually survives many commits, and an operator who is told only about the
  // first one would accept that commit and publish the other nine. The earlier
  // shape of this function made exactly that mistake.
  /** @type {Map<string, Array<{ kind: string, why: string, literal?: string }>>} */
  const verdicts = new Map();
  const verdictFor = (/** @type {string} */ oid) => {
    const cached = verdicts.get(oid);
    if (cached !== undefined) return cached;
    if (verdicts.size >= MAX_BLOBS) { blobCeiling = true; return []; }
    /** @type {Array<{ kind: string, why: string, literal?: string }>} */
    const found = [];
    const text = readTextBlob(gitDir, oid);
    if (text !== null) {
      // One finding per distinct literal per blob. A string repeated forty
      // times in a file is one disclosure, and forty lines of it would bury
      // the other findings the operator needs to see.
      /** @type {Set<string>} */
      const already = new Set();
      for (const d of DETECTORS) {
        for (const lit of d.extract(text)) {
          if (baseline.has(lit) || already.has(lit)) continue;
          already.add(lit);
          found.push({ kind: d.name, why: d.why, literal: lit });
        }
      }
      for (const re of priv) {
        if (re.test(text)) {
          found.push({ kind: 'private-pattern', why: `matches the private pattern /${re.source}/` });
        }
      }
    }
    verdicts.set(oid, found);
    return found;
  };

  for (const commit of commits) {
    const obj = readObject(gitDir, commit);
    if (obj === null || obj.type !== 'commit') { unreadable += 1; continue; }
    const m = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(
      obj.data.toString('latin1', 0, Math.min(obj.data.length, 256)));
    if (!m) { unreadable += 1; continue; }

    // Per-commit, so a tree shared with an already-walked commit is still
    // attributed to this one. Within a commit it still collapses duplicates.
    /** @type {Set<string>} */
    const treesSeen = new Set();
    walkTree(gitDir, m[1], treesSeen, (p, oid) => {
      for (const v of verdictFor(oid)) hits.push({ commit, path: p, ...v });
    });
  }

  // Same rule one level down: a commit that resolved but whose tree header did
  // not parse leaves part of the history unexamined.
  if (unreadable > 0) {
    return {
      state: 'unavailable', hits: [], commitsScanned: 0,
      blobsScanned: verdicts.size, truncated: truncated || blobCeiling,
    };
  }

  return {
    state: hits.length > 0 ? 'hits' : 'clean',
    hits,
    commitsScanned: commits.length,
    blobsScanned: verdicts.size,
    truncated: truncated || blobCeiling,
  };
}

module.exports = {
  scanHistory, unpublishedCommits, loadPrivatePatterns, walkTree, baselineLiterals,
  DETECTORS, MAX_COMMITS, MAX_BLOBS, MAX_BLOB_BYTES,
};
