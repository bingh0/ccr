// @ts-check
'use strict';
// test/hostile-input.test.js — regressions for the 2026-08-02 renderer review.
//
// Every case here was a VERIFIED defect, not a hypothetical. The unifying theme:
// the sidecar's inputs are files, files choose their own JSON value types and
// their own inode types, and the renderer used to assume both. Each test names
// the failure it locks out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { composeFrame, heartbeatTick } = require('../src/sidecar');
const { normalizeStatus } = require('../src/normalize');
const { clampVisible } = require('../src/render/shared');
const { readNewLines } = require('../src/transcripts');
const { readTextCapped } = require('../src/safe-read');
const { liveness } = require('../src/liveness');
// A symlink to a FILE has no unprivileged Windows equivalent, so these two
// skip by name there rather than fake the fixture — a hardlink would invert
// the very property they assert. features/design/test-link-fixtures.feature.
const { plantFileLink, skipWithoutFileSymlinks } = require('./_links');

// A composed frame is legitimately multi-line, so newline is the one control
// character allowed to survive into it. Everything else is a finding.
const CTRL_IN_FRAME = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const ESC_PAYLOAD = '\x1b]0;PWNED\x07\x1b]52;c;cHduZWQ=\x07\x1b[6n';

/** A state dir removed when the test ends, pass or fail. */
function stateDir(/** @type {any} */ t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hostile-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const writeSnapshot = (/** @type {string} */ d, /** @type {any} */ o) =>
  fs.writeFileSync(path.join(d, 'last-status.json'), JSON.stringify(o));

/** Strip SGR colour runs, which are ccr's own and always legitimate. */
const withoutSgr = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a non-string display field cannot smuggle escape sequences to the terminal', (t) => {
  const d = stateDir(t);
  // The field's TYPE is attacker-chosen. An array of one string stringifies
  // right back to that string downstream, so a `typeof s === 'string'` guard in
  // the sanitizer skipped the strip and the escapes reached stdout intact.
  for (const hostile of [[ESC_PAYLOAD], { toString: undefined }, ESC_PAYLOAD]) {
    writeSnapshot(d, {
      model: { display_name: hostile },
      workspace: { current_dir: '/tmp' },
      cost: { total_cost_usd: 1 },
    });
    const frame = withoutSgr(composeFrame(d, { now: Date.now() }));
    assert.ok(!CTRL_IN_FRAME.test(frame), `control bytes reached the frame via ${JSON.stringify(hostile)}`);
    // The payload's TEXT may well still be visible — that is fine and is the
    // point: it renders as inert characters ("]0;PWNED"), carrying no ESC to
    // introduce it, so the terminal prints it instead of obeying it.
    assert.ok(!frame.includes('\x1b'), 'no escape introducer survives');
  }
});

test('a wrong-typed cost does not replace the whole panel with an error', (t) => {
  const d = stateDir(t);
  // `total_cost_usd: "1.5"` used to reach `.toFixed()` and throw inside the draw
  // loop, so every tick rendered "ccr render error: …" instead of the economy
  // panel — one wrong type costing the entire display, permanently.
  writeSnapshot(d, {
    model: { display_name: 'Opus 4.8' },
    workspace: { current_dir: '/tmp' },
    cost: { total_cost_usd: '1.5', total_duration_ms: 'nope' },
    context_window: { total_input_tokens: 1000, context_window_size: 200000 },
  });
  const frame = composeFrame(d, { now: Date.now() });
  assert.ok(!/render error/.test(frame), `panel replaced by an error: ${frame}`);
  assert.match(frame, /economy/, 'the panel still renders');
});

test('normalizeStatus rejects non-finite and non-numeric numbers', () => {
  const view = normalizeStatus({
    model: { display_name: 'm' },
    rate_limits: {},
    cost: { total_cost_usd: '1.5' },
    context_window: { total_input_tokens: 'lots', context_window_size: 0 },
  });
  assert.strictEqual(view.costUsd, null, 'a string cost is absent, not "1.5"');
  assert.strictEqual(view.contextTokens, null);
  assert.strictEqual(view.windowSize, 200000, 'a zero window size falls back — it is a divisor');
});

