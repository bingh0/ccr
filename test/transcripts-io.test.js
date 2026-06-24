// @ts-check
'use strict';
// Tests for the hardened transcript I/O: the command-tag regex must not blow up
// on adversarial input, and readNewLines must bound its per-call allocation
// while still making forward progress.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseEvents, readNewLines } = require('../src/transcripts');

let SEQ = 0;
const tmpFile = () => path.join(os.tmpdir(), `ccr-io-${process.pid}-${++SEQ}.jsonl`);

test('command-tag parsing is linear on adversarial input (no ReDoS)', () => {
  // A long unclosed <command-name> tag is the catastrophic-backtracking case.
  const line = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: '<command-name>' + ' '.repeat(200000) } });
  const t = Date.now();
  const p = parseEvents([line]);
  const ms = Date.now() - t;
  assert.ok(ms < 500, `parse took ${ms}ms — possible ReDoS regression`);
  assert.strictEqual(p.events.length, 0, 'no command extracted from an unclosed tag');
});

test('a valid command tag is still extracted', () => {
  const line = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: '<command-name>/code-review</command-name>' } });
  const p = parseEvents([line]);
  assert.strictEqual(p.events[0].kind, 'cmd');
  assert.strictEqual(p.events[0].tool, '/code-review');
});

test('readNewLines bounds its read window and still advances over whole lines', () => {
  const f = tmpFile();
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join('\n') + '\n';
  fs.writeFileSync(f, lines);
  // Tiny cap forces multiple ticks; each must return whole lines and advance.
  let offset = 0, total = 0, ticks = 0;
  for (;;) {
    const r = readNewLines(f, offset, 16);
    if (r.offset === offset && !r.lines.length) break; // no progress, no data → done
    offset = r.offset; total += r.lines.length; ticks++;
    if (ticks > 100) { assert.fail('did not converge — possible stuck offset'); }
    if (offset >= fs.statSync(f).size) { /* drain one more for trailing */ }
    if (offset >= fs.statSync(f).size && !r.lines.length) break;
  }
  assert.strictEqual(total, 10, 'every line read exactly once across capped ticks');
  fs.unlinkSync(f);
});

test('a single line longer than the cap does not wedge the offset', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'x'.repeat(50) + '\n' + '{"ok":1}\n'); // first "line" exceeds the cap
  // cap=16: the 50-char line has no newline within the first window → must skip
  // forward rather than re-read the same window forever.
  let offset = 0, sawOk = false, ticks = 0;
  for (;;) {
    const r = readNewLines(f, offset, 16);
    ticks++;
    if (r.lines.some((l) => /"ok":1/.test(l))) sawOk = true;
    if (r.offset === offset && !r.lines.length) break;
    offset = r.offset;
    if (ticks > 100) { assert.fail('stuck — oversized line wedged the tail'); }
    if (offset >= fs.statSync(f).size) break;
  }
  assert.ok(sawOk, 'reached the line after an oversized one (forward progress held)');
  fs.unlinkSync(f);
});
