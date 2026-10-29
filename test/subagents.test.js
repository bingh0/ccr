// @ts-check
'use strict';
// test/subagents.test.js — the derivation layer, against Claude Code's own
// record shapes.
//
// features/subagent-channels.feature pins the BEHAVIOUR (unknown shapes are
// skipped, drift degrades honestly, both tool names yield one roster). This
// file pins the record-by-record readings underneath it: which field feeds
// which roster fact, and — the one that matters most — that the incremental
// tail and the CLI's full parse produce the SAME model, because they are one
// code path rather than two that happen to agree today.
//
// Fixtures come from test/steps/_subagent-fixture.js, whose templates were
// copied off a real 2.1.252 transcript rather than paraphrased. See
// docs/SUBAGENTS.md for which shapes were observed and which are
// reconstructed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readRoster, rosterView, createTail, tick, listChannels, subagentsDir,
  STALE_MS, RETIRE_MS,
} = require('../src/subagents');
const { buildSession } = require('./steps/_subagent-fixture');

/** A temp projects root, removed when the process exits. */
function projectsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-subagents-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'projects');
}

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const NOW = T0 + 60_000;

/** @param {import('../src/subagents').RosterModel} m @param {string} id */
const agent = (m, id) => {
  const a = m.agents.find((x) => x.id === id);
  assert.ok(a, `no agent ${id} in [${m.agents.map((x) => x.id).join(', ')}]`);
  return a;
};

test('the async launch result links a dispatch id to its agent id', () => {
  const s = buildSession(projectsRoot());
  s.dispatch({ toolUseId: 'toolu_01MYgGNQrNTfhLwokWuh3oxx', description: 'Map the auth flow', prompt: 'You are an explorer. Read the code first.', subagentType: 'explore', at: T0 });
  s.asyncLaunch({ toolUseId: 'toolu_01MYgGNQrNTfhLwokWuh3oxx', agentId: 'a4e4cc6b8ee1a633e', at: T0 + 1500 });

  const m = readRoster(s.transcript, { now: NOW });
  assert.strictEqual(m.agents.length, 1, 'one dispatch and its launch are ONE agent, not two');
  const a = agent(m, 'a4e4cc6b8ee1a633e');
  assert.strictEqual(a.dispatchId, 'toolu_01MYgGNQrNTfhLwokWuh3oxx');
  assert.strictEqual(a.type, 'explore');
  assert.strictEqual(a.task, 'Map the auth flow');
  assert.strictEqual(a.spawnedAt, T0, 'spawn time is the DISPATCH, not the launch acknowledgement');
  assert.strictEqual(a.state, 'live', 'a launch acknowledgement is not a completion');
});

test('a dispatch still rosters before its agent id arrives', () => {
  // N15: a new spawn must reach the roster within one tick, and the record
  // naming its agentId can be a line or two behind.
  const s = buildSession(projectsRoot());
  s.dispatch({ toolUseId: 'toolu_01Pending', at: T0 });

  const m = readRoster(s.transcript, { now: NOW });
  assert.strictEqual(m.agents.length, 1);
  assert.strictEqual(m.agents[0].id, 'dispatch:toolu_01Pending');
  assert.strictEqual(m.agents[0].state, 'live');
});

test('a task notification completes the agent it names, keyed on tool-use-id', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01T1jA63qEvGN8bjNWoBpRcd', agentId: 'ae3a37762b32b772d', at: T0 });
  // Upstream emits the block twice: enqueue, then the user record that dequeues
  // it. The enqueue stamps when the agent actually stopped.
  s.notify({ toolUseId: 'toolu_01T1jA63qEvGN8bjNWoBpRcd', taskId: 'ae3a37762b32b772d', at: T0 + 20_000, via: 'queue' });
  s.notify({ toolUseId: 'toolu_01T1jA63qEvGN8bjNWoBpRcd', taskId: 'ae3a37762b32b772d', at: T0 + 29_000, via: 'user' });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'ae3a37762b32b772d');
  assert.strictEqual(a.state, 'done');
  assert.strictEqual(a.completedAt, T0 + 20_000, 'the enqueue stamp, not the later dequeue');
  assert.strictEqual(a.failure, null);
});

test('a background command notification matches no dispatch and rosters nothing', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Agent', agentId: 'a1111111111111111', at: T0 });
  // A background Bash command notifies in exactly the same shape, with a
  // task-id that is no agent's.
  s.notify({ toolUseId: 'toolu_01BashCmd', taskId: 'bz1r106j3', at: T0 + 5_000, summary: 'Background command "npm test" completed (exit code 0)' });

  const m = readRoster(s.transcript, { now: NOW });
  assert.deepStrictEqual(m.agents.map((a) => a.id), ['a1111111111111111']);
  assert.strictEqual(agent(m, 'a1111111111111111').state, 'live');
});

