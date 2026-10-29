// @ts-check
'use strict';
// Step definitions for features/subagent-mirror.feature.
//
// This feature's subject is a COMMAND, so every scenario runs the real one:
// `spawnSync(node, bin/ccr.js, …)` against a sandbox HOME holding a real
// `~/.ccr/instances/<n>/` (owner pid, name, launch-cwd, the snapshot
// `ccr statusline` leaves behind) and a real `~/.claude/projects` tree in
// Claude Code's own record shapes (test/steps/_subagent-fixture.js). Nothing is
// stubbed and nothing is called in-process: exit codes, stdout and stderr are
// observed the way a script consuming this door observes them. The harness is
// test/steps/instance-resolution.steps.js's, which is the file that already
// proves the resolution chain against a disk rather than against a mock.
//
// RESOLUTION IS BY NAME, and the scenarios write `-i 2`. So the instance under
// test is NAMED "2" — a legal instance name — and the command really runs with
// those two arguments. "No ninth instance exists" is therefore fewer than nine
// live instances with none of them named 9, which is the world the chain
// actually refuses.
//
// PARITY IS MEASURED, NOT ASSERTED. "The reading matches the pane fact for
// fact" renders the SAME world through `composeFrame(stateDir, { view: 3 })` —
// the call the draw loop makes — parses the blocks the pane drew, and compares
// each one against the JSON agent carrying the same task: type, state glyph
// against state, the age string against `fmtAge(ageMs)`, the token column
// against `tok(tokens)`, the activity row's words against `words`. Comparing
// the two DOORS rather than either door against a fixture is the whole point:
// a build where both drifted the same way is still a mirror, and a build where
// one drifted is caught whichever one moved.
//
// TIME IS PINNED ON BOTH SIDES. The pane takes `now` as an option; the command
// is a subprocess and takes it through `CCR_NOW`, the test seam documented at
// `pinnedNow` in bin/ccr.js. Without one instant behind both doors the
// comparison would be a race between a fixture stamped at spawn time and a
// child process started a few milliseconds later — flaky in exactly the
// direction that teaches people to rerun the suite.
//
// THREE THINGS ABOUT THE WORLD ARE PINNED, for the reasons subagents-view.steps
// states at length: HOME/USERPROFILE (so `projectsDir()` and the instance
// container resolve into the sandbox and never into the developer's real
// ~/.claude), CCR_CONFIG (so a pane configured on the developer's machine
// cannot lengthen the view cycle the parity render draws through), and the pane
// width and height (so no fixture string is shortened by the terminal the suite
// happens to run in).
//
// MUTATION LOG — 27 mutants, each applied to the production source or to the
// fixture world, run, and reverted. Recorded because a binding no world can
// make red is hollow. The scenario each one turned red is named after the
// arrow; the one that stayed GREEN is at the bottom, and it was a finding about
// this file.
//
//   bin/ccr.js
//     `instance` emitted after `stale`, not first  -> -i answers headed by the
//                                                     name it resolved
//     `slots: 2` passed to rosterView instead of
//       null (the pane's cap put on the CLI)       -> the parity scenario
//     `words` dropped from the projection          -> parity
//     `tokens` dropped from the projection         -> parity
//     `state` dropped from the projection          -> parity
//     `task` dropped from the projection           -> parity, the retirement,
//                                                     the aggregate
//     `ageMs` taken from the words clock           -> parity
//     `parentId` dropped from the projection       -> no pane-visible fact is
//                                                     missing (the second Then
//                                                     of the parity scenario:
//                                                     the pane never draws a
//                                                     parent id, so only that
//                                                     Then can catch it)
//     `depth` dropped from the projection          -> the same Then
//     `lastToolArg` dropped from the projection    -> the same Then
//     `stale`/`staleForMs` hard-coded false/null   -> silence reaches the reader
//     `transcript` always null                     -> the empty roster
//     `--all` reading only the first live instance -> the aggregate rolls up 3
//     `--all` labelling every entry `slot N`       -> each roster is labelled
//     `--debug` omitting the meta channels         -> the debug flag lists every
//                                                     channel
//     `lastEventAgeMs` as the raw timestamp        -> each channel carries its
//                                                     last event age
//     an undated channel's age reported as 0       -> the same Then
//     a `subagents-read` marker written into the
//       state dir before printing                  -> reading never disturbs
//     a parse cache written beside the transcript  -> reading never disturbs
//                                                     (the projects half of the
//                                                     census, which the state
//                                                     dir's half cannot see)
//     an unresolvable -i returning exit 0 and `{}` -> it exits nonzero
//     CCR_NOW ignored, so the child clocks itself  -> parity, silence, the
//                                                     retirement
//
//   src/instance-resolve.js
//     the flag name dropped from the refusal       -> stderr names the -i flag
//
//   src/subagents.js
//     retirement disabled in `rosterView`          -> retired agents are absent
//                                                     from both doors alike
//     RETIRE_MS raised to a day                    -> the same (see below)
//     STALE_MS raised to five minutes              -> silence reaches the reader
//
//   the fixture world
//     the retired agent's finish stamped 10 s ago  -> the retirement (the
//                                                     control arm: it proves
//                                                     the refusal can see the
//                                                     agent when it is there)
//     a fourth live instance added                 -> the aggregate rolls up 3
//     the empty session given a fan-out            -> it exits 0 with an empty
//                                                     roster
//
// ONE MUTANT SURVIVED FIRST TIME, and it was a finding about this file. Raising
// RETIRE_MS to a day left "Retired agents are absent from both doors alike"
// GREEN, because the fixture stamped its finishes at `RETIRE_MS + 120_000` ago
// — derived from the very constant under test, so the world moved with the
// policy and the scenario kept measuring a retired agent no matter what the
// policy said. The stamps are absolute now (ten minutes and ten seconds), and
// the Given CHECKS them against the shipped clock, so a policy that outgrew
// them fails where a human can read why. The mutant now fails, and so does a
// second one that disables retirement outright.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { composeFrame } = require('../../src/sidecar');
const { __resetRosterState, listChannels, RETIRE_MS, STALE_MS } = require('../../src/subagents');
const { GLYPH, fmtSilence } = require('../../src/render/subagents');
const { tok } = require('../../src/render/shared');
const { fmtAge } = require('../../src/liveness');
const slots = require('../../src/instance-slot');
const { buildSession } = require('./_subagent-fixture');
const { refuteWithControl } = require('./_absence');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');

