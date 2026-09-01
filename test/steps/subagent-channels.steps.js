// @ts-check
'use strict';
// Step definitions for features/subagent-channels.feature.
//
// This feature's subject is what happens when UPSTREAM changes, so every step
// drives the real derivation layer (src/subagents.js) against a real projects
// tree written in Claude Code's own record shapes
// (test/steps/_subagent-fixture.js, copied off a 2.1.252 transcript). Nothing
// is stubbed: the rosters below come from `readRoster`/`tick`, the same
// functions the pane and the CLI door call, and the doctor scenario runs the
// real `src/doctor.js`.
//
// Two things about the WORLD are pinned in the doctor scenario, both because
// the scenario says nothing about them and the developer's own machine
// otherwise would: PATH lookups (`has`) and the pane-config environment. Both
// are pinned IDENTICALLY for the before and the after run, so the comparison
// stays a statement about this feature's channels rather than about whether
// tmux happens to be installed.
//
// MUTATION LOG — each Then was watched going red before it was trusted, and
// two of the mutants stayed GREEN first time round. Both survivals were real
// findings about this file rather than about the code, and both are fixed
// above; they are recorded here because a mutant that survives is the only
// evidence a binding was hollow.
//
//   "the unknown records contribute no blocks" — doctored the world so the
//     appended records were a REAL Agent dispatch plus its async launch: the
//     roster grew from 2 blocks to 3 and the step failed on the count.
//   "every recognized agent still renders as before" — doctored the world so a
//     real task-notification completed the first agent. The first attempt
//     stamped it at T0, which RETIRED the agent and tripped the count
//     assertion in the step before this one; restamped inside the retirement
//     window it does what it was meant to, and the fact-by-fact comparison
//     failed on state and completedAt.
//   "each tick completes within one second of starting" — no world makes a
//     modern machine miss a one-second budget on 3 MB, so this one was mutated
//     at the bound: TICK_BUDGET_MS set to 0 turned every measured tick red
//     ("tick 1 of 3 took 16.3ms"), which also proves the loop really ran and
//     the numbers are measurements. The world-side half is the When's own
//     guard — mutated separately by shrinking the tick to a 4 KB budget, which
//     left 259 KB of the flood unread and failed on the offset. The
//     adversarial review then raised the per-file cap to 1 GB and the scenario
//     STAYED GREEN: the "spans several ticks" guard counted every tick, and
//     the loop always ends on one no-op tick, so it could never be below two.
//     It now counts ADVANCING ticks and pins the flood above the exported
//     cap; the same mutant fails on "advanced in 1".
//   "those dispatches appear as the same blocks Agent-name dispatches produce"
//     — doctored the Task-named session to dispatch a different subagent_type.
//     SURVIVED at first: the finished agent had been stamped at T0 and was
//     retired out of the view by the time the Then compared, so half the
//     fan-out was silently uncompared. Fixed by stamping the finish inside the
//     retirement window and comparing the MODEL as well as the view; the
//     mutant then failed on `type`.
//   "the view shows the \"no subagents\" line rather than invented blocks" —
//     doctored the drifted world to leave ONE dispatch in a shape ccr still
//     knows: `empty` went false and the step failed on the block count.
//   "doctor's checks and output are unchanged by this feature" — doctored
//     src/doctor.js to append a channel-health line counting the agent files
//     under its homedir. SURVIVED at first: the fixture's projects tree lived
//     beside the sandbox home rather than inside it, so a doctor that DID grow
//     a channel section would have been reading an empty directory. Fixed by
//     putting the tree at `<home>/.claude/projects` where a real one lives;
//     the mutant then failed on the added line. A second mutant whose line
//     reads the SAME before and after (so the equality holds) was caught by
//     the control-armed refusal alone, which is what that refusal is for.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRoster, createTail, tick, listChannels, PER_FILE_MAX } = require('../../src/subagents');
const { rosterView } = require('../../src/subagents');
const doctor = require('../../src/doctor');
const { buildSession } = require('./_subagent-fixture');
const { refuteWithControl } = require('./_absence');