test('a status other than completed reads as a failure carrying the summary', () => {
  // RECONSTRUCTED: only `completed` was observed. Any other value is treated as
  // trouble, which is the fail-open direction — inventing "done" for a status
  // we do not recognize is the lie the feature exists to prevent.
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Doomed', agentId: 'a2222222222222222', at: T0 });
  s.notify({ toolUseId: 'toolu_01Doomed', taskId: 'a2222222222222222', at: T0 + 3_000, status: 'failed', summary: 'rate limited' });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'a2222222222222222');
  assert.strictEqual(a.state, 'failed');
  assert.strictEqual(a.failure, 'rate limited');
  assert.strictEqual(a.completedAt, T0 + 3_000);
});

test('a foreground tool_result completes a dispatch, and is_error makes it a failure', () => {
  // RECONSTRUCTED (docs/SUBAGENTS.md): 2.1.252 launches every Agent async.
  const s = buildSession(projectsRoot());
  s.dispatch({ toolUseId: 'toolu_01Fg', prompt: 'sync work', at: T0 });
  s.foregroundResult({ toolUseId: 'toolu_01Fg', at: T0 + 8_000, agentId: 'a3333333333333333', text: 'Finished the sync work.' });

  s.dispatch({ toolUseId: 'toolu_01FgBad', prompt: 'doomed work', at: T0 });
  s.foregroundResult({ toolUseId: 'toolu_01FgBad', at: T0 + 9_000, isError: true, text: 'rate limited' });

  const m = readRoster(s.transcript, { now: NOW });
  const okAgent = agent(m, 'a3333333333333333');
  assert.strictEqual(okAgent.state, 'done');
  assert.strictEqual(okAgent.completedAt, T0 + 8_000);
  const bad = agent(m, 'dispatch:toolu_01FgBad');
  assert.strictEqual(bad.state, 'failed');
  assert.strictEqual(bad.failure, 'rate limited');
});

test('nesting comes from the metadata sidecar and from the parent agent file alike', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Parent', agentId: 'a8f25d5c76399f8c2', at: T0, subagentType: 'explore' });
  // The child's dispatch lives in the PARENT AGENT's jsonl, not the session
  // transcript — which is the only place a nested spawn is visible.
  s.spawn({
    toolUseId: 'toolu_014eM37bnYS8DfxvAsQCLpME', agentId: 'a27991406df3ef2a1', at: T0 + 5_000,
    parentAgentId: 'a8f25d5c76399f8c2', spawnDepth: 2, description: 'Angle B removed-behavior audit',
  });

  const m = readRoster(s.transcript, { now: NOW });
  const child = agent(m, 'a27991406df3ef2a1');
  assert.strictEqual(child.parentId, 'a8f25d5c76399f8c2');
  assert.strictEqual(child.depth, 2);
  assert.strictEqual(agent(m, 'a8f25d5c76399f8c2').depth, 1);
  assert.strictEqual(m.agents.length, 2, 'the roster is FLAT — a nested agent holds its own row');
});

test('depth is derived from lineage when the sidecar never stated one', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01P', agentId: 'aparent000000000a', at: T0 });
  s.spawn({ toolUseId: 'toolu_01C', agentId: 'achild0000000000a', at: T0 + 1_000, parentAgentId: 'aparent000000000a' });
  // Upstream stopped stating spawnDepth: the lineage still answers.
  const meta = path.join(s.subagents, 'agent-achild0000000000a.meta.json');
  const raw = JSON.parse(fs.readFileSync(meta, 'utf8'));
  delete raw.spawnDepth;
  fs.writeFileSync(meta, JSON.stringify(raw));

  const m = readRoster(s.transcript, { now: NOW });
  assert.strictEqual(agent(m, 'achild0000000000a').depth, 2);
});

test('latest words are the newest text block; thinking is not words', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01W', agentId: 'awords0000000000a', at: T0 });
  s.agentTurn({ agentId: 'awords0000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });
  s.agentTurn({ agentId: 'awords0000000000a', at: T0 + 2_000, blocks: [{ type: 'thinking', thinking: 'I should not be quoted as words.', signature: 'sig' }] });
  s.agentTurn({ agentId: 'awords0000000000a', at: T0 + 3_000, blocks: [{ type: 'text', text: '   ' }] });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'awords0000000000a');
  assert.strictEqual(a.words, 'grepping src/auth', 'a thinking block never displaces the last real words');
  assert.strictEqual(a.wordsAt, T0 + 1_000);
  assert.ok(!String(a.words).includes('should not be quoted'));
});

