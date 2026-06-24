// @ts-check
// test/gherkin.js
// A tiny, zero-dependency Gherkin runner on top of Node's built-in test runner.
//
// It parses the practical core of Gherkin — Feature / Background / Scenario /
// Scenario Outline + Examples, with Given·When·Then·And·But·* steps — and turns
// each scenario into a node:test test(). Scenario Outlines are expanded once per
// Examples row. A scenario whose steps aren't all defined yet is registered as
// TODO (not a failure), so the feature files are executable from day one and
// light up green as steps land.
//
// SUPPORTED grammar (everything the feature files use, nothing they don't):
//   Feature:            one per file, required
//   Background:         optional, at most one, before any Scenario
//   Scenario:           free text title
//   Scenario Outline:   + exactly one Examples: table; <placeholder> substitution
//   Examples:           a leading header row then >=1 data row, pipe-delimited
//   Steps:              Given | When | Then | And | But | *   followed by text
//   Comments (# ...), tags (@ ...) and the Feature narrative are ignored.
//
// DELIBERATELY NOT SUPPORTED. Structural misuse is REJECTED LOUDLY — each throws
// a GherkinSyntaxError with a file:line, so a feature file can't pass *vacuously*
// by being silently mis-parsed:
//   - doc strings (""" or ```)            - step-level data tables
//   - the Rule: keyword (Gherkin 6)       - multiple Examples per Outline
//   - a Scenario/Outline with no steps    - a step after its Examples table
// Two non-features are NOT special-cased, by design (no dedicated error):
//   - Cucumber Expressions ({int}, …): step text is matched by RegExp/string via
//     StepRegistry — write a regex; there is no {int} expansion.
//   - i18n: English keywords only. A non-English keyword line is treated as
//     narrative and ignored; if that leaves a scenario empty the no-steps guard
//     fires, so it still can't pass vacuously.
// If you need the real thing, reach for @cucumber/gherkin.
// See docs/GHERKIN.md for the full grammar and rationale.
//
// No npm deps — Node ≥18 stdlib only. Run with `node --test`.

const fs = require('node:fs');
const { test } = require('node:test');

/** @typedef {{ keyword: string, text: string }} Step */
/** @typedef {{ name: string, steps: Step[], line: number }} Scenario */
/** @typedef {{ feature: string, background: Step[], scenarios: Scenario[] }} ParsedFeature */
/** @typedef {(world: Record<string, any>, ...args: string[]) => (void | Promise<void>)} StepFn */

/**
 * Thrown when a feature file uses syntax this parser does not support, or a
 * malformed construct it would otherwise mis-read. The message is prefixed with
 * `file:line:` and `.line` carries the 1-based line number.
 */