test('a fifo at the snapshot path cannot wedge the render loop', (t) => {
  const d = stateDir(t);
  const p = path.join(d, 'last-status.json');
  try {
    execFileSync('mkfifo', [p]);
  } catch {
    t.skip('mkfifo unavailable');
    return;
  }
  // readFileSync on a fifo BLOCKS until a writer appears. The sidecar loop is
  // synchronous, so this froze the panel forever — no render, no heartbeat, no
  // recovery. lstat answers "regular file?" without opening anything.
  assert.strictEqual(readTextCapped(p), null, 'a fifo is refused, not opened');
  const frame = composeFrame(d, { now: Date.now() });
  assert.match(frame, /waiting for the first status tick/, 'falls back to the waiting state');
});

test('an oversized snapshot is refused rather than rendered', (t) => {
  const d = stateDir(t);
  const p = path.join(d, 'last-status.json');
  fs.writeFileSync(p, 'x'.repeat(300 * 1024));
  assert.strictEqual(readTextCapped(p), null, 'over the cap → refused');
  assert.strictEqual(readTextCapped(p, 400 * 1024)?.length, 300 * 1024, 'under an explicit cap → read');
});

test('a symlinked snapshot is not followed', { skip: skipWithoutFileSymlinks() }, (t) => {
  const d = stateDir(t);
  const target = path.join(d, 'elsewhere.json');
  fs.writeFileSync(target, '{"secret":true}');
  const link = path.join(d, 'linked.json');
  plantFileLink(target, link);
  assert.strictEqual(readTextCapped(link), null, 'state files are state, never links');
});

test('readNewLines advances by bytes, so invalid UTF-8 cannot overshoot the file', (t) => {
  const d = stateDir(t);
  const f = path.join(d, 't.jsonl');
  // Decoding to a string turns each invalid byte into U+FFFD (3 bytes), so
  // re-encoding the kept prefix produced an offset PAST the end of the file.
  // The next tick then read size < offset as a truncation and restarted at 0 —
  // re-ingesting the entire transcript every second, forever, stats inflating.
  const buf = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
  fs.writeFileSync(f, buf);
  const r = readNewLines(f, 0);
  assert.ok(r.offset <= buf.length, `offset ${r.offset} overshot a ${buf.length}-byte file`);
  assert.strictEqual(r.offset, buf.length, 'a complete final line consumes the whole file');
  assert.strictEqual(readNewLines(f, r.offset).restarted, false, 'a settled tail does not re-restart');
});

test('readNewLines reports a genuine restart so accumulators can reset', (t) => {
  const d = stateDir(t);
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, 'aaaa\nbbbb\n');
  const first = readNewLines(f, 0);
  assert.strictEqual(first.restarted, false);
  fs.writeFileSync(f, 'cc\n');
  assert.strictEqual(readNewLines(f, first.offset).restarted, true, 'a shrink is reported');
});

test('clampVisible counts terminal columns, not UTF-16 code units', () => {
  // 8 CJK glyphs are 16 columns. Counting them as 8 overflowed the pane and soft
  // -wrapped the line, corrupting the cursor-home redraw the clamp exists for.
  const cjk = '日本語テスト日本語テスト';
  const out = withoutSgr(clampVisible(cjk, 8));
  assert.strictEqual([...out].length, 4, '4 wide glyphs fill 8 columns');

  // A wide glyph straddling the last column is cut, not half-drawn.
  assert.strictEqual([...withoutSgr(clampVisible(cjk, 7))].length, 3);

  // ASCII is unchanged — the common path must not regress.
  assert.strictEqual(withoutSgr(clampVisible('hello world', 5)), 'hello');
  assert.strictEqual(clampVisible('short', 80), 'short', 'no clamp when it fits');
});

