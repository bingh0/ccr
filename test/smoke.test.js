'use strict';

// Phase 0 baseline: proves the test harness runs and the vendored pure-Node
// core loads on this platform without side effects. Real feature coverage is
// added per phase (see ../features/*.feature).

const test = require('node:test');
const assert = require('node:assert');

test('Phase 0: core src modules load without throwing', () => {
  const modules = [
    '../src/burn.js',
    '../src/doctor.js',
    '../src/economy-model.js',
    '../src/normalize.js',
    '../src/rate-limits.js',
    '../src/resume.js',
    '../src/sanitize.js',
    '../src/sidecar.js',
    '../src/state-dir.js',
    '../src/theme.js',
    '../src/transcripts.js',
    '../src/render/economy.js',
    '../src/render/feed.js',
    '../src/render/statusline.js',
  ];
  for (const m of modules) {
    assert.doesNotThrow(() => require(m), `require(${m})`);
  }
});

test('Phase 0: a pure core function behaves', () => {
  const { stripControl } = require('../src/sanitize.js');
  assert.strictEqual(stripControl('ab'), 'ab');
});