test('a wordless agent still reports its latest tool call, summarized', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Q', agentId: 'aquiet0000000000a', at: T0 });
  s.agentTurn({ agentId: 'aquiet0000000000a', at: T0 + 1_000, blocks: [{ type: 'thinking', thinking: 'planning', signature: 'sig' }] });
  s.agentTurn({
    agentId: 'aquiet0000000000a', at: T0 + 2_000,
    blocks: [{ type: 'tool_use', id: 'toolu_01Bash', name: 'Bash', input: { command: 'npm test', description: 'Run the suite' } }],
  });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'aquiet0000000000a');
  assert.strictEqual(a.words, null, 'no words are invented');
  assert.strictEqual(a.lastTool, 'Bash');
  assert.strictEqual(a.lastToolArg, 'Run the suite', 'summarizeArg picks Bash\'s description');
  assert.strictEqual(a.lastToolAt, T0 + 2_000);
});

test('tokens sum input + output + cache creation, once per assistant MESSAGE', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Tok', agentId: 'atokens000000000a', at: T0 });
  // Upstream splits one message across three records, each repeating the same
  // usage. Summing per RECORD would treble this turn.
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 9_000, output_tokens: 5 };
  for (const blocks of [[{ type: 'text', text: 'one' }], [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.js' } }], [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/c.js' } }]]) {
    s.agentTurn({ agentId: 'atokens000000000a', at: T0 + 1_000, blocks, usage, msgId: 'msg_011Ced5h6NpmRPcvVCJXKa73' });
  }
  // A second, genuinely different message adds.
  s.agentTurn({
    agentId: 'atokens000000000a', at: T0 + 2_000, msgId: 'msg_011Ced5hMY91dn5s7SqWZbA8',
    blocks: [{ type: 'text', text: 'two' }],
    usage: { input_tokens: 1, cache_creation_input_tokens: 4, cache_read_input_tokens: 50_000, output_tokens: 2 },
  });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'atokens000000000a');
  assert.strictEqual(a.tokens, (10 + 100 + 5) + (1 + 4 + 2), 'cache READS are excluded; each message counts once');
});

test('records without timestamps roster without inventing one', () => {
  const s = buildSession(projectsRoot());
  s.dispatch({ toolUseId: 'toolu_01NoTs', prompt: 'timeless work', at: null });
  s.asyncLaunch({ toolUseId: 'toolu_01NoTs', agentId: 'anots00000000000a', at: null });
  s.notify({ toolUseId: 'toolu_01NoTs', taskId: 'anots00000000000a', at: null });

  const m = readRoster(s.transcript, { now: NOW });
  const a = agent(m, 'anots00000000000a');
  assert.strictEqual(a.spawnedAt, null);
  assert.strictEqual(a.completedAt, null);
  assert.strictEqual(a.state, 'done');
  assert.strictEqual(m.lastEventAt, null, 'no timestamp anywhere means no silence clock either');

  // R37: a completion nobody stamped NEVER retires — there is no upstream clock
  // to retire it against, and ccr refuses to substitute its own.
  const v = rosterView(m, { now: NOW + 86_400_000, slots: 4 });
  assert.strictEqual(v.retired, 0);
  assert.strictEqual(v.agents.length, 1);
});

test('malformed lines and unknown record types are skipped, never thrown on', () => {
  const s = buildSession(projectsRoot());
  s.raw(['{"type":"assistant", TRUNCATED', 'not json at all', '', '   ', 'null', '[]', '"a string"']);
  s.spawn({ toolUseId: 'toolu_01Sur', agentId: 'asurvive00000000a', at: T0 });
  s.raw([
    JSON.stringify({ type: 'holo-frame', timestamp: new Date(T0 + 1).toISOString(), payload: { agents: ['ghost'] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'quantum_use', name: 'Agent', id: 'toolu_ghost' }] } }),
    JSON.stringify({ timestamp: new Date(T0 + 2).toISOString(), no_type_at_all: true }),
  ]);
  s.attachment({ agentId: 'asurvive00000000a', at: T0 + 3 });

  const m = readRoster(s.transcript, { now: NOW });
  assert.deepStrictEqual(m.agents.map((a) => a.id), ['asurvive00000000a'],
    'unknown shapes contribute no rows, and the recognized agent survives beside them');
});