test('clampVisible never emits a lone surrogate', () => {
  const out = withoutSgr(clampVisible('ab\u{1F600}cd', 3));
  const lone = [...out].some((c) => {
    const cp = /** @type {number} */ (c.codePointAt(0));
    return cp >= 0xd800 && cp <= 0xdfff;
  });
  assert.ok(!lone, `astral character cut in half: ${JSON.stringify(out)}`);
});

test('clampVisible keeps SGR escapes free and still resets on a cut', () => {
  const coloured = '\x1b[31mred text here\x1b[0m';
  const out = clampVisible(coloured, 3);
  assert.ok(out.startsWith('\x1b[31m'), 'colour is not counted against the budget');
  assert.ok(out.endsWith('\x1b[0m'), 'a severed colour run is reset');
  assert.strictEqual(withoutSgr(out), 'red');
});

test('a huge rate-limit label cannot blank the panel', (t) => {
  const d = stateDir(t);
  // labelW multiplies: rows × longest-label, both chosen by the file. A long key
  // built a string big enough to throw RangeError and wipe the display.
  /** @type {any} */
  const rl = {};
  for (let i = 0; i < 200; i++) rl['bucket_' + i] = { used_percentage: 10, resets_at: 9999999999 };
  rl['x'.repeat(50000)] = { used_percentage: 10, resets_at: 9999999999 };
  writeSnapshot(d, { model: { display_name: 'm' }, rate_limits: rl, cost: { total_cost_usd: 1 } });
  const frame = composeFrame(d, { now: Date.now(), cols: 80 });
  assert.ok(!/render error/.test(frame), 'the panel survives a hostile bucket set');
  for (const line of frame.split('\n')) {
    assert.ok(withoutSgr(line).length <= 80, `line exceeded the pane: ${withoutSgr(line).length} cols`);
  }
});

test('a stale nonce cannot lock out every future sidecar after a clock step', (t) => {
  const d = stateDir(t);
  // A hard-killed sidecar leaves its nonce behind. Comparing nonces ALONE is a
  // wall-clock comparison against a file that outlived its writer: after any
  // backwards clock step, every sidecar launched since reads that dead nonce as
  // "newer" and stands down — leaving the pane with no live sidecar at all.
  const dead = `999999:${2_000_000_000_000}`;   // far-future start, i.e. "newer"
  fs.writeFileSync(path.join(d, 'sidecar-alive'), dead);
  const old = 1_000_000_000_000;
  fs.utimesSync(path.join(d, 'sidecar-alive'), old / 1000, old / 1000);

  const mine = `${process.pid}:${old + 60_000}`;
  assert.strictEqual(
    heartbeatTick(d, mine, { now: old + 60_000 }),
    'claimed',
    'a nonce whose file stopped being beaten is a corpse, not a rival',
  );

  // A genuinely live rival — newer nonce AND a fresh mtime — still wins.
  const rival = `999999:${old + 120_000}`;
  fs.writeFileSync(path.join(d, 'sidecar-alive'), rival);
  assert.strictEqual(heartbeatTick(d, mine, { now: old + 121_000 }), 'yielded');
});

test('the heartbeat is never written through a planted symlink', { skip: skipWithoutFileSymlinks() }, (t) => {
  const d = stateDir(t);
  const victim = path.join(d, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL');
  plantFileLink(victim, path.join(d, 'sidecar-alive'));
  heartbeatTick(d, `${process.pid}:${Date.now()}`);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'the link target was written through');
});

test('the staleness marker rolls minutes into hours and days', () => {
  assert.strictEqual(liveness({ ageMs: 5 * 60000, staleMs: 1 }).marker, 'updated 5m ago');
  assert.strictEqual(liveness({ ageMs: 210 * 60000, staleMs: 1 }).marker, 'updated 3h30m ago');
  assert.strictEqual(liveness({ ageMs: 25 * 3600000, staleMs: 1 }).marker, 'updated 1d1h ago');
});