/** The view index the subagent roster occupies (economy 0, git 1, feed 2). */
const SUBAGENTS_VIEW = 3;

/**
 * A fixed instant. Every age, retirement clock and staleness window below is
 * measured from it — on BOTH sides of the mirror — so nothing here depends on
 * when the suite runs or on how long the child process took to start.
 */
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

/** Wide enough that no fixture string is ever shortened by accident. */
const COLS = 72;

/** Tall enough that the pane's slot cap never cuts one of these rosters. */
const ROWS = 40;

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A head row: two spaces, an optional lineage prefix, a state glyph. */
const HEAD_RE = /^ {2}(└ )?([●✓✗]) (.*?) {2,}(\S+) {2}(\S+)$/;

/** An activity row: four spaces, the body, two spaces, its age marker. */
const ACT_RE = /^ {4}(.+?) {2}(\S+)$/;

/**
 * Glyph → state. Written out rather than derived so this file states what it
 * expects to see, and checked against the renderer's own table at the one step
 * that uses it: a glyph that changed under us must fail loudly here rather than
 * map every block to the same state.
 */
const STATE_BY_GLYPH = { '●': 'live', '✓': 'done', '✗': 'failed' };

/**
 * Every field the reading owes per agent (the build brief's list, which is the
 * pane's visible facts plus the identity and lineage a machine reader needs).
 * "No pane-visible fact is missing" is checked against this, so a field dropped
 * from the projection fails rather than reading as an absent value.
 */
const AGENT_FIELDS = [
  'id', 'type', 'task', 'state', 'spawnedAt', 'ageMs', 'completedAt', 'tokens',
  'words', 'wordsAgeMs', 'lastTool', 'lastToolArg', 'toolAgeMs', 'parentId',
  'depth', 'failure',
];

/**
 * The live agents a fan-out scenario draws from, in order. Types, tasks, token
 * counts and words are all distinct: a comparison between two doors is only
 * worth running if mixing two rows up would show.
 */
const LIVE_SPECS = [
  { type: 'explore', task: 'map the auth flow', tokens: 18000, words: 'reading src/auth', ageMs: 3 * 60_000, wordsAgoMs: 5_000 },
  { type: 'review', task: 'review the installer', tokens: 3200, words: 'checking installer.ts', ageMs: 7 * 60_000, wordsAgoMs: 12_000 },
  { type: 'audit', task: 'audit the removed behaviour', tokens: 640, words: 'listing the fixtures', ageMs: 9 * 60_000, wordsAgoMs: 20_000 },
];

/**
 * The finished agents. `doneAgoMs` is inside RETIRE_MS on purpose — this
 * scenario is about parity, not retirement, and a finish that retired mid-run
 * would leave the two doors agreeing about nothing.
 */
