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

test('stripControl passes only null/undefined through — everything else is coerced and stripped', () => {
  // Absent stays absent: callers use these as "no value" (`x || null`).
  assert.strictEqual(stripControl(null), null);
  assert.strictEqual(stripControl(undefined), undefined);
  // Everything else becomes a sanitized STRING. This used to return non-strings
  // unchanged, which was the bypass below: skipping the strip does not keep a
  // value out of the terminal, because the renderers stringify it anyway.
  assert.strictEqual(stripControl(42), '42');
});

test('stripControl closes the non-string bypass: an array smuggles no escapes', () => {
  const payload = '\x1b]0;PWNED\x07\x1b]52;c;cHduZWQ=\x07\x1b[6n';
  // An array of one string stringifies straight back to that string, so a JSON
  // file can choose the type and defeat a typeof check. Both forms must strip.
  assert.strictEqual(stripControl([payload]), stripControl(payload));
  assert.ok(!CTRL.test(stripControl([payload])), 'escapes survived via an array');
  assert.ok(!CTRL.test(stripControl({ toString: () => payload })), 'escapes survived via toString');
});

test('stripControl removes bidi overrides and zero-width characters', () => {
  // Not C0/C1, but display control: they reorder or hide what the reader sees
  // relative to the bytes present (CVE-2021-42574, applied to a status pane).
  for (const evil of ['‮', '​', '⁦', ' ', '﻿']) {
    const out = stripControl('safe' + evil + 'text');
    assert.strictEqual(out, 'safetext', `${JSON.stringify(evil)} survived`);
  }
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