/** A fixed instant, so ages and staleness are facts of the fixture, not of the clock. */
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const NOW = T0 + 120_000;

/** The pane's row budget stands in for "the slots" wherever a view is taken. */
const SLOTS = 4;

/** One redraw tick's budget, as the scenario states it. */
const TICK_BUDGET_MS = 1000;

/**
 * Records in shapes ccr has never seen. Every one is well-formed JSON that a
 * future Claude Code could plausibly write — the point is not that they are
 * broken but that they are UNRECOGNIZED, which is the case the fence says must
 * cost nothing.
 * @param {number} n
 * @param {number} at
 */
function unknownRecords(n, at) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(at + i).toISOString();
    switch (i % 5) {
      case 0:
        out.push(JSON.stringify({ type: 'holo-frame', timestamp: t, frame: { agents: ['ghostwriter'], depth: 3 } }));
        break;
      case 1:
        // The right words in the wrong place: an agent-shaped payload under a
        // type nothing dispatches on.
        out.push(JSON.stringify({ type: 'agent-telemetry', timestamp: t, agentId: `ghostwriter${i}`, subagent_type: 'ghostwriter', prompt: 'haunt the roster' }));
        break;
      case 2:
        // A known type carrying an unknown block kind.
        out.push(JSON.stringify({ type: 'assistant', timestamp: t, message: { id: `msg_g${i}`, role: 'assistant', content: [{ type: 'quantum_use', name: 'Agent', id: `toolu_ghost${i}`, input: { subagent_type: 'ghostwriter' } }] } }));
        break;
      case 3:
        out.push(JSON.stringify({ kind: 'lifecycle', timestamp: t, phase: 'reticulating', ordinal: i }));
        break;
      default:
        out.push(JSON.stringify({ type: 'attachment', timestamp: t, attachment: { type: 'system_reminder', content: 'nothing to see' } }));
    }
  }
  return out;
}

