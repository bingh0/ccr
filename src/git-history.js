// @ts-check
'use strict';
// src/git-history.js — recent commits with their branch structure, the model
// behind the pane's graph section (features/git-commit-graph.feature).
//
// THE WALK STARTS AT EVERY LOCAL BRANCH, not just HEAD. The visionary chose a
// multi-lane graph to match IDE git-graph habits, and those graphs answer
// "what lines of work exist here", which a HEAD-ancestry walk cannot — a
// repository with three topic branches would draw one lane and call itself
// done. Tips are ordered newest-first; when there are more tips than lanes
// (laneBudget in the renderer), the newest keep their lanes and the rest are
// COUNTED, never silently dropped — the lane-overflow scenario exists because
// the visionary was warned a graph that dropped branches would be worse than
// the flat list it replaced.
//
// LANE ASSIGNMENT is the classic newest-first sweep: each lane holds the
// commit id it expects next; a commit takes the leftmost lane expecting it,
// closes every other lane that expected it (a fork, seen from below), and
// hands its first parent that lane — extra parents open lanes beside it (the
// merge's second line). This is a simplification of git log --graph's painter
// and its contract is exactly what the scenarios pin: lane COUNT, join at the
// merge, newest first.
//
// Commit metadata is display data from an untrusted repository: subjects are
// stripped at THIS boundary (the choke-point rule of src/git-repo.js), and
// every read is bounded — the walk has a hard commit cap, and object reads
// inherit src/git-objects.js's own caps.

const path = require('node:path');
const fs = require('node:fs');
const { readObject, resolveHead, resolveRef } = require('./git-objects');
const { readTextCapped } = require('./safe-read');
const { stripControl } = require('./sanitize');

// More commits than a sidebar can show, fewer than a pathological repository
// could make us read. The renderer slices further by its row budget.
const MAX_COMMITS = 64;

// Branch tips considered, before the renderer's lane budget cuts further.
const MAX_TIPS = 128;

// A subject longer than this cannot survive any pane layout; cap at the read
// boundary so layout budgets around a value, not a megabyte.
const SUBJECT_MAX = 200;

/**
 * @typedef {object} CommitRow
 * @property {string} oid
 * @property {string} shortHash   7 hex chars, git's default abbreviation floor.
 * @property {string} subject     First message line, control-stripped, capped.
 * @property {number} when        Committer time, seconds.
 * @property {number} lane        0-based lane of this commit's node.
 * @property {boolean[]} activeMask  Which lanes are live on this row (the
 *   renderer's `│` columns).
 * @property {number[]} joinLanes  Lanes this merge's extra parents run in —
 *   the renderer's join glyph, the merge scenario's evidence.
 * @property {boolean} closes     Another lane also expected this commit (a
 *   fork seen from below) and was folded into this one.
 */

/**
 * @typedef {object} History
 * @property {'ok'|'empty'|'unavailable'} state  'empty' = no commits anywhere.
 * @property {CommitRow[]} rows        Newest first.
 * @property {number} laneCount        Widest simultaneous lane use.
 * @property {number} droppedBranches  Tips beyond the lane budget, counted.
 */

/**
 * Parse the header of a commit object: tree, parents, committer time, subject.
 * @param {Buffer} data
 * @returns {{ parents: string[], when: number, subject: string }|null}
 */
function parseCommit(data) {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  if (!/^tree [0-9a-f]{40}|^tree [0-9a-f]{64}/m.test(header)) return null;
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40}|[0-9a-f]{64})$/gm)].map((m) => m[1]);
  const committer = /^committer [^\n]* (\d{1,12}) [+-]\d{4}$/m.exec(header);
  const when = committer ? Number(committer[1]) : 0;
  const body = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const firstLine = body.split('\n')[0] || '';
  const clean = stripControl(firstLine).trim();
  const cps = [...clean];
  const subject = cps.length <= SUBJECT_MAX ? clean : cps.slice(0, SUBJECT_MAX - 1).join('') + '…';
  return { parents, when, subject };
}

