// @ts-check
'use strict';
// Unit test for src/sanitize.js + the status-JSON ingestion path — terminal
// control characters must never survive into rendered (terminal) output.

const test = require('node:test');
const assert = require('node:assert');
const { stripControl } = require('../src/sanitize');
const { normalizeStatus } = require('../src/normalize');

const CTRL = /[\x00-\x1f\x7f-\x9f]/;

test('stripControl removes C0/C1 controls, DEL, ESC — keeps printable text', () => {
  const evil = 'Opus\x1b[31m 4.8\x1b]0;pwn\x07\x00\x7f';
  const out = stripControl(evil);
  assert.ok(!CTRL.test(out), `control chars survived: ${JSON.stringify(out)}`);
  assert.strictEqual(out, 'Opus[31m 4.8]0;pwn'); // bytes gone, the now-inert text remains
  assert.strictEqual(stripControl('plain 4.8'), 'plain 4.8'); // identity on clean input
});

test('stripControl passes non-strings through unchanged', () => {
  assert.strictEqual(stripControl(null), null);
  assert.strictEqual(stripControl(undefined), undefined);
  assert.strictEqual(stripControl(42), 42);
});

test('normalizeStatus sanitizes the model display name', () => {
  const view = normalizeStatus({ model: { display_name: 'Evil\x1b[2J\x1b[H Model' }, rate_limits: {} });
  assert.ok(!CTRL.test(view.model), `model has control chars: ${JSON.stringify(view.model)}`);
});

test('normalizeStatus sanitizes a malicious rate-limit bucket label', () => {
  // An unknown bucket key flows into the label verbatim — must be sanitized.
  const view = normalizeStatus({
    model: { display_name: 'Opus 4.8' },
    rate_limits: { 'eviltype\x1b[31m': { used_percentage: 50, resets_at: 9999999999 } },
  });
  const bad = view.windows.find((/** @type {any} */ w) => CTRL.test(w.label));
  assert.ok(!bad, `label has control chars: ${JSON.stringify(bad)}`);
});
