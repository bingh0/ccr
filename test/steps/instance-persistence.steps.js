// @ts-check
'use strict';
// Step definitions for features/instance-persistence.feature.
//
// BINDING NOTE (from the feature header): ground truth for the join key is
// what a FOREIGN reader finds in the container after the instance is gone —
// every assertion here reads the session log back from disk after the writer
// (the real `ccr statusline` CLI, retirement, or the sweep) has run, never a
// value the step itself computed.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const slots = require('../../src/instance-slot');
const { DataTable } = require('../gherkin');

const CCR_JS = path.join(__dirname, '..', '..', 'bin', 'ccr.js');
const DEAD_PID = 0x7ffffff0;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstancePersistenceSteps(reg) {
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-pers-'));
      w.home = path.join(w.root, 'home');
      const bin = path.join(w.root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      w.bin = bin;
      fs.mkdirSync(path.join(w.home, '.ccr', 'instances'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(w.home, '.ccr', '.layout'), '1\n');
      w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));
    }
    return w.home;
  };

  const ccr = (/** @type {Record<string, any>} */ w) => path.join(home(w), '.ccr');
  const instDir = (/** @type {Record<string, any>} */ w, /** @type {number} */ n) =>
    path.join(ccr(w), 'instances', String(n));

  const put = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ body = '') => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  const T5 = Math.floor(Date.now() / 1000) + 14_400;

  const logLines = (/** @type {Record<string, any>} */ w, /** @type {string} */ sid) =>
    fs.readFileSync(path.join(ccr(w), `session-${sid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const runCcr = (/** @type {Record<string, any>} */ w, /** @type {string[]} */ args, /** @type {string} */ input = '', /** @type {Record<string,string>} */ extra = {}) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, HOME: home(w), USERPROFILE: home(w), PATH: `${w.bin}${path.delimiter}${process.env.PATH}` };
    delete env.CCR_STATE_DIR;
    delete env.CCR_SESSION;
    delete env.TERM_PROGRAM;
    if (process.platform === 'win32') {
      // Route the spawned CLI down the VS Code branch: migration, pruning and
      // the refusals all run BEFORE launch routing, and this branch cannot
      // open a real Windows Terminal on a CI runner (it stops at the missing
      // `claude` binary instead).
      env.TERM_PROGRAM = 'vscode';
      env.CCR_VSCODE = '1';
    }
    Object.assign(env, extra);
    const r = spawnSync(process.execPath, [CCR_JS, ...args], { env, encoding: 'utf8', input, cwd: home(w) });
    w.got = { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
  };

  // --- Givens ---

  reg.define(/^instance "a" on slot 1 has logged burn samples for session "([^"]+)"$/, (w, sid) => {
    const dir = instDir(w, 1);
    put(dir, slots.OWNER_FILE, `${process.pid}:${Date.now()}`);
    // Burn history lives at the container's top level — the whole point.
    put(ccr(w), `burnlog-${sid}.jsonl`, JSON.stringify({ t: Date.now(), limits: { five_hour: { used: 20, resets_at: T5 } } }) + '\n');
    w.instance = { dir, sid };
  });

  reg.define(/^instance "a-is-awesome" under profile "cc1" launched in "~\/code\/app"$/, (w) => {
    const dir = instDir(w, 1);
    put(dir, slots.OWNER_FILE, `${process.pid}:${Date.now()}`);
    put(dir, 'name', 'a-is-awesome\n');
    put(dir, 'profile', 'cc1\n');
    const lc = path.join(home(w), 'code', 'app');
    fs.mkdirSync(lc, { recursive: true });
    put(dir, 'launch-cwd', lc + '\n');
    w.instance = { dir, launchCwd: lc };
  });

  reg.define(/^instance "a"'s join key for session "([^"]+)" is open$/, (w, sid) => {
    const dir = instDir(w, 1);
    put(dir, slots.OWNER_FILE, `${process.pid}:${Date.now()}`);
    put(dir, 'last-status.json', JSON.stringify({ session_id: sid }));
    put(ccr(w), `session-${sid}.jsonl`, JSON.stringify({ session_id: sid, name: 'a', started: Date.now() }) + '\n');
    w.instance = { dir, sid };
  });

  reg.define(/^slot 2 holds a dead instance whose join key for session "([^"]+)" is open$/, (w, sid) => {
    const dir = instDir(w, 2);
    put(dir, slots.OWNER_FILE, `${DEAD_PID}:1`);
    put(dir, 'last-status.json', JSON.stringify({ session_id: sid }));
    const beat = put(dir, 'sidecar-alive', '4242:1');
    // The last evidence of life, at a known instant well in the past.
    w.heartbeatSec = Math.floor(Date.now() / 1000) - 3600;
    fs.utimesSync(beat, w.heartbeatSec, w.heartbeatSec);
    const old = (Date.now() - 3600_000) / 1000;
    for (const f of fs.readdirSync(dir)) if (f !== 'sidecar-alive') fs.utimesSync(path.join(dir, f), old, old);
    fs.utimesSync(dir, old, old);
    put(ccr(w), `session-${sid}.jsonl`, JSON.stringify({ session_id: sid, name: 'a', started: Date.now() - 7200_000 }) + '\n');
    w.instance = { dir, sid };
  });

  reg.define(/^history from a session that ended (\d+) days ago$/, (w, age) => {
    const ms = Date.now() - Number(age) * 24 * 60 * 60 * 1000;
    const sec = ms / 1000;
    for (const f of [`burnlog-aged01.jsonl`, `session-aged01.jsonl`]) {
      fs.utimesSync(put(ccr(w), f, '{"t":1}\n'), sec, sec);
    }
  });

  reg.define(/^no ccr instance is running$/, (w) => { home(w); });

  reg.define(/^the container holds burn history from past sessions$/, (w) => {
    put(ccr(w), 'burnlog-old01.jsonl', JSON.stringify({ t: Date.now(), limits: { five_hour: { used: 34, resets_at: T5 } } }) + '\n');
    put(ccr(w), 'session-old01.jsonl', JSON.stringify({ session_id: 'old01', name: 'gone', started: 1 }) + '\n');
    put(ccr(w), 'session-old02.jsonl', JSON.stringify({ session_id: 'old02', name: 'gone2', started: 2 }) + '\n');
  });

  // --- Whens ---

  reg.define(/^its first status arrives carrying session id "([^"]+)"$/, (w, sid) => {
    const status = JSON.stringify({
      session_id: sid,
      cwd: w.instance.launchCwd,
      model: { display_name: 'Opus 4.8' },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: T5 } },
    });
    runCcr(w, ['statusline'], status, { CCR_STATE_DIR: w.instance.dir });
  });

  reg.define(/^instance "a" exits politely$/, (w) => {
    slots.retireInstance(w.instance.dir, { home: home(w), sidecarAlive: () => false });
  });

  reg.define(/^instance "a" exits and its directory is deleted$/, (w) => {
    slots.retireInstance(w.instance.dir, { home: home(w), sidecarAlive: () => false });
    assert.strictEqual(fs.existsSync(w.instance.dir), false, 'the retirement really deleted it');
  });

  reg.define(/^a launch sweeps the dead instance$/, (w) => {
    slots.sweepDeadInstances({ home: home(w), minAgeMs: 0 });
  });

  reg.define(/^a bare ccr launches$/, (w) => { runCcr(w, []); });

  reg.define(/^ccr economy runs$/, (w) => { runCcr(w, ['economy']); });

  // --- Thens ---

  reg.define(/^the burn history for session "([^"]+)" is still present in the container$/, (w, sid) => {
    assert.ok(fs.existsSync(path.join(ccr(w), `burnlog-${sid}.jsonl`)));
  });

  // The corpus's ONE step with a data table, so the DataTable arm of the
  // capture union is real here and nowhere else. Narrowed rather than cast:
  // if the table is ever dropped from the feature, this says which step lost
  // it instead of failing on a missing method three lines down.
  reg.define(/^the account's session log maps "([^"]+)" to$/, (w, sid, table) => {
    if (!(table instanceof DataTable)) throw new TypeError('this step is bound to a data table');
    const open = logLines(w, String(sid))[0];
    const want = table.rowsHash();
    assert.strictEqual(open.name, want.name);
    assert.strictEqual(open.profile, want.profile);
    assert.strictEqual(open.launch_cwd, path.join(home(w), want['launch dir'].replace(/^~\//, '')));
    assert.ok(open.started > 0, 'the open record carries a start time');
  });

  reg.define(/^the session log's entry for "([^"]+)" is marked ended$/, (w, sid) => {
    const lines = logLines(w, String(sid));
    assert.ok(lines.some((l) => typeof l.ended === 'number'), JSON.stringify(lines));
  });

  reg.define(/^the session log's entry for "([^"]+)" is marked swept$/, (w, sid) => {
    const lines = logLines(w, String(sid));
    assert.ok(lines.some((l) => typeof l.swept === 'number'), JSON.stringify(lines));
  });

  reg.define(/^its ended time is the dead instance's last heartbeat time$/, (w) => {
    const lines = logLines(w, w.instance.sid);
    const swept = lines.find((l) => typeof l.swept === 'number');
    assert.ok(swept, 'a swept marker exists');
    assert.strictEqual(Math.round(swept.swept / 1000), w.heartbeatSec, 'stamped with the last evidence of life');
  });

  reg.define(/^the slot 2 instance directory is gone$/, (w) => {
    assert.strictEqual(fs.existsSync(instDir(w, 2)), false);
  });

  reg.define(/^that session's history is (still present|gone)$/, (w, outcome) => {
    const there = fs.existsSync(path.join(ccr(w), 'burnlog-aged01.jsonl'))
      && fs.existsSync(path.join(ccr(w), 'session-aged01.jsonl'));
    const gone = !fs.existsSync(path.join(ccr(w), 'burnlog-aged01.jsonl'))
      && !fs.existsSync(path.join(ccr(w), 'session-aged01.jsonl'));
    if (outcome === 'still present') assert.ok(there, 'kept through day 30');
    else assert.ok(gone, 'gone at 31');
  });

  reg.define(/^the account's meters and burn history are printed$/, (w) => {
    assert.match(w.got.out, /5h/, 'the account meters render from the newest burn sample');
    assert.match(w.got.out, /34%/, "the fixture's own used% is what renders");
    assert.match(w.got.out, /history: 2 sessions retained/);
  });

  reg.define(/^no per-instance panel is printed$/, (w) => {
    assert.strictEqual(w.got.out.split('\n')[0], 'account (no live instance)', 'headed as the account, not an instance');
  });
};