/**
 * Every local branch tip: loose refs under refs/heads plus packed-refs
 * entries, deduplicated, HEAD's target included even when detached.
 * @param {string} gitDir
 * @returns {string[]}  Tip oids, unordered.
 */
function branchTips(gitDir) {
  /** @type {Set<string>} */
  const tips = new Set();
  const headsDir = path.join(gitDir, 'refs', 'heads');
  /** @type {Array<{ dir: string, ref: string }>} */
  const stack = [{ dir: headsDir, ref: 'refs/heads' }];
  let visited = 0;
  while (stack.length > 0 && tips.size < MAX_TIPS) {
    const top = /** @type {{ dir: string, ref: string }} */ (stack.pop());
    /** @type {fs.Dirent[]} */
    let dirents = [];
    try { dirents = fs.readdirSync(top.dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      visited += 1;
      if (visited > MAX_TIPS * 4) break;
      if (d.isDirectory()) stack.push({ dir: path.join(top.dir, d.name), ref: top.ref + '/' + d.name });
      else if (d.isFile()) {
        const oid = resolveRef(gitDir, top.ref + '/' + d.name);
        if (oid) tips.add(oid);
      }
    }
  }
  const packed = readTextCapped(path.join(gitDir, 'packed-refs'), 4 * 1024 * 1024);
  if (packed) {
    for (const line of packed.split('\n')) {
      if (tips.size >= MAX_TIPS) break;
      const m = /^([0-9a-f]{40}|[0-9a-f]{64}) refs\/heads\/\S+$/.exec(line.trim());
      // A loose ref shadows its packed entry; resolveRef already prefers it,
      // and adding the packed oid too would resurrect a stale tip. Only tips
      // whose ref has no loose file get taken from here — approximated by the
      // Set: a shadowed packed oid that differs would add a phantom tip, so
      // resolve the ref properly instead.
      if (m) {
        const ref = line.trim().slice(line.trim().indexOf(' ') + 1);
        const oid = resolveRef(gitDir, ref);
        if (oid) tips.add(oid);
      }
    }
  }
  const head = resolveHead(gitDir);
  if (head) tips.add(head);
  return [...tips];
}

/**
 * Read recent history: tips, walk, lanes.
 *
 * @param {string} gitDir
 * @param {{ maxLanes?: number, maxRows?: number }} [opts]
 * @returns {History}
 */
function readHistory(gitDir, opts = {}) {
  const maxLanes = opts.maxLanes && opts.maxLanes > 0 ? opts.maxLanes : 6;
  const maxRows = opts.maxRows && opts.maxRows > 0 ? Math.min(opts.maxRows, MAX_COMMITS) : MAX_COMMITS;

  const tips = branchTips(gitDir);
  if (tips.length === 0) {
    // No refs anywhere. An unborn HEAD (fresh init) is the EMPTY state the
    // no-commits scenario names; an unreadable HEAD is not.
    const raw = readTextCapped(path.join(gitDir, 'HEAD'), 4096);
    const unborn = raw !== null && /^ref:[ \t]*refs\//.test(raw.split('\n')[0].trim());
    return { state: unborn ? 'empty' : 'unavailable', rows: [], laneCount: 0, droppedBranches: 0 };
  }

  // Load every tip commit; tips that no longer resolve to a commit degrade the
  // whole section (never guess at history).
  /** @type {Map<string, { parents: string[], when: number, subject: string }>} */
  const loaded = new Map();
  const load = (/** @type {string} */ oid) => {
    if (loaded.has(oid)) return loaded.get(oid) || null;
    const obj = readObject(gitDir, oid);
    if (obj === null || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    if (parsed === null) return null;
    loaded.set(oid, parsed);
    return parsed;
  };

  /** @type {Array<{ oid: string, when: number }>} */
  const tipList = [];
  for (const oid of tips) {
    const c = load(oid);
    if (c === null) return { state: 'unavailable', rows: [], laneCount: 0, droppedBranches: 0 };
    tipList.push({ oid, when: c.when });
  }
  tipList.sort((a, b) => b.when - a.when || (a.oid < b.oid ? -1 : 1));
  const taken = tipList.slice(0, maxLanes);
  // Tips sharing history with a taken tip still count as their own branch —
  // the scenario counts BRANCHES, and each tip is one.
  const droppedBranches = tipList.length - taken.length;

  // Date-ordered walk from the taken tips: a max-heap by committer time,
  // approximated with a sorted array (sizes here are tens, not thousands).
  /** @type {Array<{ oid: string, when: number }>} */
  const frontier = [...taken];
  /** @type {Set<string>} */
  const emitted = new Set();
  /** Lanes: the commit id each lane expects next (null = closed). */
  /** @type {Array<string|null>} */
  const lanes = [];
  /** @type {CommitRow[]} */
  const rows = [];
  let laneCount = 0;

  while (frontier.length > 0 && rows.length < maxRows) {
    frontier.sort((a, b) => b.when - a.when || (a.oid < b.oid ? -1 : 1));
    const next = /** @type {{ oid: string, when: number }} */ (frontier.shift());
    if (emitted.has(next.oid)) continue;
    const c = load(next.oid);
    if (c === null) return { state: 'unavailable', rows: [], laneCount: 0, droppedBranches };
    emitted.add(next.oid);

    // The leftmost lane expecting this commit; none → a new tip opens a lane.
    let lane = lanes.findIndex((l) => l === next.oid);
    let closes = false;
    if (lane === -1) {
      lane = lanes.findIndex((l) => l === null);
      if (lane === -1) { lanes.push(null); lane = lanes.length - 1; }
    } else {
      // Every OTHER lane expecting it folds into this one — a fork, viewed
      // from below.
      for (let i = 0; i < lanes.length; i += 1) {
        if (i !== lane && lanes[i] === next.oid) { lanes[i] = null; closes = true; }
      }
    }
    const first = c.parents[0] || null;
    lanes[lane] = first && !emitted.has(first) ? first : null;
    /** @type {number[]} */
    const joinLanes = [];
    for (const p of c.parents.slice(1)) {
      if (emitted.has(p)) continue;
      const existing = lanes.indexOf(p);
      if (existing !== -1) {
        // The merge's other line already runs in a lane; the join points there.
        joinLanes.push(existing);
        continue;
      }
      // Open the nearest free lane for it.
      let free = lanes.findIndex((l) => l === null);
      if (free === -1) {
        if (lanes.length >= maxLanes) continue;
        lanes.push(p);
        free = lanes.length - 1;
      } else {
        lanes[free] = p;
      }
      joinLanes.push(free);
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const activeMask = lanes.map((l) => l !== null);
    while (activeMask.length < lane + 1) activeMask.push(false);
    activeMask[lane] = true; // the node's own column is always drawn
    const active = activeMask.filter(Boolean).length;
    laneCount = Math.max(laneCount, Math.max(active, lane + 1));

    rows.push({
      oid: next.oid,
      shortHash: next.oid.slice(0, 7),
      subject: c.subject,
      when: c.when,
      lane,
      activeMask,
      joinLanes,
      closes,
    });
    for (const p of c.parents) {
      if (!emitted.has(p)) {
        const pc = load(p);
        if (pc === null) return { state: 'unavailable', rows: [], laneCount: 0, droppedBranches };
        frontier.push({ oid: p, when: pc.when });
      }
    }
  }

  return { state: 'ok', rows, laneCount: Math.min(laneCount, maxLanes), droppedBranches };
}

module.exports = { readHistory, branchTips, parseCommit, MAX_COMMITS };