test('the older Task tool name yields exactly the roster Agent produces', () => {
  const root = projectsRoot();
  const mk = (/** @type {'Agent'|'Task'} */ tool, /** @type {string} */ sid) => {
    const s = buildSession(root, { sid });
    s.spawn({ toolUseId: 'toolu_01Same', agentId: 'asame00000000000a', at: T0, prompt: 'Map the auth flow', subagentType: 'explore', tool });
    s.agentTurn({ agentId: 'asame00000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });
    return readRoster(s.transcript, { now: NOW });
  };
  const withAgent = mk('Agent', 'aaaaaaaa-0000-4000-8000-000000000001');
  const withTask = mk('Task', 'aaaaaaaa-0000-4000-8000-000000000002');
  assert.deepStrictEqual(withTask.agents, withAgent.agents);
});

test('a subagent_type absent from the dispatch defaults rather than blanking', () => {
  const s = buildSession(projectsRoot());
  s.dispatch({ toolUseId: 'toolu_01NoType', subagentType: null, at: T0 });
  assert.strictEqual(readRoster(s.transcript, { now: NOW }).agents[0].type, 'general-purpose');
});

test('a skill-driven agent completes on a notification that names only its task-id', () => {
  // Verified on 2.1.252 (adversarial review 2026-09-01): the Skill tool forks an
  // agent with no Agent dispatch anywhere, and its notification carries
  // `<task-id>` = agentId and NO `<tool-use-id>` line. Keyed on the tool-use id
  // alone, such an agent read as live forever on a real session.
  const s = buildSession(projectsRoot());
  s.meta({ agentId: 'a8f25d5c76399f8c2', description: '/code-review v0.1.0-rc.5..HEAD high', name: 'code-review', spawnDepth: 1 });
  s.agentPrompt({ agentId: 'a8f25d5c76399f8c2', prompt: 'Review target: rc.5..HEAD', at: T0 });
  s.agentTurn({ agentId: 'a8f25d5c76399f8c2', at: T0 + 1_000, blocks: [{ type: 'text', text: 'All angles are complete.' }] });
  s.notify({ taskId: 'a8f25d5c76399f8c2', at: T0 + 2_500, via: 'queue' });
  s.notify({ taskId: 'a8f25d5c76399f8c2', at: T0 + 2_512, via: 'user' });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'a8f25d5c76399f8c2');
  assert.strictEqual(a.state, 'done');
  assert.strictEqual(a.completedAt, T0 + 2_500, 'the enqueue stamp, not the dequeue');
});

test('the enqueue stamp outranks the dequeue, and a later enqueue replaces an earlier one', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Res', agentId: 'aresume000000000a', at: T0 });
  // Dequeue first in the file (a tail that started late can see them in this
  // order): the enqueue that follows must still win the stamp.
  s.notify({ toolUseId: 'toolu_01Res', taskId: 'aresume000000000a', at: T0 + 30_000, via: 'user' });
  s.notify({ toolUseId: 'toolu_01Res', taskId: 'aresume000000000a', at: T0 + 10_000, via: 'queue' });
  let a = agent(readRoster(s.transcript, { now: NOW }), 'aresume000000000a');
  assert.strictEqual(a.completedAt, T0 + 10_000, 'the enqueue is when the agent stopped; the dequeue is when Claude read it');

  // Resumed upstream and finished again: the LATEST finish is the fact. The
  // second notification carries the RESUME call's tool-use id, which matches
  // no dispatch (verified on 2.1.252) — the agent id is what follows it.
  s.notify({ toolUseId: 'toolu_01NU13cT7idVVb6jJnbdciUV', taskId: 'aresume000000000a', at: T0 + 50_000, via: 'queue' });
  a = agent(readRoster(s.transcript, { now: NOW }), 'aresume000000000a');
  assert.strictEqual(a.completedAt, T0 + 50_000);
  assert.strictEqual(a.state, 'done');
});

test('activity in the agent file after its completion reads as live again', () => {
  // A resumed agent works for a while before its second notification lands;
  // its own file is the truth in between. Measured on a real session: a normal
  // finish leaves the file ~1.5 s QUIETER than the enqueue, never later.
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Again', agentId: 'aagain0000000000a', at: T0 });
  s.agentTurn({ agentId: 'aagain0000000000a', at: T0 + 5_000, blocks: [{ type: 'text', text: 'first pass done' }] });
  s.notify({ toolUseId: 'toolu_01Again', taskId: 'aagain0000000000a', at: T0 + 6_500, via: 'queue' });
  assert.strictEqual(agent(readRoster(s.transcript, { now: NOW }), 'aagain0000000000a').state, 'done');

  s.agentTurn({ agentId: 'aagain0000000000a', at: T0 + 40_000, blocks: [{ type: 'text', text: 'resumed, re-checking' }] });
  const a = agent(readRoster(s.transcript, { now: NOW }), 'aagain0000000000a');
  assert.strictEqual(a.state, 'live', 'a record stamped after the finish means the agent is working again');
  assert.strictEqual(a.completedAt, null);
  assert.strictEqual(a.words, 'resumed, re-checking');
});