const FINISHED_SPECS = [
  { type: 'migrate', task: 'move the fixtures', tokens: 900, words: 'fixtures moved', ageMs: 12 * 60_000, wordsAgoMs: 10 * 60_000, doneAgoMs: 20_000 },
  { type: 'docs', task: 'rewrite the contract page', tokens: 1500, words: 'contract page rewritten', ageMs: 15 * 60_000, wordsAgoMs: 11 * 60_000, doneAgoMs: 30_000 },
];

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineSubagentMirrorSteps(reg) {
  // ── The world ─────────────────────────────────────────────────────────────

  /**
   * A sandbox home laid out the way a real one is: `~/.claude/projects` for the
   * transcripts and `~/.ccr/instances` for the instances. HOME and USERPROFILE
   * are set in THIS process as well as in every child, because the parity
   * scenario renders the pane in-process and `projectsDir()` goes through
   * `os.homedir()`.
   *
   * realpath: macOS's tmpdir is a symlink (/var → /private/var) and a child's
   * `process.cwd()` is always physical, so an unresolved sandbox path would
   * fail the chain's cwd containment for a reason that is not the chain's.
   */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (w.home) return w;
    w.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-mir-')));
    w.home = path.join(w.root, 'home');
    w.projects = path.join(w.home, '.claude', 'projects');
    fs.mkdirSync(w.projects, { recursive: true });
    fs.mkdirSync(path.join(w.home, '.ccr', 'instances'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
    w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));

    for (const key of ['HOME', 'USERPROFILE']) {
      const prev = process.env[key];
      process.env[key] = w.home;
      w.defer(() => { if (prev == null) delete process.env[key]; else process.env[key] = prev; });
    }

    // An empty pane list, through the production config reader: a pane
    // configured on the developer's machine would lengthen the view cycle and
    // put a position marker on the roster the parity render is parsing.
    w.configFile = path.join(w.root, 'config.json');
    fs.writeFileSync(w.configFile, JSON.stringify({ panes: [] }));
    const prevCfg = process.env.CCR_CONFIG;
    process.env.CCR_CONFIG = w.configFile;
    w.defer(() => { if (prevCfg == null) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prevCfg; });

    // The roster tail is module-level by design (src/subagents.js says so at
    // its declaration), so the in-process pane render is isolated on the way in
    // and on the way out.
    __resetRosterState();
    w.defer(() => __resetRosterState());

    w.nextSlot = 1;
    w.now = T0;
    /** @type {Record<string, any>} */
    w.instances = Object.create(null);
    return w;
  };

  // Two independent counters, for the reason subagents-view.steps records: one
  // shared counter let a dispatch id repeat the previous agent's, which merges
  // two agents into one row and makes a roster quietly wrong.
  let agentSeq = 0;
  let dispatchSeq = 0;
  const agentId = () => `a${String(++agentSeq).padStart(16, '0')}`;
  const toolUseId = () => `toolu_01${String(++dispatchSeq).padStart(14, '0')}`;

  /**
   * A live instance: a slot dir with an owner pid this process guarantees is
   * alive, a name, a launch dir, and the snapshot `ccr statusline` writes —
   * whose `transcript_path` is the field this whole feature hangs on, since
   * `currentTranscriptPath` confines it and src/subagents.js derives the agents
   * directory from the confined path.
   *
   * @param {Record<string, any>} w
   * @param {string} name
   * @returns {{ name: string, stateDir: string, s: import('./_subagent-fixture').SessionFixture }}
   */
  const liveInstance = (w, name) => {
    world(w);
    const n = w.nextSlot++;
    const dir = path.join(w.home, '.ccr', 'instances', String(n));
    fs.mkdirSync(dir, { recursive: true });
    const launchCwd = path.join(w.home, 'trees', name);
    fs.mkdirSync(launchCwd, { recursive: true });
    const s = buildSession(w.projects, {
      sid: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`,
      slug: `-tmp-${n}`,
    });
    fs.writeFileSync(path.join(dir, slots.OWNER_FILE), `${process.pid}:${Date.now()}`);
    fs.writeFileSync(path.join(dir, 'name'), name + '\n');
    fs.writeFileSync(path.join(dir, 'launch-cwd'), launchCwd + '\n');
    fs.writeFileSync(path.join(dir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      transcript_path: s.transcript,
      workspace: { current_dir: launchCwd, project_dir: launchCwd },
      cwd: launchCwd,
      rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(T0 / 1000) + 3600 } },
      cost: { total_cost_usd: 1 },
    }));
    const rec = { name, stateDir: dir, s };
    w.instances[name] = rec;
    return rec;
  };

  /** The instance the `-i 2` scenarios address, and the pane the parity render draws. */
  const subject = (/** @type {Record<string, any>} */ w) => {
    if (!w.subject) w.subject = liveInstance(w, '2');
    return w.subject;
  };

  /**
   * A usage block worth exactly `n` tokens under the derivation's documented
   * formula (`input + output + cache_creation`). The cache READ figure is
   * non-zero on purpose: it must stay out of the total.
   */
  const usage = (/** @type {number} */ n) => ({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40000,
    output_tokens: n,
  });

  /**
   * One agent, complete: dispatch, launch link, metadata, its own file, one
   * assistant turn carrying its words and its tokens, and — for a finished one
   * — the task notification Claude Code stamps when it stops.
   *
   * @param {import('./_subagent-fixture').SessionFixture} s
   * @param {{ type: string, task: string, tokens: number, words: string,
   *   ageMs: number, wordsAgoMs: number, doneAgoMs?: number }} spec
   * @param {number} now
   */
  const putAgent = (s, spec, now) => {
    const id = agentId();
    const tuid = toolUseId();
    // The PROMPT says something else entirely, and it is the SAME something
    // for every agent: R10 as amended by the owner on 2026-09-02 puts Claude's
    // own dispatch DESCRIPTION in the task column, because on a real session
    // every prompt head reads alike. A door still reading the prompt would give
    // every agent the same task, and the parity comparison — which pairs a
    // pane block with the JSON agent carrying the same task — would collide on
    // the first pair instead of comparing anything.
    s.spawn({
      toolUseId: tuid, agentId: id, at: now - spec.ageMs, subagentType: spec.type,
      prompt: 'You are the builder for batch A. Read the brief first, then work, then report back.',
      description: spec.task,
    });
    s.agentTurn({
      agentId: id, at: now - spec.wordsAgoMs,
      blocks: [{ type: 'text', text: spec.words }], usage: usage(spec.tokens),
    });
    // The completion is stamped AFTER the agent's file goes quiet, which is
    // what a real finish looks like — a record newer than the completion reads
    // as the agent resuming (src/subagents.js, RESUMED).
    if (spec.doneAgoMs != null) s.notify({ toolUseId: tuid, taskId: id, at: now - spec.doneAgoMs });
    return id;
  };

  /**
   * Run the real CLI. CCR_STATE_DIR and CCR_SESSION are removed because the
   * resolution chain consults them before the cwd, and the suite's own shell
   * may carry either; CCR_NOW pins the child's clock to the same instant the
   * pane renders at.
   *
   * @param {Record<string, any>} w
   * @param {string[]} args
   */
  const runCcr = (w, args) => {
    world(w);
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      HOME: w.home,
      USERPROFILE: w.home,
      CCR_CONFIG: w.configFile,
      CCR_NOW: String(w.now),
    };
    delete env.CCR_STATE_DIR;
    delete env.CCR_SESSION;
    const r = spawnSync(process.execPath, [CCR_JS, ...args], {
      env, encoding: 'utf8', cwd: w.cwd || w.home, input: '',
    });
    const got = { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json: /** @type {any} */ (null) };
    try { got.json = JSON.parse(got.out); } catch { /* a refusal prints no JSON */ }
    w.got = got;
    return got;
  };

  /** One redraw of the roster, through the production compose call. */
  const draw = (/** @type {Record<string, any>} */ w, /** @type {string} */ stateDir) => {
    const out = plain(composeFrame(stateDir, {
      now: w.now, view: SUBAGENTS_VIEW, cols: COLS, rows: ROWS,
    }));
    w.frame = out;
    return out;
  };

  /**
   * The frame's block rows, split into the facts the head row carries. `type`
   * and `task` share the head row separated by two spaces, which is exactly how
   * src/render/subagents.js joins them.
   *
   * @param {string} f
   */
  const blocks = (f) => {
    const lines = f.split('\n');
    /** @type {{ glyph: string, type: string, task: string, age: string, tokens: string, words: string|null, wordsAge: string|null }[]} */
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const head = HEAD_RE.exec(lines[i]);
      if (!head) continue;
      const body = head[3].split(/ {2,}/);
      const act = ACT_RE.exec(lines[i + 1] || '');
      out.push({
        glyph: head[2],
        type: body[0],
        task: body.slice(1).join('  '),
        age: head[4],
        tokens: head[5],
        words: act ? act[1] : null,
        wordsAge: act ? act[2] : null,
      });
    }
    return out;
  };

  /**
   * A recursive census of a directory: every entry's relative path, and every
   * file's size and mtime. Reading a file touches its ATIME and nothing else,
   * so any difference here is a write.
   *
   * @param {string} dir
   * @returns {string[]}
   */
  const census = (dir) => {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
      /** @type {fs.Dirent[]} */
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const p = path.join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { out.push(`dir  ${r}`); walk(p, r); continue; }
        let st;
        try { st = fs.statSync(p); } catch { out.push(`gone ${r}`); continue; }
        out.push(`file ${r} ${st.size} ${st.mtimeMs}`);
      }
    };
    walk(dir, '');
    return out;
  };

  // ── Givens: worlds made of Claude Code's own records ──────────────────────

  reg.define(
    /^the fan-out of (\d+) live agents? and (\d+) finished agents? that the pane is rendering$/,
    (w, liveCount, finishedCount) => {
      const nLive = Number(liveCount);
      const nDone = Number(finishedCount);
      assert.ok(nLive <= LIVE_SPECS.length && nDone <= FINISHED_SPECS.length,
        `this file has ${LIVE_SPECS.length} live and ${FINISHED_SPECS.length} finished fixtures to spend`);
      const inst = subject(w);
      w.now = T0;
      /** @type {typeof LIVE_SPECS} */
      const specs = [...LIVE_SPECS.slice(0, nLive), ...FINISHED_SPECS.slice(0, nDone)];
      for (const spec of specs) putAgent(inst.s, spec, w.now);
      w.expectedBlocks = specs.length;
    },
  );

  reg.define(/^the transcript has been silent for (\d+) seconds while the session lives$/, (w, seconds) => {
    const silentMs = Number(seconds) * 1000;
    const inst = subject(w);
    w.now = T0;
    // A LIVE agent, because staleness is marked only while something is still
    // working — a roster of finished work has nothing left to be stale about
    // (src/subagents.js `rosterView`, and features/DESIGN.md's changelog).
    // Its newest record lands exactly `silentMs` before now, so the silence the
    // scenario names is the silence both doors measure.
    putAgent(inst.s, {
      type: 'explore', task: 'trace the deadlock', tokens: 2400,
      words: 'still reading the lock table', ageMs: silentMs + 120_000, wordsAgoMs: silentMs,
    }, w.now);
    w.expectedSilenceMs = silentMs;
    assert.ok(silentMs >= STALE_MS,
      `the scenario's ${seconds}s must reach the shipped staleness threshold (${STALE_MS}ms)`);
  });

  reg.define(/^an instance whose session has spawned no subagents$/, (w) => {
    const inst = subject(w);
    w.now = T0 + 5_000;
    // A REAL transcript with real turns in it, so "no subagents" is a statement
    // about a session ccr read rather than about a file it never found.
    inst.s.raw([
      JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'fix the tests' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }),
    ]);
  });

  reg.define(/^a finished agent retired from the pane roster under the shipped retirement policy$/, (w) => {
    const inst = subject(w);
    w.now = T0;
    // ABSOLUTE ages, deliberately not derived from RETIRE_MS. Written as
    // `RETIRE_MS + something` they tracked the constant, so raising the
    // retirement clock moved the fixture with it and this scenario stayed green
    // through a mutant that disabled retirement entirely — the exact hollowness
    // the mutation discipline exists to catch. The premise is CHECKED against
    // the shipped policy instead: a policy that moved past these stamps fails
    // here, where a human can read why, rather than silently measuring nothing.
    const RETIRED_AGO_MS = 10 * 60_000;
    const FRESH_AGO_MS = 10_000;
    assert.ok(RETIRED_AGO_MS >= RETIRE_MS && FRESH_AGO_MS < RETIRE_MS,
      `this scenario needs one finish past the shipped retirement clock (${RETIRE_MS}ms) and one inside it; `
      + `it stamps them ${RETIRED_AGO_MS}ms and ${FRESH_AGO_MS}ms ago`);
    putAgent(inst.s, {
      type: 'migrate', task: 'retired long ago and gone from the roster', tokens: 700,
      words: 'migration finished', ageMs: RETIRED_AGO_MS + 600_000, wordsAgoMs: RETIRED_AGO_MS + 300_000,
      doneAgoMs: RETIRED_AGO_MS,
    }, w.now);
    // THE WITNESS. A finish inside the retirement window, in the same world:
    // without it, a door that listed no finished agents at all would satisfy
    // the refusal below and prove nothing.
    putAgent(inst.s, {
      type: 'review', task: 'finished a moment ago and still on the roster', tokens: 1100,
      words: 'review posted', ageMs: 240_000, wordsAgoMs: 90_000, doneAgoMs: FRESH_AGO_MS,
    }, w.now);
    w.retiredTask = 'retired long ago and gone from the roster';
    w.freshTask = 'finished a moment ago and still on the roster';
    // The control arm for the refusal: the records themselves, which really do
    // carry the retired agent's task. If the needle ever stops matching what
    // the fixture wrote, the control goes red instead of the refusal going
    // quietly true.
    w.recordText = fs.readFileSync(inst.s.transcript, 'utf8');
  });

  reg.define(/^any live instance$/, (w) => {
    const inst = subject(w);
    w.now = T0;
    putAgent(inst.s, {
      type: 'explore', task: 'read the channel catalogue', tokens: 5000,
      words: 'catalogue read', ageMs: 180_000, wordsAgoMs: 15_000,
    }, w.now);
  });

  reg.define(/^live instances named ([\w-]+) and ([\w-]+)$/, (w, first, second) => {
    w.now = T0;
    for (const name of [String(first), String(second)]) {
      const inst = liveInstance(w, name);
      putAgent(inst.s, {
        type: 'explore', task: `work belonging to ${name}`, tokens: 1200,
        words: `words from ${name}`, ageMs: 120_000, wordsAgoMs: 10_000,
      }, w.now);
    }
  });

  reg.define(/^no ninth instance exists$/, (w) => {
    w.now = T0;
    // Fewer than nine live, and none of them named 9 — which is the world the
    // resolution chain refuses. Two are enough to prove the refusal is about
    // the NAME and not about an empty container.
    for (const name of ['first', 'second']) liveInstance(w, name);
    assert.ok(Object.keys(w.instances).length < 9 && !w.instances['9'],
      'the scenario needs fewer than nine live instances and none named 9');
  });

  reg.define(/^(\d+) live instances each holding its own fan-out$/, (w, count) => {
    w.now = T0;
    const names = ['alpha', 'beta', 'gamma', 'delta'].slice(0, Number(count));
    assert.strictEqual(names.length, Number(count), `this file can name ${Number(count)} instances`);
    for (const name of names) {
      const inst = liveInstance(w, name);
      putAgent(inst.s, {
        type: 'explore', task: `only ${name} dispatched this`, tokens: 800,
        words: `only ${name} said this`, ageMs: 150_000, wordsAgoMs: 12_000,
      }, w.now);
    }
    w.rosterNames = names;
  });

  // ── Whens: the real command ───────────────────────────────────────────────

  reg.define(/^ccr subagents -i (\S+) runs$/, (w, target) => {
    w.target = String(target);
    runCcr(w, ['subagents', '-i', String(target)]);
  });

  reg.define(/^ccr subagents -i (\S+) runs twice$/, (w, target) => {
    w.target = String(target);
    // The census brackets BOTH readings: the claim is about what the command
    // leaves behind, so it is measured across the whole of what it did.
    w.before = { state: census(subject(w).stateDir), projects: census(w.projects) };
    w.runs = [runCcr(w, ['subagents', '-i', String(target)]), runCcr(w, ['subagents', '-i', String(target)])];
    w.after = { state: census(subject(w).stateDir), projects: census(w.projects) };
  });

  reg.define(/^ccr subagents --all runs$/, (w) => {
    runCcr(w, ['subagents', '--all']);
  });

  reg.define(/^ccr subagents -i (\S+) --debug runs$/, (w, target) => {
    w.target = String(target);
    runCcr(w, ['subagents', '-i', String(target), '--debug']);
  });

  // ── Thens ─────────────────────────────────────────────────────────────────

  reg.define(/^the reading reports for every agent its type, task, state, age, token count and latest words$/, (w) => {
    // The glyph table this file reads the pane with, held to the renderer's own
    // — a glyph that changed underneath must fail here rather than silently map
    // every block to one state.
    for (const [state, glyph] of Object.entries(GLYPH)) {
      assert.strictEqual(/** @type {any} */ (STATE_BY_GLYPH)[glyph], state,
        `this file reads ${glyph} as ${/** @type {any} */ (STATE_BY_GLYPH)[glyph]}, the renderer draws it for ${state}`);
    }
    assert.strictEqual(w.got.code, 0, `the reading should succeed; stderr: ${w.got.err}`);
    assert.ok(w.got.json, `stdout should be one JSON object, got: ${w.got.out.slice(0, 200)}`);

    const drawn = blocks(draw(w, subject(w).stateDir));
    assert.strictEqual(drawn.length, w.expectedBlocks,
      `the pane should be rendering ${w.expectedBlocks} blocks; got:\n${w.frame}`);

    for (const b of drawn) {
      const a = w.got.json.agents.find((/** @type {any} */ x) => x.task === b.task);
      assert.ok(a, `the reading has no agent for the pane's task "${b.task}"; it lists `
        + JSON.stringify(w.got.json.agents.map((/** @type {any} */ x) => x.task)));
      assert.strictEqual(a.type, b.type, `type disagrees for "${b.task}"`);
      assert.strictEqual(a.state, /** @type {any} */ (STATE_BY_GLYPH)[b.glyph],
        `state disagrees for "${b.task}": pane drew ${b.glyph}`);
      assert.strictEqual(fmtAge(Math.max(0, a.ageMs)), b.age, `age disagrees for "${b.task}"`);
      assert.strictEqual(tok(a.tokens), b.tokens, `token count disagrees for "${b.task}"`);
      assert.strictEqual(a.words, b.words, `latest words disagree for "${b.task}"`);
      assert.strictEqual(fmtAge(Math.max(0, a.wordsAgeMs)), b.wordsAge,
        `the age of the latest words disagrees for "${b.task}"`);
    }
  });

  reg.define(/^no pane-visible fact is missing from the reading$/, (w) => {
    assert.ok(w.frame, 'the Then before this one renders the pane; this step compares against it');
    const drawn = blocks(w.frame);
    // The pane shows what its rows fit; the reading reports every agent
    // retirement left standing. So the reading may carry MORE, never fewer.
    assert.ok(w.got.json.agents.length >= drawn.length,
      `the pane drew ${drawn.length} agents and the reading lists ${w.got.json.agents.length}`);
    for (const a of w.got.json.agents) {
      const missing = AGENT_FIELDS.filter((f) => !Object.hasOwn(a, f));
      assert.deepStrictEqual(missing, [], `agent "${a.task}" is missing ${missing.join(', ')}`);
    }
  });

  reg.define(/^the reading marks the roster stale by the same staleness the pane shows$/, (w) => {
    assert.strictEqual(w.got.code, 0, w.got.err);
    assert.strictEqual(w.got.json.stale, true, 'the reading should mark the roster stale');
    assert.strictEqual(w.got.json.staleForMs, w.expectedSilenceMs,
      'the reading should measure the silence the fixture stamped');
    // The pane's marker, in the pane's own words, built from the READING's
    // number: the two doors are held to one silence, not to two that agree.
    const frame = draw(w, subject(w).stateDir);
    assert.ok(frame.includes(`stale · nothing new for ${fmtSilence(w.got.json.staleForMs)}`),
      `the pane should carry the same staleness; got:\n${frame}`);
  });

  reg.define(/^it exits 0 with an empty roster$/, (w) => {
    assert.strictEqual(w.got.code, 0, `an empty roster is not an error; stderr: ${w.got.err}`);
    assert.deepStrictEqual(w.got.json.agents, [], 'the roster should be empty');
    assert.strictEqual(w.got.json.live, 0);
    assert.strictEqual(w.got.json.finished, 0);
    // And it says WHICH empty: a session ccr read and found no agents in, not a
    // session it never found. The two are different facts and the field is what
    // tells a reader them apart.
    assert.strictEqual(typeof w.got.json.transcript, 'string',
      'the reading should name the transcript it read');
  });

  reg.define(/^the reading does not list that agent either$/, (w) => {
    assert.strictEqual(w.got.code, 0, w.got.err);
    const frame = draw(w, subject(w).stateDir);
    // Earned: the fresher finish in the same world IS on both doors, so a door
    // that simply dropped every finished agent cannot pass this step.
    assert.ok(w.got.json.agents.some((/** @type {any} */ a) => a.task === w.freshTask),
      `the reading should still list the fresh finish; it lists ${JSON.stringify(w.got.json.agents.map((/** @type {any} */ a) => a.task))}`);
    assert.ok(frame.includes(w.freshTask), `the pane should still show the fresh finish:\n${frame}`);

    refuteWithControl(w.retiredTask, JSON.stringify(w.got.json), w.recordText,
      'a retired agent must be absent from the reading, as it is from the pane');
    refuteWithControl(w.retiredTask, frame, w.recordText,
      'the pane retires it too — that is what "absent from both doors alike" means');
  });

  reg.define(/^neither reading writes anything into that instance's state dir$/, (w) => {
    for (const r of w.runs) {
      assert.strictEqual(r.code, 0, `a reading should succeed; stderr: ${r.err}`);
      assert.strictEqual(r.err, '', `a reading should say nothing on stderr; got: ${r.err}`);
    }
    assert.deepStrictEqual(w.after.state, w.before.state,
      'the instance\'s state dir must be byte-for-byte what it was before the readings');
    // The transcripts too. They are the thing being read, and a door that
    // cached its parse beside them would disturb the session just as surely.
    assert.deepStrictEqual(w.after.projects, w.before.projects,
      'the session\'s transcripts must be untouched by a reading');
  });

  reg.define(/^the output begins with ([\w-]+)'s name$/, (w, name) => {
    assert.strictEqual(w.got.code, 0, w.got.err);
    assert.strictEqual(Object.keys(w.got.json)[0], 'instance',
      'the resolved name must be the object\'s FIRST property — that is how a JSON door heads with it');
    assert.strictEqual(w.got.json.instance, String(name));
    // And literally so in the bytes, because a consumer reading the first line
    // of the output is reading text, not a parsed object.
    assert.ok(w.got.out.startsWith(`{\n  "instance": "${name}"`),
      `the output should open with the resolved name; got: ${JSON.stringify(w.got.out.slice(0, 80))}`);
  });

  reg.define(/^it exits nonzero$/, (w) => {
    assert.notStrictEqual(w.got.code, 0, `the refusal should fail; stdout: ${w.got.out}`);
  });

  reg.define(/^stderr names the -i flag and the failure$/, (w) => {
    assert.ok(w.got.err.includes(`-i ${w.target}`),
      `stderr should name the flag and what it was given; got: ${JSON.stringify(w.got.err)}`);
    assert.ok(w.got.err.includes(`no live instance named '${w.target}'`),
      `stderr should name the failure; got: ${JSON.stringify(w.got.err)}`);
  });

  reg.define(/^the reading contains all (\d+) rosters$/, (w, count) => {
    assert.strictEqual(w.got.code, 0, w.got.err);
    assert.ok(Array.isArray(w.got.json.instances), 'the aggregate is an array of readings');
    assert.strictEqual(w.got.json.instances.length, Number(count));
    for (const entry of w.got.json.instances) {
      assert.ok(Array.isArray(entry.agents), `${entry.instance} should carry a roster`);
      assert.strictEqual(entry.agents.length, 1, `${entry.instance} holds one agent in this world`);
    }
  });

  reg.define(/^each roster is labelled with its instance's name$/, (w) => {
    const labels = w.got.json.instances.map((/** @type {any} */ e) => e.instance);
    assert.deepStrictEqual(labels.slice().sort(), w.rosterNames.slice().sort(),
      'every live instance should appear, under its own name');
    for (const entry of w.got.json.instances) {
      const others = w.got.json.instances.filter((/** @type {any} */ e) => e !== entry);
      const mine = JSON.stringify(entry);
      for (const other of others) {
        // Earned: the sibling entry really does carry its own task, so the
        // needle is proven live before this roster is asked not to contain it.
        refuteWithControl(`only ${other.instance} dispatched this`, mine, JSON.stringify(other),
          `${entry.instance}'s roster must hold only its own agents`);
      }
    }
  });

  reg.define(/^the debug output lists every channel read for this instance$/, (w) => {
    assert.strictEqual(w.got.code, 0, w.got.err);
    // What the derivation itself enumerates for this session — asked of the
    // production function rather than restated here, so a channel the reader
    // gains must show up in the reading or fail.
    const expected = listChannels(subject(w).s.transcript).map((c) => c.name).sort();
    assert.ok(expected.length >= 3,
      `this world should have a session channel, an agent channel and its metadata; got ${JSON.stringify(expected)}`);
    const reported = w.got.json.channels.map((/** @type {any} */ c) => c.name).sort();
    assert.deepStrictEqual(reported, expected);
    for (const c of w.got.json.channels) {
      assert.strictEqual(typeof c.path, 'string', `${c.name} should name the file it was read from`);
      assert.strictEqual(c.readable, true, `${c.name} is readable in this world`);
    }
  });

  reg.define(/^each named channel carries its last event age$/, (w) => {
    let timestamped = 0;
    let undated = 0;
    for (const c of w.got.json.channels) {
      if (c.name.endsWith('.meta')) {
        // A metadata sidecar is a single JSON object with no timestamp in it, so
        // its freshness is unknown — reported as null rather than as an
        // invented zero, which would read as "written this instant".
        assert.strictEqual(c.lastEventAgeMs, null, `${c.name} carries no timestamp of its own`);
        undated += 1;
        continue;
      }
      assert.strictEqual(typeof c.lastEventAgeMs, 'number', `${c.name} should carry an age`);
      assert.ok(c.lastEventAgeMs >= 0 && c.lastEventAgeMs < 24 * 3600_000,
        `${c.name}'s age should be a plausible span, got ${c.lastEventAgeMs}`);
      timestamped += 1;
    }
    assert.ok(timestamped >= 2 && undated >= 1,
      `both kinds of channel should be present; got ${timestamped} dated and ${undated} undated`);
  });
};
