// @ts-check
'use strict';
// Step definitions for features/feed.feature — drives src/render/feed.js.

const assert = require('node:assert');
const { renderFeed } = require('../../src/render/feed');

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function feed(/** @type {Record<string, any>} */ w) {
  w.feed = w.feed || { events: [], tools: {}, commands: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, files: [] };
  return w.feed;
}
function doRender(/** @type {Record<string, any>} */ w, opts) {
  w.raw = renderFeed(feed(w), opts);
  w.out = strip(w.raw);
  w.lines = w.out ? w.out.split('\n') : [];
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineFeedSteps(reg) {
  reg.define(/^a feed$/, (w) => { feed(w); });
  reg.define(/^a tool event "([^"]+)" with arg "([^"]+)"$/, (w, tool, arg) => {
    feed(w).events.push({ ts: 1, kind: 'tool', tool, arg });
    feed(w).tools[tool] = (feed(w).tools[tool] || 0) + 1;
  });
  reg.define(/^a command event "([^"]+)"$/, (w, cmd) => {
    feed(w).events.push({ ts: 1, kind: 'cmd', tool: cmd, arg: '' });
    feed(w).commands++;
  });
  reg.define(/^the tool counts are Bash (\d+), Edit (\d+), Read (\d+)$/, (w, b, e, r) => {
    Object.assign(feed(w).tools, { Bash: Number(b), Edit: Number(e), Read: Number(r) });
  });
  reg.define(/^(\d+) tool events named "([^"]+)"$/, (w, n, name) => {
    for (let i = 0; i < Number(n); i++) feed(w).events.push({ ts: i, kind: 'tool', tool: name, arg: '' });
  });
  reg.define(/^the rolling stats are (\d+) files and (\d+) output tokens$/, (w, f, out) => {
    feed(w).files = Array.from({ length: Number(f) }, (_, i) => `f${i}.js`);
    feed(w).tokens.output = Number(out);
  });

  // --- Actions ---
  reg.define(/^the feed renders$/, (w) => doRender(w));
  reg.define(/^the feed renders with a max of (\d+)$/, (w, m) => doRender(w, { max: Number(m) }));

  // --- Assertions ---
  reg.define(/^the feed shows "([^"]+)" with "([^"]+)"$/, (w, tool, arg) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.includes(tool) && l.includes(arg)), `expected a line with "${tool}" and "${arg}" in:\n${w.out}`);
  });
  reg.define(/^the header line contains "([^"]+)"$/, (w, s) => {
    assert.ok(w.lines[0] && w.lines[0].includes(s), `header "${w.lines[0]}" lacks "${s}"`);
  });
  reg.define(/^the feed shows a command "([^"]+)"$/, (w, cmd) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.includes('⌘') && l.includes(cmd)), `expected command "${cmd}" in:\n${w.out}`);
  });
  reg.define(/^the feed shows (\d+) event lines$/, (w, n) => {
    const evLines = w.lines.filter((/** @type {string} */ l) => /^\s+(↳|⌘)/.test(l));
    assert.strictEqual(evLines.length, Number(n), `event lines:\n${w.out}`);
  });
  reg.define(/^the feed shows "([^"]+)"$/, (w, s) => {
    assert.ok(w.out.includes(s), `expected "${s}" in:\n${w.out}`);
  });
  reg.define(/^the feed output is empty$/, (w) => {
    assert.strictEqual(w.raw, '', `expected empty, got:\n${w.out}`);
  });
};