test('a skill-driven agent with no dispatch takes its task from its metadata, then its prompt', () => {
  // Verified on disk: `{"agentType":…,"description":"/code-review …","name":"code-review","spawnDepth":1}`
  // and no toolUseId at all, so the agent exists only as a file plus metadata.
  // The owner's amended R10 (2026-09-02) says such an agent keeps its metadata
  // DESCRIPTION first — it is the only description it has, there being no
  // dispatch — and falls back to its own opening prompt when the metadata
  // carries none. Both halves are pinned here, in one world, because a build
  // that honoured only one of them would still look right from the other side.
  const s = buildSession(projectsRoot());
  s.meta({ agentId: 'askill0000000000a', description: '/code-review v0.1.0-rc.5..HEAD high', name: 'code-review', spawnDepth: 1 });
  s.agentPrompt({ agentId: 'askill0000000000a', prompt: 'Review target: rc.5..HEAD', at: T0 });
  s.meta({ agentId: 'askill0000000000b', description: '', name: 'code-review', spawnDepth: 1 });
  s.agentPrompt({ agentId: 'askill0000000000b', prompt: 'Review target: HEAD~3..HEAD', at: T0 });

  const m = readRoster(s.transcript, { now: NOW });
  const a = agent(m, 'askill0000000000a');
  assert.strictEqual(a.task, '/code-review v0.1.0-rc.5..HEAD high');
  assert.strictEqual(a.dispatchId, null);
  assert.strictEqual(a.state, 'live');
  assert.strictEqual(agent(m, 'askill0000000000b').task, 'Review target: HEAD~3..HEAD',
    'with no description anywhere, the opening prompt is the only words the agent has');
});

test('control characters are stripped at capture, in words and task alike', () => {
  const s = buildSession(projectsRoot());
  // The escape sequence rides the DESCRIPTION, which is what the task column
  // now reads (R10 as amended, 2026-09-02); the prompt carries one too, so the
  // fallback path is sanitized under the same assertion whichever one wins.
  s.spawn({ toolUseId: 'toolu_01Esc', agentId: 'aescape000000000a', at: T0, description: 'audit \x1b[31mconfig\x1b[0m files', prompt: 'audit \x1b[31mconfig\x1b[0m files' });
  s.agentTurn({ agentId: 'aescape000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'wrote \x1b]0;pwned\x07 the file' }] });

  const a = agent(readRoster(s.transcript, { now: NOW }), 'aescape000000000a');
  assert.ok(!/[\x00-\x1f\x7f]/.test(String(a.words)), `words still carry control bytes: ${JSON.stringify(a.words)}`);
  assert.ok(!/[\x00-\x1f\x7f]/.test(a.task), `task still carries control bytes: ${JSON.stringify(a.task)}`);
  assert.ok(String(a.words).includes('wrote') && String(a.words).includes('the file'), 'the words themselves survive');
});

test('the channel list is derived from the transcript path and skips non-files', () => {
  const s = buildSession(projectsRoot());
  s.spawn({ toolUseId: 'toolu_01Ch', agentId: 'achan00000000000a', at: T0 });
  // A directory named like an agent file, and a file that is not one.
  fs.mkdirSync(path.join(s.subagents, 'agent-adirectory00000a.jsonl'));
  fs.writeFileSync(path.join(s.subagents, 'notes.txt'), 'hello');

  assert.strictEqual(subagentsDir(s.transcript), s.subagents);
  const names = listChannels(s.transcript).map((c) => c.name);
  assert.deepStrictEqual(names, ['session', 'agent-achan00000000000a', 'agent-achan00000000000a.meta']);
});

test('the incremental tail across two ticks equals one full parse', () => {
  // The parity that matters: the pane's tail and the CLI's full parse are ONE
  // accumulator, so a fan-out read in pieces must equal the same fan-out read
  // whole. Anything sequence-sensitive in the fold shows up here.
  const root = projectsRoot();
  const s = buildSession(root, { sid: 'bbbbbbbb-0000-4000-8000-000000000001' });

  // Tick 1's world: two agents mid-flight, one nested.
  s.spawn({ toolUseId: 'toolu_01A', agentId: 'apar000000000000a', at: T0, subagentType: 'explore', prompt: 'map auth flow' });
  s.agentTurn({ agentId: 'apar000000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });
  s.spawn({ toolUseId: 'toolu_01B', agentId: 'akid000000000000a', at: T0 + 2_000, parentAgentId: 'apar000000000000a', spawnDepth: 2 });
  s.raw('{"malformed');

  const tail = createTail();
  tick(tail, s.transcript);
  const afterOne = tail.acc.model({ now: NOW });
  assert.strictEqual(afterOne.agents.length, 2, 'the tail sees the fan-out as it happens');

  // Tick 2's world: words, a nested tool call, one completion, one new spawn.
  s.agentTurn({ agentId: 'apar000000000000a', at: T0 + 10_000, blocks: [{ type: 'text', text: 'reading the router' }] });
  s.agentTurn({ agentId: 'akid000000000000a', at: T0 + 11_000, blocks: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'login' } }] });
  s.notify({ toolUseId: 'toolu_01B', taskId: 'akid000000000000a', at: T0 + 12_000 });
  s.spawn({ toolUseId: 'toolu_01C', agentId: 'anew000000000000a', at: T0 + 13_000 });
  tick(tail, s.transcript);

  const incremental = tail.acc.model({ now: NOW });
  const full = readRoster(s.transcript, { now: NOW });
  assert.deepStrictEqual(incremental.agents, full.agents);
  assert.strictEqual(incremental.lastEventAt, full.lastEventAt);
  assert.deepStrictEqual(
    incremental.channels.map((c) => [c.name, c.lastEventAt, c.readable]).sort(),
    full.channels.map((c) => [c.name, c.lastEventAt, c.readable]).sort(),
  );
});

