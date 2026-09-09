// @ts-check
'use strict';
// Step definitions for features/feed.feature — drives src/render/feed.js.

const assert = require('node:assert');
const { renderFeed } = require('../../src/render/feed');
const { visibleWidth } = require('../../src/render/shared');

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function feed(/** @type {Record<string, any>} */ w) {
  w.feed = w.feed || { events: [], tools: {}, commands: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, files: [] };
  return w.feed;
}
/**
 * @param {Record<string, any>} w
 * @param {{ max?: number, width?: number }} [opts] omitted → renderFeed's own defaults
 */
function doRender(w, opts) {
  w.raw = renderFeed(feed(w), opts);
  w.out = strip(w.raw);
  w.lines = w.out ? w.out.split('\n') : [];
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineFeedSteps(reg) {
  reg.define(/^a feed$/, (w) => { feed(w); });
  reg.define(/^a tool event "([^"]+)" with arg "([^"]+)"$/, (w, tool, arg) => {
    feed(w).events.push({ ts: 1, kind: 'tool', tool, arg });
    feed(w).tools[String(tool)] = (feed(w).tools[String(tool)] || 0) + 1;
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
  reg.define(/^the feed renders at a width of (\d+)$/, (w, n) => doRender(w, { width: Number(n) }));

  // --- Assertions ---
  reg.define(/^the feed shows "([^"]+)" with "([^"]+)"$/, (w, tool, arg) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.includes(String(tool)) && l.includes(String(arg))), `expected a line with "${tool}" and "${arg}" in:\n${w.out}`);
  });
  reg.define(/^the header line contains "([^"]+)"$/, (w, s) => {
    assert.ok(w.lines[0] && w.lines[0].includes(s), `header "${w.lines[0]}" lacks "${s}"`);
  });
  reg.define(/^the feed shows a command "([^"]+)"$/, (w, cmd) => {
    assert.ok(w.lines.some((/** @type {string} */ l) => l.includes('⌘') && l.includes(String(cmd))), `expected command "${cmd}" in:\n${w.out}`);
  });
  reg.define(/^the feed shows (\d+) event lines$/, (w, n) => {
    const evLines = w.lines.filter((/** @type {string} */ l) => /^\s+(↳|⌘)/.test(l));
    assert.strictEqual(evLines.length, Number(n), `event lines:\n${w.out}`);
  });
  reg.define(/^the feed shows "([^"]+)"$/, (w, s) => {
    assert.ok(w.out.includes(s), `expected "${s}" in:\n${w.out}`);
  });
  // --- Narrow panes ---
  // Columns, not characters (src/render/shared.js visibleWidth): the pane
  // charges two for a wide glyph, and so must the check.
  reg.define(/^every feed line fits in (\d+) columns$/, (w, n) => {
    const max = Number(n);
    const over = w.lines.filter((/** @type {string} */ l) => visibleWidth(l) > max)
      .map((/** @type {string} */ l) => `${visibleWidth(l)} cols: ${JSON.stringify(l)}`);
    assert.deepStrictEqual(over, [], `every feed line must fit ${max} columns`);
  });
  reg.define(/^the feed shows "([^"]+)" with a shortened argument ending in "…"$/, (w, tool) => {
    const line = w.lines.find((/** @type {string} */ l) => l.includes(String(tool)));
    assert.ok(line, `no line for "${tool}" in:\n${w.out}`);
    assert.ok(/\S…$/.test(line), `the argument on "${line}" should have been cut with an ellipsis`);
  });
  reg.define(/^the feed shows "([^"]+)" cut short with "…"$/, (w, tool) => {
    // The whole name cannot be on the line (it would not fit), so the line
    // carries its head and an ellipsis — and the head has to be recognisable.
    const head = String(tool).slice(0, 12);
    const line = w.lines.find((/** @type {string} */ l) => l.includes(head));
    assert.ok(line, `no line beginning "${head}" in:\n${w.out}`);
    assert.ok(line.includes('…') && !line.includes(String(tool)), `"${tool}" should be cut short on: ${line}`);
  });
  reg.define(/^no feed line ends with "…"$/, (w) => {
    assert.ok(w.lines.length > 0, 'the feed rendered something');
    assert.ok(w.lines.every((/** @type {string} */ l) => !l.endsWith('…')), `a line was cut in a pane wide enough:\n${w.out}`);
  });
  reg.define(/^the feed output is empty$/, (w) => {
    assert.strictEqual(w.raw, '', `expected empty, got:\n${w.out}`);
  });
};
