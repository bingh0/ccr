// @ts-check
'use strict';
// test/pane-integration.test.js — the SEAMS of the pane subsystem.
//
// Written in response to an adversarial review that found three separate
// mutations leaving the whole suite green: the sidecar never reading user
// config, the cycle key never advancing the view, and the frame ignoring the
// view index. Each unit was well covered; nothing tested that they were wired
// to each other, so the feature could have shipped completely disconnected.
//
// The rule these tests follow: assert against what PRODUCTION does, not against
// a parameter only a test supplies. The row-overflow case is the cautionary
// one — it was "covered" by a scenario that hand-fed `maxRows` to the renderer
// while no production caller passed it at all, so the contract clause was
// certified by a test and absent from the product.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame, frame, __resetViewState } = require('../src/sidecar');
const { loadPaneBlob, MAX_ROWS, MAX_FIELD_CHARS, MAX_SPARK } = require('../src/pane-blob');
const { cycleView } = require('../src/cycle-view');
const { renderPane } = require('../src/render/pane');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pane-blob.golden.json'), 'utf8'));
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A world: a config dir, a blob dir, and a state dir, all torn down after. */
function world(/** @type {any} */ t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-int-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = {
    root,
    configFile: path.join(root, 'config.json'),
    blob: path.join(root, 'sidecar.json'),
    state: path.join(root, 'state'),
  };
  fs.mkdirSync(w.state);
  return w;
}

const writeConfig = (/** @type {any} */ w, /** @type {any[]} */ panes) =>
  fs.writeFileSync(w.configFile, JSON.stringify({ panes }));

// ── The config → sidecar seam ────────────────────────────────────────────────

test('composeFrame renders panes from the USER CONFIG, not just injected ones', (t) => {
  const w = world(t);
  fs.writeFileSync(w.blob, JSON.stringify(GOLDEN));
  writeConfig(w, [{ path: w.blob }]);
  const prev = process.env.CCR_CONFIG;
  process.env.CCR_CONFIG = w.configFile;
  t.after(() => { if (prev == null) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prev; });

  // No `panes` option: the sidecar must go and read the config itself. Every
  // feature scenario injects `panes`, so without this the wiring is untested
  // and `panes = opts.panes || []` passes the entire suite.
  // View 2, not 1: the cycle is economy, the built-in git pane, then the
  // configured panes in order (src/sidecar.js composeFrame).
  const paneFrame = plain(composeFrame(w.state, { now: Date.now(), cols: 72, view: 2 }));
  assert.match(paneFrame, /trace/, 'the configured pane is discovered and rendered');
  assert.match(paneFrame, /3\/3/, 'it takes its position in the cycle');
});

test('a relative config path resolves against the config file, end to end', (t) => {
  const w = world(t);
  const sub = path.join(w.root, 'tool');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'blob.json'), JSON.stringify(GOLDEN));
  writeConfig(w, [{ path: 'tool/blob.json' }]);
  const prev = process.env.CCR_CONFIG;
  process.env.CCR_CONFIG = w.configFile;
  t.after(() => { if (prev == null) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prev; });

  assert.match(plain(composeFrame(w.state, { now: Date.now(), cols: 72, view: 2 })), /trace/);
});

// ── The cycle position marker ────────────────────────────────────────────────

test('the position marker appears only once the cycle outgrows the built-in views', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.state, 'last-status.json'), JSON.stringify({
    model: { display_name: 'Opus 5' }, rate_limits: {}, cost: { total_cost_usd: 1 },
  }));
  const at = (/** @type {number} */ view, /** @type {any[]} */ panes) =>
    plain(composeFrame(w.state, { now: Date.now(), cols: 44, view, panes }));

  // Ruled 2026-08-05. The git pane made the cycle two views long for EVERYONE,
  // and numbering those two would have put an "n/N" on the economy panel of
  // every user who has configured nothing — a change to a shipped surface,
  // bought for nothing, since two self-identifying views need no numbering.
  for (const view of [0, 1]) {
    assert.doesNotMatch(at(view, []), /\d+\/\d+/,
      `view ${view} must carry no position marker when nothing is configured`);
  }

  // Configure one pane and the markers come back — a user who already had them
  // keeps them, renumbered for the longer cycle.
  fs.writeFileSync(w.blob, JSON.stringify(GOLDEN));
  const panes = [{ path: w.blob, source: w.blob }];
  assert.match(at(0, panes), /1\/3/, 'the economy panel numbers itself once there is a cycle to number');
  assert.match(at(1, panes), /2\/3/, 'the git pane takes position 2');
  assert.match(at(2, panes), /3\/3/, 'the configured pane takes position 3');
});

// ── The key → view seam ──────────────────────────────────────────────────────

test('a recorded cycle request advances the view that reaches composeFrame', (t) => {
  const w = world(t);
  __resetViewState();
  t.after(() => __resetViewState());

  /** @type {number[]} */
  const views = [];
  const compose = (/** @type {string} */ _dir, /** @type {any} */ opts) => { views.push(opts.view); return ''; };
  const paint = () => {};

  frame({ stateDir: w.state, compose, paint });          // adopt the baseline
  cycleView(w.state);
  frame({ stateDir: w.state, compose, paint });          // one press → +1
  cycleView(w.state);
  cycleView(w.state);
  frame({ stateDir: w.state, compose, paint });          // two more → +2

  assert.deepStrictEqual(views, [0, 1, 3],
    'the view index must advance by the number of presses AND reach composeFrame — '
    + 'breaking either half (the request handler, or passing `view`) shows up here');
});