test('a tail forced through many tiny reads still equals one full parse', () => {
  // The same parity under a byte budget so small that every channel is split
  // across ticks mid-file — the case where a sequence-sensitive fold breaks.
  //
  // The window stays comfortably wider than one record, because readNewLines
  // deliberately SKIPS a line longer than its cap to guarantee forward
  // progress (src/transcripts.js says so). A cap below the record size would
  // make this test measure that rule instead of parity.
  const s = buildSession(projectsRoot(), { sid: 'cccccccc-0000-4000-8000-000000000001' });
  for (let i = 0; i < 6; i++) {
    const id = `aloop${String(i).repeat(12)}`.slice(0, 17);
    s.spawn({ toolUseId: `toolu_01Loop${i}`, agentId: id, at: T0 + i * 100 });
    s.agentTurn({ agentId: id, at: T0 + i * 100 + 10, blocks: [{ type: 'text', text: `working ${i}` }] });
    if (i % 2 === 0) s.notify({ toolUseId: `toolu_01Loop${i}`, taskId: id, at: T0 + i * 100 + 20 });
  }

  const tail = createTail();
  let ticks = 0;
  while (tick(tail, s.transcript, { maxRead: 4096, budget: 4096 })) {
    if (++ticks > 500) break;
  }
  assert.ok(ticks > 3, `expected the budget to force several ticks, took ${ticks}`);
  assert.deepStrictEqual(tail.acc.model({ now: NOW }).agents, readRoster(s.transcript, { now: NOW }).agents);
});

