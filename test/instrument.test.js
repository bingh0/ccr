// @ts-check
'use strict';
// Unit test for src/instrument.js — local meter logging (data collection only).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logMeterSample } = require('../src/instrument');

test('logs a sample for a subscription session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-instr-'));
  const ok = logMeterSample({
    session_id: 'X',
    rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 10 } },
    model: { id: 'claude-opus-4-8' },
    context_window: { total_input_tokens: 120000 },
  }, { dir, now: 1000 });
  assert.strictEqual(ok, true);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'burnlog-X.jsonl'), 'utf8').trim());
  assert.strictEqual(rec.limits.five_hour.used, 42);
  assert.strictEqual(rec.limits.seven_day.used, 10);
  assert.strictEqual(rec.ctx, 120000);
  assert.strictEqual(rec.t, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('is a no-op for API sessions with no meter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-instr-'));
  assert.strictEqual(logMeterSample({ session_id: 'Y', rate_limits: {} }, { dir }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('respects CCR_NO_INSTRUMENT opt-out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-instr-'));
  const prev = process.env.CCR_NO_INSTRUMENT;
  process.env.CCR_NO_INSTRUMENT = '1';
  try {
    assert.strictEqual(logMeterSample({ session_id: 'Z', rate_limits: { five_hour: { used_percentage: 5 } } }, { dir }), false);
  } finally {
    if (prev == null) delete process.env.CCR_NO_INSTRUMENT; else process.env.CCR_NO_INSTRUMENT = prev;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