/** The facts a block shows, as a comparable tuple — "renders as before", in data. */
const facts = (/** @type {any} */ a) => [
  a.id, a.type, a.task, a.state, a.spawnedAt, a.completedAt, a.tokens,
  a.words, a.wordsAt, a.lastTool, a.lastToolArg, a.lastToolAt, a.parentId, a.depth, a.failure,
];

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineSubagentChannelsSteps(reg) {
  /**
   * A sandbox HOME laid out the way a real one is: `~/.claude/projects` for the
   * transcripts and `~/.ccr` for the instances. The projects tree sits INSIDE
   * the home on purpose — a doctor that grew a channel section would look
   * exactly there, so a tree parked somewhere else would let the doctor
   * scenario pass by accident (it did, until mutation-testing caught it).
   */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (w.projects) return w;
    w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-chan-'));
    w.home = path.join(w.root, 'home');
    w.projects = path.join(w.home, '.claude', 'projects');
    fs.mkdirSync(w.projects, { recursive: true });
    /** @type {Record<string, any>} */
    w.sessions = Object.create(null);
    w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    return w;
  };

  /** Register a session under a key so the shared When can derive every one. */
  const session = (/** @type {Record<string, any>} */ w, /** @type {string} */ key, /** @type {string} */ sid) => {
    world(w);
    const s = buildSession(w.projects, { sid, slug: '-tmp-work' });
    w.sessions[key] = s;
    return s;
  };

  /**
   * A fan-out ccr does recognize: two async agents, one with words, one with a
   * tool call — enough that "still renders as before" has something to say.
   * @param {any} s
   */
  const knownFanOut = (s) => {
    s.spawn({ toolUseId: 'toolu_01MYgGNQrNTfhLwokWuh3oxx', agentId: 'a4e4cc6b8ee1a633e', at: T0, subagentType: 'explore', prompt: 'map auth flow', description: 'Map the auth flow' });
    s.agentTurn({ agentId: 'a4e4cc6b8ee1a633e', at: T0 + 2_000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });
    s.spawn({ toolUseId: 'toolu_01NuWF5mrdUJwVndxvVaSbcs', agentId: 'a46da0936a61f362d', at: T0 + 3_000, prompt: 'fix failing tests', description: 'Fix failing tests' });
    s.agentTurn({ agentId: 'a46da0936a61f362d', at: T0 + 4_000, blocks: [{ type: 'tool_use', id: 'toolu_01B', name: 'Bash', input: { command: 'npm test', description: 'Run the suite' } }] });
  };

  /** The production derivation, exactly as a door calls it. */
  const derive = (/** @type {any} */ s) => {
    const model = readRoster(s.transcript, { now: NOW });
    return { model, view: rosterView(model, { now: NOW, slots: SLOTS }) };
  };

  // --- Givens ---

  reg.define(/^a transcript gaining records of a shape this ccr has never seen$/, (w) => {
    const s = session(w, 'known', '11111111-0000-4000-8000-000000000001');
    knownFanOut(s);
    // "As before" is measured BEFORE the unknown records arrive, through the
    // same production path the When uses — otherwise the comparison would be
    // against this file's idea of the roster rather than against ccr's.
    w.before = derive(s);
    w.unknown = unknownRecords(40, T0 + 10_000);
    s.raw(w.unknown);
    // Unknown shapes reach an agent's own file too, not just the session's.
    s.raw(unknownRecords(10, T0 + 11_000), 'a4e4cc6b8ee1a633e');
  });

  reg.define(/^a transcript consisting mostly of unrecognized record shapes$/, (w) => {
    const s = session(w, 'flood', '22222222-0000-4000-8000-000000000001');
    knownFanOut(s);
    // Thousands of them, and past the per-file read window on purpose: a tick
    // that quietly stopped reading would otherwise pass this scenario by doing
    // nothing at all.
    s.raw(unknownRecords(20_000, T0 + 10_000));
    s.raw(unknownRecords(4_000, T0 + 10_000), 'a4e4cc6b8ee1a633e');
    w.floodBytes = fs.statSync(s.transcript).size;
    // The flood must be LARGER than one tick's per-file window, or the bound
    // this scenario exists to exercise never engages and the ticks below measure
    // an ordinary read. Tied to the real constant so a raised cap fails here
    // instead of quietly emptying the scenario (adversarial review 2026-09-01:
    // an unbounded read survived the first version of this binding).
    assert.ok(w.floodBytes > PER_FILE_MAX,
      `the flood (${w.floodBytes} bytes) must exceed the per-file window (${PER_FILE_MAX})`);
  });

  reg.define(/^a transcript recording dispatches under Claude Code's older Task tool name$/, (w) => {
    // Two sessions identical in every respect but the tool NAME — the drift
    // case already observed in the wild (Claude Code 2.1.63 renamed Task to
    // Agent), so the comparison is exactly the rename and nothing else.
    for (const [key, tool, sid] of /** @type {[string, 'Task'|'Agent', string][]} */ ([
      ['task-named', 'Task', '33333333-0000-4000-8000-000000000001'],
      ['agent-named', 'Agent', '33333333-0000-4000-8000-000000000002'],
    ])) {
      const s = session(w, key, sid);
      s.spawn({ toolUseId: 'toolu_01Same', agentId: 'asame00000000000a', at: T0, subagentType: 'explore', prompt: 'map auth flow', description: 'Map the auth flow', tool });
      s.agentTurn({ agentId: 'asame00000000000a', at: T0 + 2_000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });
      // Recent enough to survive retirement: a finish stamped at T0 would be
      // gone from the view by NOW, and the comparison would quietly cover half
      // the fan-out (caught by mutation-testing this very step).
      s.notify({ toolUseId: 'toolu_01Same', taskId: 'asame00000000000a', at: NOW - 10_000 });
      s.spawn({ toolUseId: 'toolu_01Live', agentId: 'alive00000000000a', at: T0 + 4_000, prompt: 'fix failing tests', description: 'Fix failing tests', tool });
    }
  });

  reg.define(/^an upstream change that makes every known record shape unrecognizable$/, (w) => {
    const s = session(w, 'drift', '44444444-0000-4000-8000-000000000001');
    // Total drift: every record type renamed, the tool_use block renamed, the
    // completion block renamed — and the agent files themselves renamed out of
    // the pattern that makes them channels, so not one recognized byte is left.
    knownFanOut(s);
    const drifted = fs.readFileSync(s.transcript, 'utf8')
      .split('\n').filter(Boolean)
      .map((ln) => ln
        .replace(/"type":"assistant"/g, '"type":"assistant.v2"')
        .replace(/"type":"user"/g, '"type":"user.v2"')
        .replace(/"type":"tool_use"/g, '"type":"tool_use.v2"')
        .replace(/"type":"tool_result"/g, '"type":"tool_result.v2"')
        .replace(/"type":"queue-operation"/g, '"type":"queue.v2"')
        .replace(/task-notification/g, 'task-report'));
    fs.writeFileSync(s.transcript, drifted.join('\n') + '\n');
    w.driftedText = drifted.join('\n');
    for (const f of fs.readdirSync(s.subagents)) {
      fs.renameSync(path.join(s.subagents, f), path.join(s.subagents, f.replace(/^agent-/, 'worker-').replace(/\.jsonl$/, '.ndjson')));
    }
  });

  reg.define(/^channel reporting lives in the pane stale banner and ccr subagents --debug alone$/, (w) => {
    world(w);
    // One live instance with a captured status, so doctor has something real to
    // report on either side of the change.
    const inst = path.join(w.home, '.ccr', 'instances', '1');
    fs.mkdirSync(inst, { recursive: true });
    fs.writeFileSync(path.join(inst, 'name'), 'a\n');
    fs.writeFileSync(path.join(inst, 'owner'), `${process.pid}:${Date.now()}`);
    fs.writeFileSync(path.join(inst, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    }));

    // PATH lookups and the pane-config environment are properties of whoever
    // runs the suite, not of this feature, so both runs get the same pinned
    // answers. Everything else — the home scan, the status file, the repo
    // assets — is the real doctor reading the real world.
    w.runDoctor = () => {
      let out = '';
      doctor.run({ homedir: w.home, env: {}, has: () => null, write: (/** @type {string} */ s) => { out += s; } });
      return out;
    };
    w.doctorBefore = w.runDoctor();

    // NOW the channels exist in the world: a full fan-out under the projects
    // tree, with agent files, metadata sidecars and a completion.
    const s = session(w, 'doctor', '55555555-0000-4000-8000-000000000001');
    knownFanOut(s);
    s.notify({ toolUseId: 'toolu_01MYgGNQrNTfhLwokWuh3oxx', taskId: 'a4e4cc6b8ee1a633e', at: T0 + 5_000 });
    // Proof the channels are really there — otherwise "unchanged" would be the
    // trivially true statement that nothing happened.
    assert.strictEqual(listChannels(s.transcript).length, 5, 'the fixture must really have laid down channels');
  });

  // --- Whens ---

  reg.define(/^the roster derives$/, (w) => {
    /** @type {Record<string, any>} */
    w.rosters = Object.create(null);
    for (const key of Object.keys(w.sessions)) w.rosters[key] = derive(w.sessions[key]);
  });

  reg.define(/^redraw ticks fire under that feed$/, (w) => {
    const s = w.sessions['flood'];
    const tail = createTail();
    /** @type {number[]} */
    w.tickMs = [];
    let ticks = 0;
    let advancing = 0;
    // Tick the way the sidecar does — the real incremental tail, default
    // bounds — until the feed is consumed.
    for (;;) {
      const t = process.hrtime.bigint();
      const advanced = tick(tail, s.transcript);
      w.tickMs.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (advanced) advancing++;
      if (!advanced || ++ticks > 64) break;
    }
    w.floodView = rosterView(tail.acc.model({ now: NOW }), { now: NOW, slots: SLOTS });
    // FIXTURE INTEGRITY, not the criterion: a tick that read nothing would keep
    // any budget. The offsets must have walked the whole flood, and the two
    // recognized agents must have survived it.
    assert.strictEqual(tail.offsets['session'], w.floodBytes, 'the ticks left part of the flood unread');
    assert.strictEqual(w.floodView.agents.length, 2, 'the recognized agents did not survive the flood');
    // ADVANCING ticks, not ticks: the loop always ends on one no-op tick, so a
    // count of all ticks is never below two and proves nothing about the bound.
    assert.ok(advancing > 1, `expected the per-file window to split the flood across ticks; it advanced in ${advancing}`);
  });

  reg.define(/^ccr doctor runs on any instance$/, (w) => {
    w.doctorAfter = w.runDoctor();
  });

  // --- Thens ---

  reg.define(/^the unknown records contribute no blocks$/, (w) => {
    const after = w.rosters['known'];
    assert.strictEqual(after.view.agents.length, w.before.view.agents.length,
      `the roster grew from ${w.before.view.agents.length} to ${after.view.agents.length} blocks`);
    // Earned absence: the unknown records carry agent-shaped words on purpose
    // ("ghostwriter", a prompt, an Agent-named block under an unknown type), so
    // the witness is the records themselves and the subject is everything the
    // roster would show.
    refuteWithControl(
      /ghostwriter|haunt the roster|reticulating/,
      JSON.stringify(after.model) + JSON.stringify(after.view),
      w.unknown.join('\n'),
      'an unrecognized record reached the roster',
    );
  });

  reg.define(/^every recognized agent still renders as before$/, (w) => {
    const after = w.rosters['known'];
    assert.deepStrictEqual(after.view.agents.map(facts), w.before.view.agents.map(facts),
      'a recognized agent changed when unknown records arrived beside it');
    assert.strictEqual(after.view.stale, w.before.view.stale);
  });

  reg.define(/^each tick completes within one second of starting$/, (w) => {
    for (const [i, ms] of w.tickMs.entries()) {
      assert.ok(ms < TICK_BUDGET_MS, `tick ${i + 1} of ${w.tickMs.length} took ${ms.toFixed(1)}ms`);
    }
  });

  reg.define(/^those dispatches appear as the same blocks Agent-name dispatches produce$/, (w) => {
    const task = w.rosters['task-named'];
    const agent = w.rosters['agent-named'];
    assert.strictEqual(agent.view.agents.length, 2, 'the Agent-named control must show both blocks to compare against');
    assert.deepStrictEqual(task.model.agents.map(facts), agent.model.agents.map(facts));
    assert.deepStrictEqual(task.view.agents.map(facts), agent.view.agents.map(facts));
    assert.strictEqual(task.view.live, agent.view.live);
    assert.strictEqual(task.view.finished, agent.view.finished);
  });

  reg.define(/^the view shows the "no subagents" line rather than invented blocks$/, (w) => {
    const drift = w.rosters['drift'];
    // `empty` is the fact the roster view publishes for the "no subagents"
    // line; the line itself is the S2 renderer's wording of it. What binds
    // here is that total drift yields the empty truth rather than a roster
    // assembled out of records ccr no longer understands.
    assert.strictEqual(drift.view.empty, true, `expected an empty roster, got ${drift.view.agents.length} blocks`);
    assert.deepStrictEqual(drift.view.agents, []);
    assert.strictEqual(drift.model.agents.length, 0);
    // Earned absence: the drifted transcript still CONTAINS every agent fact —
    // the type, the prompt, the agent ids — so a parser that guessed would
    // spill one of them into the model. The witness is that transcript.
    refuteWithControl(
      /explore|map auth flow|a4e4cc6b8ee1a633e/,
      JSON.stringify(drift.model.agents) + JSON.stringify(drift.view.agents),
      w.driftedText,
      'a block was invented out of records ccr no longer recognizes',
    );
  });

  reg.define(/^doctor's checks and output are unchanged by this feature$/, (w) => {
    assert.strictEqual(w.doctorAfter, w.doctorBefore,
      'doctor said something different once the subagent channels existed');
    // Earned absence: the same words in a doctor that DID report channels are
    // the control, so this refusal cannot quietly become true by a rename.
    refuteWithControl(
      /subagent|agent-|channel/i,
      w.doctorAfter,
      '✓ subagent channels: 2 agent-file(s) readable\n· channel freshness 3s',
      'doctor grew a channel-health surface the fence excludes',
    );
  });
};
