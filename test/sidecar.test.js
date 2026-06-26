'use strict';

// Phase 5 — sidecar live states + sentinel round-trip, plus the updateFeed
// incremental transcript tail (the two subtle parts of the sidecar).
// Mirrors features/sidecar-hosting.feature (@AC3 waiting/render, @AC5 ended)
// and the live tool/skills feed (features/feed.feature).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame, updateFeed, run } = require('../src/sidecar.js');

// A fully-injected harness for run() so the end-of-session sweep is testable
// without real timers, process.exit, or stdout writes.
function runHarness(over = {}) {
  const w = { ticks: 0, scheduled: [], cleared: { interval: 0, timeout: 0 }, exited: 0, signals: [] };
  const deps = {
    graceMs: 1500,
    tick: () => { w.ticks++; },
    sentinelExists: () => !!over.sentinel,
    setIntervalFn: () => 'INTERVAL_ID',
    setTimeoutFn: (cb, ms) => { w.scheduled.push({ cb, ms }); return 'TIMEOUT_ID'; },
    clearIntervalFn: () => { w.cleared.interval++; },
    clearTimeoutFn: () => { w.cleared.timeout++; },
    exit: () => { w.exited++; },
    onSignal: (sig) => { w.signals.push(sig); },
    ...over.deps,
    exitOnEnd: over.exitOnEnd,
  };
  const stop = run(deps);
  return { w, stop };
}

test('run: --exit-on-end schedules a sweep-close once the session has ended', () => {
  const { w } = runHarness({ exitOnEnd: true, sentinel: true });
  assert.strictEqual(w.ticks >= 1, true, 'rendered at least once');
  assert.strictEqual(w.scheduled.length, 1, 'one end-sweep scheduled');
  assert.strictEqual(w.scheduled[0].ms, 1500, 'after the grace window');
  // Firing the scheduled sweep closes the pane: clears the loop and exits.
  w.scheduled[0].cb();
  assert.strictEqual(w.exited, 1);
  assert.strictEqual(w.cleared.interval, 1);
});

test('run: without --exit-on-end a session end never self-closes (tmux/standalone)', () => {
  const { w } = runHarness({ exitOnEnd: false, sentinel: true });
  assert.strictEqual(w.scheduled.length, 0, 'no self-close scheduled');
  assert.strictEqual(w.exited, 0);
  assert.deepStrictEqual(w.signals, ['SIGINT', 'SIGTERM'], 'still wired to signals');
});

test('run: --exit-on-end does NOT close while the session is still live', () => {
  const { w } = runHarness({ exitOnEnd: true, sentinel: false });
  assert.strictEqual(w.scheduled.length, 0, 'no sweep until the exited sentinel appears');
});

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-sidecar-'));
}

const SAMPLE = JSON.stringify({
  model: { display_name: 'Opus 4.8' },
  context_window: { context_window_size: 1000000, total_input_tokens: 262000 },
  rate_limits: {
    five_hour: { used_percentage: 50, resets_at: Math.floor(Date.now() / 1000) + 16800 },
    seven_day: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 500000 },
  },
  cost: { total_cost_usd: 4.2 },
});

