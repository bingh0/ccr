// @ts-check
'use strict';
// Unit test for src/sidecar.js updateFeed — the incremental transcript tail.
// The subtle parts: read only NEW bytes by offset, accumulate stats across
// ticks, and reset cleanly on a session switch. Uses a real temp file because
// readNewLines reads by byte offset.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { updateFeed } = require('../src/sidecar');

let SEQ = 0;
const tmpFile = () => path.join(os.tmpdir(), `ccr-sidecar-${process.pid}-${++SEQ}.jsonl`);

function toolLine(name, input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] },
  });
}
const append = (/** @type {string} */ f, /** @type {string[]} */ lines) =>
  fs.appendFileSync(f, lines.map((l) => l + '\n').join(''));

test('accumulates tool events incrementally and only reads new bytes', () => {
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

test('resets cleanly on a session switch (new transcript path)', () => {
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

test('restarts from 0 if the file shrank (rotation/truncation)', () => {
  const f = tmpFile();
  append(f, [toolLine('Edit', { file_path: 'a.js' }), toolLine('Edit', { file_path: 'b.js' })]);
  updateFeed(f);
  // Truncate to a single, different line — offset now exceeds file size.
  fs.writeFileSync(f, toolLine('Bash', { description: 'fresh' }) + '\n');
  const after = updateFeed(f);
  assert.ok(after.tools.Bash >= 1, 'the post-truncation line is read after restart');

  fs.unlinkSync(f);
});
