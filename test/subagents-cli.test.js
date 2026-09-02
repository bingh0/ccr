// @ts-check
'use strict';
// test/subagents-cli.test.js — two promises `ccr subagents` makes that no
// scenario in features/subagent-mirror.feature spells out, pinned here because
// the adversarial review of 2026-09-02 implanted both mutants and the suite
// stayed green:
//
//   1. THE TRANSCRIPT PATH IS CONFINED. The snapshot is attacker-influenceable
//      (src/transcripts.js, currentTranscriptPath), so a `transcript_path`
//      outside ~/.claude/projects must yield no reading at all — not a roster
//      derived from whatever file the snapshot pointed at. Taking the raw
//      field instead of the confined one passed every scenario.
//   2. `--debug` IS THE ONLY STANDING SURFACE (R34: "zero standing surface
//      beyond this flag"). Without it the object carries no `channels` key.
//      Emitting the channels unconditionally passed every scenario too.
//
// Both run the REAL command through spawnSync against a sandbox home, the way
// the mirror's own steps do, and both carry a control arm: the same world with
// the path inside the tree (or the flag given) really does produce what the
// refusal denies.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../src/instance-slot');
const { buildSession } = require('./steps/_subagent-fixture');

const CCR_JS = path.join(__dirname, '..', 'bin', 'ccr.js');
const T0 = Date.parse('2026-09-02T00:00:00.000Z');

/** A sandbox home with one named live instance whose snapshot names `transcript`. */
function world(/** @type {import('node:test').TestContext} */ t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-subcli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projects = path.join(home, '.claude', 'projects');
  fs.mkdirSync(path.join(home, '.ccr', 'instances', '1'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(home, '.ccr', '.layout'), '1\n');
  const inst = path.join(home, '.ccr', 'instances', '1');
  fs.writeFileSync(path.join(inst, slots.OWNER_FILE), `${process.pid}:${Date.now()}`);
  fs.writeFileSync(path.join(inst, 'name'), 'alpha\n');
  fs.writeFileSync(path.join(inst, 'launch-cwd'), home + '\n');

  const s = buildSession(projects, { sid: '77777777-0000-4000-8000-000000000001', slug: '-tmp-confine' });
  s.spawn({ toolUseId: 'toolu_01Conf', agentId: 'aconfine00000000a', at: T0, subagentType: 'explore', prompt: 'map auth flow' });
  s.agentTurn({ agentId: 'aconfine00000000a', at: T0 + 1000, blocks: [{ type: 'text', text: 'grepping src/auth' }] });

  const point = (/** @type {string} */ transcript) => {
    fs.writeFileSync(path.join(inst, 'last-status.json'), JSON.stringify({
      transcript_path: transcript,
      model: { display_name: 'Opus 5' },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    }));
  };
  const run = (/** @type {string[]} */ args) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home, USERPROFILE: home, CCR_NOW: String(T0 + 5000), CCR_CONFIG: path.join(root, 'no-config.json') };
    delete env.CCR_STATE_DIR;
    delete env.CCR_SESSION;
    const r = spawnSync(process.execPath, [CCR_JS, 'subagents', '-i', 'alpha', ...args], { env, encoding: 'utf8', cwd: home, input: '' });
    assert.strictEqual(r.status, 0, `ccr subagents failed: ${r.stderr}`);
    return JSON.parse(String(r.stdout));
  };
  return { root, home, s, point, run };
}

test('a transcript path outside the projects tree yields no reading, not a roster', (t) => {
  const w = world(t);
  // Control arm: the very same transcript, INSIDE the tree, is read.
  w.point(w.s.transcript);
  const inside = w.run([]);
  assert.strictEqual(inside.transcript, w.s.transcript);
  assert.deepStrictEqual(inside.agents.map((/** @type {any} */ a) => a.id), ['aconfine00000000a']);

  // The same bytes copied OUTSIDE the tree, and the snapshot pointed at them:
  // a reading here would be a reading of whatever file a planted snapshot
  // names, which is the arbitrary-file read the confinement exists to refuse.
  const outside = path.join(w.root, 'elsewhere.jsonl');
  fs.copyFileSync(w.s.transcript, outside);
  w.point(outside);
  const refused = w.run([]);
  assert.strictEqual(refused.transcript, null, 'a path outside ~/.claude/projects must not become the reading');
  assert.deepStrictEqual(refused.agents, [], 'no roster may be derived from an unconfined path');
});

test('the channels appear under --debug and only under --debug', (t) => {
  const w = world(t);
  w.point(w.s.transcript);
  const withFlag = w.run(['--debug']);
  assert.ok(Array.isArray(withFlag.channels) && withFlag.channels.length >= 3,
    'the control arm: --debug really does list the channels');
  const plain = w.run([]);
  assert.ok(!('channels' in plain),
    'R34: the debug flag is the ONLY standing surface for channel provenance — without it there is none');
  // And nothing else moves between the two readings.
  const strip = (/** @type {any} */ o) => { const c = { ...o }; delete c.channels; return c; };
  assert.deepStrictEqual(strip(withFlag), strip(plain), '--debug must add the channels and change nothing else');
});