test('sidecar waits before the first status tick (@AC3)', () => {
  const dir = freshStateDir();
  try {
    assert.match(composeFrame(dir), /waiting for the first status tick/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sidecar renders the economy panel once a snapshot exists (@AC3)', () => {
  const dir = freshStateDir();
  try {
    fs.writeFileSync(path.join(dir, 'last-status.json'), SAMPLE);
    const frame = composeFrame(dir, { now: 1_000_000 });
    assert.ok(!/waiting/.test(frame), 'no longer waiting');
    assert.match(frame, /Opus 4\.8/);
    // Block glyphs used by the economy bars render (proves it is the panel).
    assert.ok(/[▓░]/.test(frame), 'panel block glyphs present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sidecar shows "session ended" when the sentinel is present (@AC5)', () => {
  const dir = freshStateDir();
  try {
    fs.writeFileSync(path.join(dir, 'last-status.json'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'exited'), '');
    assert.match(composeFrame(dir), /session ended/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sentinel round-trip: live panel -> drop sentinel -> ended (@AC5)', () => {
  const dir = freshStateDir();
  try {
    fs.writeFileSync(path.join(dir, 'last-status.json'), SAMPLE);
    assert.match(composeFrame(dir, { now: 1_000_000 }), /Opus 4\.8/);

    // Pane 0 drops the sentinel on Claude exit (see buildWtArgs `type nul`).
    fs.writeFileSync(path.join(dir, 'exited'), '');
    assert.match(composeFrame(dir), /session ended/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sidecar reports unreadable status instead of crashing', () => {
  const dir = freshStateDir();
  try {
    fs.writeFileSync(path.join(dir, 'last-status.json'), '{not json');
    assert.match(composeFrame(dir), /status unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- updateFeed: the incremental transcript tail --------------------------
// The subtle parts: read only NEW bytes by offset, accumulate stats across
// ticks, and reset cleanly on a session switch. Uses a real temp file because
// readNewLines reads by byte offset. (Restored from the pre-Windows-branch
// suite — these regressed to zero coverage when composeFrame tests landed.)

let SEQ = 0;
const tmpFile = () => path.join(os.tmpdir(), `ccr-feed-${process.pid}-${++SEQ}.jsonl`);

function toolLine(name, input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] },
  });
}
const append = (f, lines) => fs.appendFileSync(f, lines.map((l) => l + '\n').join(''));

test('updateFeed accumulates tool events incrementally and only reads new bytes', () => {
  const f = tmpFile();
  append(f, [toolLine('Edit', { file_path: 'src/a.js' }), toolLine('Bash', { description: 'run tests' })]);

  const first = updateFeed(f);
  assert.strictEqual(first.events.length, 2, 'both initial events parsed');
  assert.strictEqual(first.tools.Edit, 1);
  assert.strictEqual(first.tools.Bash, 1);
  assert.deepStrictEqual(first.files, ['a.js'], 'Edit file is tracked (by basename)');

  // Append one more line; a second tick must parse ONLY the new line but keep
  // the running totals.
  append(f, [toolLine('Edit', { file_path: 'src/b.js' })]);
  const second = updateFeed(f);
  assert.strictEqual(second.events.length, 3, 'one new event added, not re-parsed');
  assert.strictEqual(second.tools.Edit, 2, 'Edit count accumulated across ticks');
  assert.deepStrictEqual(second.files.sort(), ['a.js', 'b.js']);

  // No new bytes → no change.
  const third = updateFeed(f);
  assert.strictEqual(third.events.length, 3, 'idle tick adds nothing');

  fs.unlinkSync(f);
});

test('updateFeed resets cleanly on a session switch (new transcript path)', () => {
  const a = tmpFile();
  const b = tmpFile();
  append(a, [toolLine('Read', { file_path: 'x.js' }), toolLine('Read', { file_path: 'y.js' })]);
  const fa = updateFeed(a);
  assert.strictEqual(fa.tools.Read, 2);

  append(b, [toolLine('Grep', { pattern: 'foo' })]);
  const fb = updateFeed(b);
  assert.strictEqual(fb.events.length, 1, 'switching sessions clears the buffer');
  assert.strictEqual(fb.tools.Read, undefined, 'prior session tool counts are gone');
  assert.strictEqual(fb.tools.Grep, 1);

  fs.unlinkSync(a);
  fs.unlinkSync(b);
});

test('updateFeed restarts from 0 if the file shrank (rotation/truncation)', () => {
  const f = tmpFile();
  append(f, [toolLine('Edit', { file_path: 'a.js' }), toolLine('Edit', { file_path: 'b.js' })]);
  updateFeed(f);
  // Truncate to a single, different line — offset now exceeds file size.
  fs.writeFileSync(f, toolLine('Bash', { description: 'fresh' }) + '\n');
  const after = updateFeed(f);
  assert.ok(after.tools.Bash >= 1, 'the post-truncation line is read after restart');

  fs.unlinkSync(f);
});