class GherkinSyntaxError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) {
    super(message);
    this.name = 'GherkinSyntaxError';
    this.line = line;
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Parser -----------------------------------------------------------------

/**
 * @param {string} text     raw .feature file contents
 * @param {string} [filename] used only to prefix error messages
 * @returns {ParsedFeature}
 */
function parseFeature(text, filename = '<feature>') {
  const lines = text.split(/\r?\n/);
  let feature = '';
  let featureSeen = false;
  let backgroundSeen = false;
  /** @type {Step[]} */
  const background = [];
  /** @type {Scenario[]} */
  const scenarios = [];
  /** @type {Step[] | null} */
  let cur = null;        // array currently collecting steps
  /** @type {{ name: string, steps: Step[], header: string[] | null, rows: string[][], examplesSeen: boolean, line: number } | null} */
  let outline = null;    // set while inside a Scenario Outline
  let inExamples = false;

  /**
   * @param {number} line
   * @param {string} msg
   * @returns {never}
   */
  const fail = (line, msg) => {
    throw new GherkinSyntaxError(`${filename}:${line}: ${msg}`, line);
  };

  const flushOutline = () => {
    if (!outline) return;
    const { name, steps, header, rows, examplesSeen, line } = outline;
    if (steps.length === 0) fail(line, `Scenario Outline "${name}" has no steps`);
    if (!examplesSeen) fail(line, 'Scenario Outline has no Examples: block');
    if (!header) fail(line, 'Scenario Outline Examples: has no header row');
    if (rows.length === 0) fail(line, 'Scenario Outline Examples: has a header but no data rows');
    rows.forEach((row, i) => {
      /** @type {Record<string, string>} */
      const map = {};
      header.forEach((h, j) => { map[h] = row[j]; });
      /** @param {string} s */
      const subst = (s) => s.replace(/<([^>]+)>/g, (m, k) => {
        if (!(k in map)) fail(line, `unknown placeholder <${k}> (no matching Examples column)`);
        return map[k];
      });
      scenarios.push({
        name: `${subst(name)} [${i + 1}]`,
        steps: steps.map((st) => ({ keyword: st.keyword, text: subst(st.text) })),
        line,
      });
    });
    outline = null;
  };

  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;

    // Reject constructs that would otherwise be silently mis-parsed.
    if (line.startsWith('"""') || line.startsWith('```')) {
      fail(lineNo, 'doc strings (""" / ```) are not supported');
    }
    if (/^Rule:/.test(line)) fail(lineNo, 'the Rule: keyword is not supported');

    let m;
    if ((m = line.match(/^Feature:\s*(.*)$/))) {
      if (featureSeen) fail(lineNo, 'multiple Feature: blocks in one file');
      flushOutline(); feature = m[1]; featureSeen = true; cur = null; inExamples = false; continue;
    }
    if (/^Background:/.test(line)) {
      if (backgroundSeen) fail(lineNo, 'multiple Background: blocks');
      flushOutline(); // expand any pending outline first, so the check below sees it
      if (scenarios.length) fail(lineNo, 'Background: must appear before any Scenario');
      cur = background; backgroundSeen = true; inExamples = false; continue;
    }
    if ((m = line.match(/^Scenario Outline:\s*(.*)$/))) {
      flushOutline();
      outline = { name: m[1], steps: [], header: null, rows: [], examplesSeen: false, line: lineNo };
      cur = outline.steps; inExamples = false; continue;
    }
    if ((m = line.match(/^Scenario:\s*(.*)$/))) {
      flushOutline(); const sc = { name: m[1], steps: [], line: lineNo }; scenarios.push(sc); cur = sc.steps; inExamples = false; continue;
    }
    if (/^Examples:/.test(line)) {
      if (!outline) fail(lineNo, 'Examples: outside a Scenario Outline');
      if (outline.examplesSeen) fail(lineNo, 'multiple Examples: blocks per Scenario Outline are not supported');
      outline.examplesSeen = true; inExamples = true; continue;
    }
    if ((m = line.match(/^(Given|When|Then|And|But|\*)\s+(.*)$/))) {
      if (!cur) fail(lineNo, 'step before any Scenario or Background');
      if (inExamples) fail(lineNo, 'step after an Examples: table (steps must precede Examples)');
      cur.push({ keyword: m[1], text: m[2] });
      continue;
    }
    if (line.startsWith('|')) {
      if (!(outline && inExamples)) {
        fail(lineNo, 'table row outside an Examples: block (step-level data tables are not supported)');
      }
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!outline.header) {
        outline.header = cells;
      } else if (cells.length !== outline.header.length) {
        fail(lineNo, `Examples row has ${cells.length} cell(s); header has ${outline.header.length}`);
      } else {
        outline.rows.push(cells);
      }
      continue;
    }
    // Anything else (Feature narrative: "As a…/I want…/So that…") is ignored.
  }
  flushOutline();
  if (!featureSeen) fail(lineNo, 'no Feature: line found');
  // A scenario with no steps would run zero assertions and pass vacuously. This
  // also catches step lines silently dropped as narrative (e.g. a misspelled or
  // non-English keyword) when they were a scenario's only steps.
  for (const sc of scenarios) {
    if (sc.steps.length === 0) fail(sc.line, `Scenario "${sc.name}" has no steps`);
  }
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
  runFeature(parseFeature(fs.readFileSync(file, 'utf8'), file), registry);
}

module.exports = { parseFeature, StepRegistry, executeSteps, runFeature, runFeatureFile, GherkinSyntaxError };
