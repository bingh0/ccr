// @ts-check
// test/gherkin.js
// A tiny, zero-dependency Gherkin runner on top of Node's built-in test runner.
// Parses a .feature file (Feature / Background / Scenario / Scenario Outline +
// Examples, Given·When·Then·And·But·*) and turns each scenario into a node:test
// test(). Scenario Outlines are expanded per Examples row. A scenario whose
// steps aren't all defined yet is registered as TODO (not a failure), so the
// feature files are executable from day one and light up green as steps land.
//
// No npm deps — Node ≥18 stdlib only. Run with `node --test`.

const fs = require('node:fs');
const { test } = require('node:test');

/** @typedef {{ keyword: string, text: string }} Step */
/** @typedef {{ name: string, steps: Step[] }} Scenario */
/** @typedef {{ feature: string, background: Step[], scenarios: Scenario[] }} ParsedFeature */
/** @typedef {(world: Record<string, any>, ...args: string[]) => (void | Promise<void>)} StepFn */

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Parser -----------------------------------------------------------------

/**
 * @param {string} text
 * @returns {ParsedFeature}
 */
function parseFeature(text) {
  const lines = text.split(/\r?\n/);
  let feature = '';
  /** @type {Step[]} */
  const background = [];
  /** @type {Scenario[]} */
  const scenarios = [];
  /** @type {Step[] | null} */
  let cur = null;        // array currently collecting steps
  /** @type {{ name: string, steps: Step[], header: string[] | null, rows: string[][] } | null} */
  let outline = null;    // set while inside a Scenario Outline
  let inExamples = false;

  const flushOutline = () => {
    if (!outline) return;
    const { name, steps, header, rows } = outline;
    if (header) {
      rows.forEach((row, i) => {
        /** @type {Record<string, string>} */
        const map = {};
        header.forEach((h, j) => { map[h] = row[j]; });
        /** @param {string} s */
        const subst = (s) => s.replace(/<([^>]+)>/g, (m, k) => (k in map ? map[k] : m));
        scenarios.push({
          name: `${subst(name)} [${i + 1}]`,
          steps: steps.map((st) => ({ keyword: st.keyword, text: subst(st.text) })),
        });
      });
    }
    outline = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;

    let m;
    if ((m = line.match(/^Feature:\s*(.*)$/))) { flushOutline(); feature = m[1]; cur = null; inExamples = false; continue; }
    if (/^Background:/.test(line)) { flushOutline(); cur = background; inExamples = false; continue; }
    if ((m = line.match(/^Scenario Outline:\s*(.*)$/))) { flushOutline(); outline = { name: m[1], steps: [], header: null, rows: [] }; cur = outline.steps; inExamples = false; continue; }
    if ((m = line.match(/^Scenario:\s*(.*)$/))) { flushOutline(); const sc = { name: m[1], steps: [] }; scenarios.push(sc); cur = sc.steps; inExamples = false; continue; }
    if (/^Examples:/.test(line)) { inExamples = true; continue; }
    if ((m = line.match(/^(Given|When|Then|And|But|\*)\s+(.*)$/))) {
      if (cur) cur.push({ keyword: m[1], text: m[2] });
      continue;
    }
    if (line.startsWith('|') && outline && inExamples) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!outline.header) outline.header = cells;
      else outline.rows.push(cells);
      continue;
    }
    // Anything else (Feature narrative: "As a…/I want…/So that…") is ignored.
  }
  flushOutline();
  return { feature, background, scenarios };
}

// --- Step registry ----------------------------------------------------------

class StepRegistry {
  constructor() {
    /** @type {{ re: RegExp, fn: StepFn }[]} */
    this.steps = [];
  }

  /**
   * @param {RegExp | string} pattern RegExp (capture groups become step args) or exact string
   * @param {StepFn} fn
   * @returns {this}
   */
  define(pattern, fn) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(`^${escapeRegExp(pattern)}$`);
    this.steps.push({ re, fn });
    return this;
  }

  /**
   * @param {string} text
   * @returns {{ fn: StepFn, args: string[] } | null}
   */
  find(text) {
    for (const s of this.steps) {
      const m = text.match(s.re);
      if (m) return { fn: s.fn, args: m.slice(1) };
    }
    return null;
  }
}

// --- Execution --------------------------------------------------------------

/**
 * Run a flat list of steps against a shared world. Throws on an undefined step
 * or a failing assertion. Exposed so the harness self-test can drive it without
 * going through node:test.
 * @param {Step[]} steps
 * @param {StepRegistry} registry
 * @param {Record<string, any>} [world]
 * @returns {Promise<Record<string, any>>}
 */
async function executeSteps(steps, registry, world = {}) {
  for (const step of steps) {
    const found = registry.find(step.text);
    if (!found) throw new Error(`Undefined step: ${step.text}`);
    await found.fn(world, ...found.args);
  }
  return world;
}

/**
 * @param {ParsedFeature} parsed
 * @param {StepRegistry} registry
 */
function runFeature(parsed, registry) {
  for (const sc of parsed.scenarios) {
    const steps = [...parsed.background, ...sc.steps];
    const title = `${parsed.feature} :: ${sc.name}`;
    const missing = steps.filter((s) => !registry.find(s.text));
    if (missing.length) {
      test(title, { todo: `${missing.length} undefined step(s); first: "${missing[0].text}"` }, () => {});
      continue;
    }
    test(title, async () => { await executeSteps(steps, registry); });
  }
}

/**
 * @param {string} file
 * @param {StepRegistry} registry
 */
function runFeatureFile(file, registry) {
  runFeature(parseFeature(fs.readFileSync(file, 'utf8')), registry);
}

module.exports = { parseFeature, StepRegistry, executeSteps, runFeature, runFeatureFile };
