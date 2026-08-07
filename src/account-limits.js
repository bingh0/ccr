// @ts-check
'use strict';
// src/account-limits.js — reconcile the ACCOUNT-WIDE rate-limit meters across the
// live ccr profiles (cq/cw/ce/cr, …) so their sidecars agree.
//
// THE PROBLEM. The 5h and weekly walls are one shared account resource, but each
// ccr profile only captures them when ITS OWN Claude session renders the status
// line. Claude Code re-emits the status line per turn, not on a clock, so an idle
// profile keeps showing the numbers from its last turn. Two sidecars open
// side-by-side therefore disagree purely by capture time — the busy one is ahead,
// the idle one lags. (The model in use is irrelevant: 5h/weekly are not
// model-scoped.) We fix this by raising each meter the LOCAL profile already knows
// to the freshest value seen across sibling profiles.
//
// THE GUARD — never mix accounts. The snapshot carries no account/org id, so we
// cannot ask "same account?" directly. Instead we trust bucket IDENTITY: the
// account-wide windows (5h, weekly — the buckets with no model scope) reset on a
// per-account schedule, so at any instant every session on one account reports the
// same resets_at for them. We build an "account fingerprint" from exactly those
// buckets (key + reset instant) and merge a sibling ONLY when its fingerprint is
// byte-for-byte the local one. A different account would have to collide on every
// one of those independent reset timestamps at once (5h AND weekly) — negligible.
// A sibling from an already-rolled window has a different reset instant, so it is
// distrusted too (its used% is stale, not fresher). We never import a bucket the
// local snapshot lacks and never adopt a sibling's resets_at — we only ever raise
// the used% of a bucket the local profile is already showing. So a profile logged
// into its own account is never contaminated by another.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseResetsAt } = require('./burn');
const { modelScope } = require('./rate-limits');

const MAX_SNAPSHOT_BYTES = 1_000_000; // a status JSON is a few KB; bound parse/disk
const MAX_PROFILES = 32;              // sanity cap on how many siblings we merge
const MAX_SCAN_ENTRIES = 512;         // sanity cap on how many dir entries we inspect

/**
 * Canonical reset instant for fingerprinting/matching — tolerant of CC reporting
 * resets_at as epoch seconds or an ISO string. `null` when absent/unparseable.
 * @param {any} bucket
 * @returns {number | null}
 */
function resetInstant(bucket) {
  return bucket && bucket.resets_at != null ? parseResetsAt(bucket.resets_at) : null;
}

/**
 * The same-account signal: a stable string built from the ACCOUNT-WIDE buckets
 * only (no model scope), each as `key@reset`. Buckets missing a used% or a reset
 * are excluded — they can't anchor trust. Returns `null` when there is nothing to
 * anchor on (no usable account-wide bucket), which callers treat as "don't merge".
 * @param {any} rateLimits
 * @returns {string | null}
 */
function accountFingerprint(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const parts = [];
  for (const key of Object.keys(rateLimits)) {
    if (modelScope(key)) continue;                 // model-scoped ≠ account-wide anchor
    const r = rateLimits[key];
    if (!r || typeof r !== 'object' || r.used_percentage == null) continue;
    const at = resetInstant(r);
    if (at == null) continue;
    parts.push(`${key}@${at}`);
  }
  return parts.length ? parts.sort().join('|') : null;
}

/**
 * Raise each of the local profile's meters to the freshest value seen across
 * sibling profiles ON THE SAME ACCOUNT. Pure: no I/O. Returns the local rate_limits
 * unchanged (same reference) when there is nothing trustworthy to merge.
 *
 * @param {any} localRl the local snapshot's `rate_limits`
 * @param {any[]} siblingRls other profiles' `rate_limits` objects (account-untrusted)
 * @returns {any} a shallow clone with used_percentage bumped where warranted, or `localRl`
 */
function mergeAccountLimits(localRl, siblingRls) {
  const fp = accountFingerprint(localRl);
  if (!fp) return localRl;                         // nothing to anchor trust on
  const trusted = (siblingRls || []).filter((rl) => accountFingerprint(rl) === fp);
  if (!trusted.length) return localRl;

  let changed = false;
  /** @type {any} */
  const out = {};
  for (const key of Object.keys(localRl)) {
    const local = localRl[key];
    out[key] = local;
    if (!local || typeof local !== 'object' || local.used_percentage == null) continue;
    let best = Number(local.used_percentage);
    if (!Number.isFinite(best)) continue;
    const at = resetInstant(local);
    for (const rl of trusted) {
      const s = rl[key];
      if (!s || typeof s !== 'object') continue;
      // Same window only — a sibling whose bucket reset at a different instant is
      // from a rolled (or foreign) window; its used% does not describe this one.
      if (resetInstant(s) !== at) continue;
      const v = Number(s.used_percentage);
      if (Number.isFinite(v) && v > best) best = v;
    }
    if (best !== local.used_percentage) { out[key] = { ...local, used_percentage: best }; changed = true; }
  }
  return changed ? out : localRl;
}

/**
 * Read a sibling snapshot's `rate_limits`, best-effort. Bounded read; any error
 * (missing, oversized, unparseable) yields `null` so a bad sibling is simply
 * skipped rather than breaking the panel.
 * @param {string} file
 * @returns {any | null}
 */
function readSiblingRateLimits(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j && j.rate_limits) || null;
  } catch { return null; }
}

/**
 * Disk wrapper: gather sibling profiles' rate limits from the ccr profile root and
 * reconcile the local meters against them. Best-effort — returns `localRl` on any
 * problem so it can wrap the render path without a guard at the call site.
 *
 * Engages ONLY for the launcher's layout: instances under `~/.ccr/instances/`
 * (the 0.4.0 container/member split — src/instance-slot.js). A custom
 * CCR_STATE_DIR elsewhere has no sibling set to trust, so it behaves as
 * before (no merge). There is no slot-1 special case any more: slot 1 is an
 * ordinary member of instances/, which is exactly why the layout changed.
 *
 * @param {any} localRl the local snapshot's `rate_limits`
 * @param {string} stateDir the local instance's state dir (CCR_STATE_DIR)
 * @param {{ home?: string }} [opts]
 * @returns {any}
 */
function freshenAccountLimits(localRl, stateDir, opts = {}) {
  try {
    if (!localRl || typeof localRl !== 'object') return localRl;
    const home = opts.home || os.homedir();
    const root = path.resolve(path.join(home, '.ccr', 'instances'));
    const self = path.resolve(stateDir);
    if (path.dirname(self) !== root) return localRl; // not the launcher's layout
    const selfFile = path.resolve(path.join(stateDir, 'last-status.json'));

    /** @type {any[]} */
    const siblings = [];
    // Bound the WALK, not just the harvest: MAX_PROFILES alone counts collected
    // siblings, so entries that yield nothing — slot dirs with no snapshot yet,
    // junk — would all be stat'd on every tick. This runs inside the sidecar's
    // ~1s draw loop, so the scan stays capped by entries seen even though
    // instances/ holds only instance dirs under the 0.4.0 layout.
    let seen = 0;
    for (const name of fs.readdirSync(root)) {
      if (siblings.length >= MAX_PROFILES || ++seen > MAX_SCAN_ENTRIES) break;
      const p = path.join(root, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      const file = path.join(p, 'last-status.json');
      if (path.resolve(file) === selfFile) continue;
      const rl = readSiblingRateLimits(file);
      if (rl) siblings.push(rl);
    }
    return mergeAccountLimits(localRl, siblings);
  } catch { return localRl; }
}

module.exports = { accountFingerprint, mergeAccountLimits, freshenAccountLimits };