test('a truncated transcript restarts the tail instead of double-counting', () => {
  const s = buildSession(projectsRoot(), { sid: 'dddddddd-0000-4000-8000-000000000001' });
  s.spawn({ toolUseId: 'toolu_01Trunc', agentId: 'atrunc0000000000a', at: T0 });
  s.agentTurn({ agentId: 'atrunc0000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'first pass' }], usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });

  const tail = createTail();
  tick(tail, s.transcript);
  assert.strictEqual(tail.acc.model({ now: NOW }).agents[0].tokens, 110);

  // The agent file is rewritten shorter — a rotation, as far as the tail knows.
  fs.writeFileSync(path.join(s.subagents, 'agent-atrunc0000000000a.jsonl'), '');
  s.agentTurn({ agentId: 'atrunc0000000000a', at: T0 + 2_000, blocks: [{ type: 'text', text: 'after rotation' }], usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  tick(tail, s.transcript);

  const m = tail.acc.model({ now: NOW });
  assert.strictEqual(m.agents[0].tokens, 10, 'the restart zeroed the totals rather than adding to them');
  assert.strictEqual(m.agents[0].words, 'after rotation');
});

test('a fifo in the subagents directory is skipped, not opened', (t) => {
  const s = buildSession(projectsRoot(), { sid: 'eeeeeeee-0000-4000-8000-000000000001' });
  s.spawn({ toolUseId: 'toolu_01Fifo', agentId: 'afifo00000000000a', at: T0 });
  const fifo = path.join(s.subagents, 'agent-afifo11111111a.jsonl');
  const r = require('node:child_process').spawnSync('mkfifo', [fifo]);
  if (r.status !== 0) return t.skip('mkfifo unavailable on this platform');

  // No timeout is needed to make the point: readFileSync on a fifo blocks
  // forever, so if this returns at all the guard held.
  const m = readRoster(s.transcript, { now: NOW });
  assert.deepStrictEqual(m.agents.map((a) => a.id), ['afifo00000000000a']);
  assert.ok(!m.channels.some((c) => c.name === 'agent-afifo11111111a'), 'the fifo never became a channel');
});

test('deriving a roster leaves not one byte behind', () => {
  // Statelessness is ruled (need N9) and "reading never disturbs the instance"
  // is a scenario of its own in subagent-mirror.feature. This is the behavioural
  // form of the guarantee rather than the textual one: no needle to rot, and it
  // covers a write through any API at all.
  const s = buildSession(projectsRoot(), { sid: '60000000-0000-4000-8000-000000000001' });
  s.spawn({ toolUseId: 'toolu_01RO', agentId: 'aread00000000000a', at: T0 });
  s.agentTurn({ agentId: 'aread00000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'reading only' }] });

  /** Every path under the session's tree, with the facts a write would move. */
  const census = (/** @type {string} */ dir) => {
    /** @type {string[]} */ const rows = [];
    const walk = (/** @type {string} */ d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { rows.push(`d ${p}`); walk(p); continue; }
        const st = fs.statSync(p);
        rows.push(`f ${p} ${st.size} ${st.mtimeMs}`);
      }
    };
    walk(dir);
    return rows.join('\n');
  };

  const before = census(path.dirname(s.transcript));
  readRoster(s.transcript, { now: NOW });
  const tail = createTail();
  tick(tail, s.transcript);
  tick(tail, s.transcript);
  assert.strictEqual(census(path.dirname(s.transcript)), before,
    'the derivation changed the tree it was only supposed to read');
});

test('rosterView retires a finish on the upstream clock and never on its own', () => {
  const s = buildSession(projectsRoot(), { sid: 'ffffffff-0000-4000-8000-000000000001' });
  s.spawn({ toolUseId: 'toolu_01Old', agentId: 'aold000000000000a', at: T0 });
  s.notify({ toolUseId: 'toolu_01Old', taskId: 'aold000000000000a', at: T0 + 1_000 });
  s.spawn({ toolUseId: 'toolu_01Fresh', agentId: 'afresh0000000000a', at: T0 });
  s.notify({ toolUseId: 'toolu_01Fresh', taskId: 'afresh0000000000a', at: T0 + 2_000 });

  const m = readRoster(s.transcript, { now: T0 });
  const justBefore = rosterView(m, { now: T0 + 1_000 + RETIRE_MS - 1, slots: 4 });
  assert.strictEqual(justBefore.agents.length, 2, 'a second early, the finish is still shown');

  const after = rosterView(m, { now: T0 + 1_000 + RETIRE_MS, slots: 4 });
  assert.deepStrictEqual(after.agents.map((a) => a.id), ['afresh0000000000a']);
  assert.strictEqual(after.retired, 1);
});

test('rosterView gives live agents the slots and finishes only the leftovers', () => {
  const s = buildSession(projectsRoot(), { sid: '10000000-0000-4000-8000-000000000001' });
  for (let i = 0; i < 2; i++) s.spawn({ toolUseId: `toolu_01L${i}`, agentId: `alive${i}0000000000a`.slice(0, 17), at: T0 + i });
  for (let i = 0; i < 6; i++) {
    const id = `adone${i}0000000000a`.slice(0, 17);
    s.spawn({ toolUseId: `toolu_01D${i}`, agentId: id, at: T0 + 10 + i });
    s.notify({ toolUseId: `toolu_01D${i}`, taskId: id, at: T0 + 1_000 + i });
  }

  const v = rosterView(readRoster(s.transcript, { now: T0 }), { now: T0 + 2_000, slots: 4 });
  assert.strictEqual(v.agents.filter((a) => a.state === 'live').length, 2, 'no finished agent displaces a live one');
  assert.strictEqual(v.agents.length, 4);
  // The leftovers are the NEWEST finishes: d5 (T0+1005) then d4 (T0+1004).
  assert.deepStrictEqual(v.agents.slice(2).map((a) => a.completedAt), [T0 + 1_005, T0 + 1_004]);
  assert.strictEqual(v.overflow, 4);
});

test('rosterView counts the overflow and names the live work beyond the cap', () => {
  const s = buildSession(projectsRoot(), { sid: '20000000-0000-4000-8000-000000000001' });
  const types = ['explore', 'explore', 'explore', 'explore', 'review', 'migrate', 'explore', 'explore'];
  types.forEach((type, i) => s.spawn({
    toolUseId: `toolu_01O${i}`, agentId: `aover${String(i).repeat(12)}`.slice(0, 17),
    at: T0 + i, subagentType: type,
  }));

  const v = rosterView(readRoster(s.transcript, { now: T0 }), { now: T0 + 100, slots: 4 });
  assert.strictEqual(v.agents.length, 4);
  assert.strictEqual(v.overflow, 4);
  assert.deepStrictEqual(v.overflowNames, ['review', 'migrate', 'explore', 'explore']);
  assert.ok(v.agents.every((a) => a.state === 'live'), 'every slot still holds a live agent');
});

test('rosterView marks silence stale only while an agent is still live', () => {
  const s = buildSession(projectsRoot(), { sid: '30000000-0000-4000-8000-000000000001' });
  s.spawn({ toolUseId: 'toolu_01S', agentId: 'astale0000000000a', at: T0 });
  s.agentTurn({ agentId: 'astale0000000000a', at: T0 + 1_000, blocks: [{ type: 'text', text: 'still here' }] });
  const m = readRoster(s.transcript, { now: T0 });
  // The clock is the newest upstream timestamp across EVERY channel read for
  // the session, not the newest word — so it is read off the model rather than
  // guessed from the record this test happened to write last.
  const last = /** @type {number} */ (m.lastEventAt);

  const quiet = rosterView(m, { now: last + STALE_MS, slots: 4 });
  assert.strictEqual(quiet.stale, true);
  assert.strictEqual(quiet.staleForMs, STALE_MS);
  assert.strictEqual(quiet.agents[0].words, 'still here', 'words FREEZE, never erase');

  const early = rosterView(m, { now: last + STALE_MS - 1 });
  assert.strictEqual(early.stale, false, 'one millisecond short of the threshold is not stale');

  // A finished roster has nothing left to be stale about.
  s.notify({ toolUseId: 'toolu_01S', taskId: 'astale0000000000a', at: T0 + 1_500 });
  const done = readRoster(s.transcript, { now: T0 });
  const doneLast = /** @type {number} */ (done.lastEventAt);
  assert.strictEqual(rosterView(done, { now: doneLast + STALE_MS, slots: 4 }).stale, false);
});

test('rosterView reports every unretired agent when no slot count is given', () => {
  // The CLI door has no row budget: "Retired agents are absent from both doors
  // alike" is about retirement, not about slots.
  const s = buildSession(projectsRoot(), { sid: '40000000-0000-4000-8000-000000000001' });
  for (let i = 0; i < 9; i++) s.spawn({ toolUseId: `toolu_01N${i}`, agentId: `anos${String(i).repeat(13)}`.slice(0, 17), at: T0 + i });

  const v = rosterView(readRoster(s.transcript, { now: T0 }), { now: T0 + 100 });
  assert.strictEqual(v.agents.length, 9);
  assert.strictEqual(v.overflow, 0);
  assert.deepStrictEqual(v.overflowNames, []);
});

test('rosterView says empty when nothing survives, and ages every fact it shows', () => {
  const s = buildSession(projectsRoot(), { sid: '50000000-0000-4000-8000-000000000001' });
  const emptyView = rosterView(readRoster(s.transcript, { now: T0 }), { now: T0, slots: 4 });
  assert.strictEqual(emptyView.empty, true);
  assert.deepStrictEqual(emptyView.agents, []);
  assert.strictEqual(emptyView.stale, false, 'an empty roster is not a stale one');

  s.spawn({ toolUseId: 'toolu_01Age', agentId: 'aage000000000000a', at: T0 });
  s.agentTurn({ agentId: 'aage000000000000a', at: T0 + 60_000, blocks: [{ type: 'text', text: 'still going' }] });
  s.agentTurn({ agentId: 'aage000000000000a', at: T0 + 90_000, blocks: [{ type: 'tool_use', id: 'tu', name: 'Read', input: { file_path: '/a/auth.js' } }] });

  const v = rosterView(readRoster(s.transcript, { now: T0 }), { now: T0 + 300_000, slots: 4 });
  assert.strictEqual(v.empty, false);
  assert.strictEqual(v.agents[0].ageMs, 300_000);
  assert.strictEqual(v.agents[0].wordsAgeMs, 240_000);
  assert.strictEqual(v.agents[0].toolAgeMs, 210_000);
});