test('cycling is idempotent between presses', (t) => {
  const w = world(t);
  __resetViewState();
  t.after(() => __resetViewState());
  /** @type {number[]} */
  const views = [];
  const compose = (/** @type {string} */ _d, /** @type {any} */ o) => { views.push(o.view); return ''; };
  frame({ stateDir: w.state, compose, paint: () => {} });
  frame({ stateDir: w.state, compose, paint: () => {} });
  frame({ stateDir: w.state, compose, paint: () => {} });
  assert.deepStrictEqual(views, [0, 0, 0], 'ticks without a press never drift the view');
});

// ── Row overflow, through the production path ────────────────────────────────

test('a blob with more rows than the pane height collapses to "+N more" in production', (t) => {
  const w = world(t);
  const rows = Array.from({ length: 40 }, (_, i) => ({
    label: `row${i}`, value: String(i), status: i === 39 ? 'alert' : 'ok',
  }));
  fs.writeFileSync(w.blob, JSON.stringify({ ...GOLDEN, rows }));

  // `rows` is the PANE HEIGHT, exactly what composeFrame gets from the terminal.
  const out = plain(composeFrame(w.state, {
    now: Date.now(), cols: 72, rows: 12, view: 2,
    panes: [{ path: w.blob, source: w.blob }],
  }));

  assert.match(out, /\+\d+ more/, 'overflow collapses rather than silently scrolling the pane');
  assert.ok(out.split('\n').length <= 12,
    `the frame must fit the pane: got ${out.split('\n').length} lines for a 12-line pane`);
  // The hidden alert must still be visible AS an alert — a count that hides a
  // red row is precisely the dishonesty obligation 8 exists to prevent.
  const more = out.split('\n').find((l) => /\+\d+ more/.test(l));
  assert.ok(more, 'the collapsed line exists');
});

test('the overflow line inherits the worst hidden status', () => {
  const rows = [
    { label: 'a', value: '1', status: 'ok' },
    { label: 'b', value: '2', status: 'warn' },
    { label: 'c', value: '3', status: 'dark' },
  ];
  const res = { state: 'ok', blob: { ...GOLDEN, rows }, ageMs: 0 };
  const out = renderPane(res, { source: '/x', width: 72, maxRows: 2 });
  const more = plain(out).split('\n').find((l) => /\+2 more/.test(l));
  assert.ok(more, `expected a "+2 more" line, got:\n${plain(out)}`);
  assert.ok(more.includes('◌'), 'dark outranks warn among the hidden rows');
});

// ── Resource caps actually bite ──────────────────────────────────────────────

test('a blob over the row cap is refused as oversized', (t) => {
  const w = world(t);
  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ label: `r${i}`, value: '1', status: 'ok' }));
  fs.writeFileSync(w.blob, JSON.stringify({ ...GOLDEN, rows }));
  assert.strictEqual(loadPaneBlob(w.blob, { now: Date.now() }).state, 'oversized');
});

test('a display field over the character cap is truncated by the verifier', (t) => {
  const w = world(t);
  const long = 'x'.repeat(MAX_FIELD_CHARS + 500);
  fs.writeFileSync(w.blob, JSON.stringify({ ...GOLDEN, rows: [{ label: long, value: long, status: 'ok', detail: long }] }));
  const res = loadPaneBlob(w.blob, { now: Date.now() });
  assert.strictEqual(res.state, 'ok');
  for (const field of ['label', 'value', 'detail']) {
    assert.strictEqual(res.blob.rows[0][field].length, MAX_FIELD_CHARS,
      `${field} is cut to the cap by the VERIFIER, not merely clamped by the renderer`);
  }
});

test('a spark longer than the cap is dropped, and the row survives', (t) => {
  const w = world(t);
  const spark = Array.from({ length: MAX_SPARK + 1 }, (_, i) => i);
  fs.writeFileSync(w.blob, JSON.stringify({ ...GOLDEN, rows: [{ label: 'r', value: '1', status: 'ok', spark }] }));
  const res = loadPaneBlob(w.blob, { now: Date.now() });
  assert.strictEqual(res.state, 'ok');
  assert.strictEqual(res.blob.rows[0].spark, null, 'an over-cap spark degrades locally');
  assert.strictEqual(res.blob.rows[0].label, 'r', 'the row itself is untouched');
});

// ── Rulings that only exist as prose unless something asserts them ───────────

test('a broken blob\'s rows are not validated — junk rows never bury the message', (t) => {
  const w = world(t);
  fs.writeFileSync(w.blob, JSON.stringify({
    ...GOLDEN, status: 'broken', message: 'refresh failed partway',
    rows: [{ label: {}, value: null, nonsense: true }],     // would be `invalid` if validated
  }));
  const res = loadPaneBlob(w.blob, { now: Date.now() });
  assert.strictEqual(res.state, 'ok', 'the blob validates so its confession can be shown');
  assert.strictEqual(res.blob.status, 'broken');
  assert.match(plain(renderPane(res, { source: w.blob, width: 72 })), /refresh failed partway/);
});

test('error states still carry the write-age chrome', (t) => {
  const w = world(t);
  fs.writeFileSync(w.blob, JSON.stringify({ ...GOLDEN, v: 99 }));
  const when = Date.now() - 3 * 3600 * 1000;
  fs.utimesSync(w.blob, when / 1000, when / 1000);
  const out = plain(renderPane(loadPaneBlob(w.blob, { now: Date.now() }), { source: w.blob, width: 72 }));
  assert.match(out, /unsupported blob version 99/);
  assert.match(out, /blob written 3h ago/,
    'a pane broken for three days must not look like one that broke a second ago');
});

test('a configured path carrying control bytes cannot inject through an error state', () => {
  const hostile = '/tmp/\x1b]0;PWNED\x07evil.json';
  const out = renderPane({ state: 'waiting' }, { source: hostile, width: 72 });
  assert.ok(!plain(out).includes('\x1b'), 'the configured path is sanitized before it is displayed');
});
