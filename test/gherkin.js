// @ts-check
// test/gherkin.js
// A tiny, zero-dependency Gherkin runner on top of Node's built-in test runner.
//
// It parses the practical core of Gherkin — Feature / Background / Scenario /
// Scenario Outline + Examples, with Given·When·Then·And·But·* steps, step-level
// data tables, and @skip/@todo/@only tags — and turns each scenario into a
// node:test test(). Scenario Outlines are expanded once per Examples row.
//
// The high-level entry point is runFeatures(dir, definers, { wip }): it
// discovers every *.feature in dir, runs each against its OWN scoped registry
// (step patterns never leak between features), and registers guard tests that
// fail on ambiguous steps, on unbound steps (which would otherwise register as
// TODO — reported as PASSING by node:test), and on definer keys that match no
// feature file. A feature still being bootstrapped opts out of the unbound-step
// ratchet by name via `wip`.
//
// SUPPORTED grammar (the practical core, guarded loudly):
//   Feature:            one per file, required
//   Background:         optional, at most one, before any Scenario
//   Scenario:           free text title
//   Scenario Outline:   + exactly one Examples: table; <placeholder> substitution
//   Examples:           a leading header row then >=1 data row, pipe-delimited
//   Steps:              Given | When | Then | And | But | *   followed by text
//   Step data tables:   | rows after a step attach to it; the step function
//                       receives a cucumber-compatible DataTable as its last
//                       argument (raw/rows/hashes/rowsHash/transpose). Cells
//                       honor \| \\ \n escapes; other backslashes are literal.
//   Tags:               @skip / @todo / @only map to the node:test options of
//                       the same name (@only needs `node --test --test-only`);
//                       tags on Feature: apply to all its scenarios; all other
//                       tags (e.g. @AC3) are carried but have no effect.
//   Comments (# ...) and the Feature narrative are ignored.
//
// DELIBERATELY NOT SUPPORTED. Structural misuse is REJECTED LOUDLY — each throws
// a GherkinSyntaxError with a file:line, so a feature file can't pass *vacuously*
// by being silently mis-parsed:
//   - doc strings (""" or ```)            - the Rule: keyword (Gherkin 6)
//   - multiple Examples per Outline       - a step after its Examples table
//   - a Scenario/Outline with no steps    - a table row with no preceding step
//   - ragged table rows                   - a table row missing its closing |
//   - tags anywhere but immediately before Feature:/Scenario:/Scenario Outline:
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
const path = require('node:path');
const assert = require('node:assert');
const { test } = require('node:test');

/** @typedef {{ keyword: string, text: string, table?: string[][] }} Step */
/** @typedef {{ name: string, steps: Step[], line: number, tags: string[] }} Scenario */
/** @typedef {{ feature: string, background: Step[], scenarios: Scenario[] }} ParsedFeature */
/** @typedef {(world: Record<string, any>, ...args: any[]) => (void | Promise<void>)} StepFn */

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

// --- Data tables --------------------------------------------------------------

/**
 * A step's data table, API-compatible with cucumber-js's DataTable so step code
 * (and muscle memory) ports both ways.
 */
class DataTable {
  /** @param {string[][]} raw */
  constructor(raw) {
    /** @type {string[][]} */
    this.rawTable = raw;
  }

  /** @returns {string[][]} a defensive copy of every row */
  raw() { return this.rawTable.map((r) => [...r]); }

  /** @returns {string[][]} all rows except the first (header) row */
  rows() { return this.raw().slice(1); }

  /** @returns {Record<string, string>[]} one object per non-header row, keyed by the header row */
  hashes() {
    const [header, ...rest] = this.rawTable;
    return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }

  /** @returns {Record<string, string>} a two-column table as a key → value map */
  rowsHash() {
    if (this.rawTable.some((r) => r.length !== 2)) {
      throw new Error('rowsHash() requires a table with exactly two columns');
    }
    return Object.fromEntries(this.rawTable.map(([k, v]) => [k, v]));
  }

  /** @returns {DataTable} columns become rows */
  transpose() {
    return new DataTable(this.rawTable[0].map((_, i) => this.rawTable.map((r) => r[i])));
  }
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
  /** @type {{ name: string, steps: Step[], header: string[] | null, rows: string[][], examplesSeen: boolean, line: number, tags: string[] } | null} */
  let outline = null;    // set while inside a Scenario Outline
  let inExamples = false;
  /** @type {string[]} */
  let featureTags = [];
  /** @type {string[]} */
  let pendingTags = [];  // collected @tags awaiting a Feature:/Scenario:/Outline:

  /**
   * @param {number} line
   * @param {string} msg
   * @returns {never}
   */
  const fail = (line, msg) => {
    throw new GherkinSyntaxError(`${filename}:${line}: ${msg}`, line);
  };

  /** Consume pending tags (for a construct that accepts them). */
  const takeTags = () => { const t = pendingTags; pendingTags = []; return t; };
  /** Reject pending tags (for a line that must not carry them). @param {number} lineNo */
  const noTags = (lineNo) => {
    if (pendingTags.length) {
      fail(lineNo, `tags (${pendingTags.join(' ')}) must immediately precede Feature:, Scenario:, or Scenario Outline:`);
    }
  };

  /**
   * Split one `| a | b |` row into trimmed cells. Honors Gherkin cell escapes
   * (\| → |, \\ → \, \n → newline); a backslash before any other character is
   * literal. A row that does not end with a closing | is a loud error — the
   * naive split would silently drop the trailing cell.
   * @param {string} line   already trimmed, starts with '|'
   * @param {number} lineNo
   * @returns {string[]}
   */
  const splitRow = (line, lineNo) => {
    /** @type {string[]} */
    const cells = [];
    let buf = '';
    let i = 1;
    while (i < line.length) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length) {
        const n = line[i + 1];
        if (n === '|' || n === '\\') { buf += n; i += 2; continue; }
        if (n === 'n') { buf += '\n'; i += 2; continue; }
      }
      if (c === '|') { cells.push(buf.trim()); buf = ''; i += 1; continue; }
      buf += c;
      i += 1;
    }
    if (buf.trim() !== '') fail(lineNo, 'table row must end with a closing |');
    if (cells.length === 0) fail(lineNo, 'empty table row');
    return cells;
  };

  const flushOutline = () => {
    if (!outline) return;
    const { name, steps, header, rows, examplesSeen, line, tags } = outline;
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
        steps: steps.map((st) => ({
          keyword: st.keyword,
          text: subst(st.text),
          ...(st.table ? { table: st.table.map((r) => r.map(subst)) } : {}),
        })),
        line,
        tags,
      });
    });
    outline = null;
  };

  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      const tags = line.split(/\s+/);
      for (const t of tags) {
        // A near-miss of a semantic tag (@Skip, @SKIP, @Only…) would be
        // silently inert — worst for @only, where the typo silently
        // DESELECTS the scenario under --test-only. Reject it loudly.
        if (/^@(skip|todo|only)$/i.test(t) && t !== '@skip' && t !== '@todo' && t !== '@only') {
          fail(lineNo, `tag ${t} looks like ${t.toLowerCase()} but isn't exact — a near-miss tag is silently inert; use lowercase`);
        }
      }
      pendingTags.push(...tags);
      continue;
    }

    // Reject constructs that would otherwise be silently mis-parsed.
    if (line.startsWith('"""') || line.startsWith('```')) {
      fail(lineNo, 'doc strings (""" / ```) are not supported');
    }
    if (line.startsWith('Rule:')) fail(lineNo, 'the Rule: keyword is not supported');

    let m;
    if ((m = line.match(/^Feature:\s*(.*)$/))) {
      if (featureSeen) fail(lineNo, 'multiple Feature: blocks in one file');
      flushOutline(); feature = m[1]; featureSeen = true; featureTags = takeTags(); cur = null; inExamples = false; continue;
    }
    if (line.startsWith('Background:')) {
      noTags(lineNo);
      if (backgroundSeen) fail(lineNo, 'multiple Background: blocks');
      flushOutline(); // expand any pending outline first, so the check below sees it
      if (scenarios.length) fail(lineNo, 'Background: must appear before any Scenario');
      cur = background; backgroundSeen = true; inExamples = false; continue;
    }
    if ((m = line.match(/^Scenario Outline:\s*(.*)$/))) {
      flushOutline();
      outline = { name: m[1], steps: [], header: null, rows: [], examplesSeen: false, line: lineNo, tags: [...featureTags, ...takeTags()] };
      cur = outline.steps; inExamples = false; continue;
    }
    if ((m = line.match(/^Scenario:\s*(.*)$/))) {
      flushOutline();
      const sc = { name: m[1], steps: [], line: lineNo, tags: [...featureTags, ...takeTags()] };
      scenarios.push(sc); cur = sc.steps; inExamples = false; continue;
    }
    if (line.startsWith('Examples:')) {
      noTags(lineNo);
      if (!outline) fail(lineNo, 'Examples: outside a Scenario Outline');
      if (outline.examplesSeen) fail(lineNo, 'multiple Examples: blocks per Scenario Outline are not supported');
      outline.examplesSeen = true; inExamples = true; continue;
    }
    if ((m = line.match(/^(Given|When|Then|And|But|\*)\s+(.*)$/))) {
      noTags(lineNo);
      if (!cur) fail(lineNo, 'step before any Scenario or Background');
      if (inExamples) fail(lineNo, 'step after an Examples: table (steps must precede Examples)');
      cur.push({ keyword: m[1], text: m[2] });
      continue;
    }
    if (line.startsWith('|')) {
      noTags(lineNo);
      const cells = splitRow(line, lineNo);
      if (outline && inExamples) {
        if (!outline.header) {
          outline.header = cells;
        } else if (cells.length !== outline.header.length) {
          fail(lineNo, `Examples row has ${cells.length} cell(s); header has ${outline.header.length}`);
        } else {
          outline.rows.push(cells);
        }
      } else if (cur && cur.length) {
        // A table row after a step is that step's data table.
        const last = cur[cur.length - 1];
        if (!last.table) {
          last.table = [cells];
        } else if (cells.length !== last.table[0].length) {
          fail(lineNo, `table row has ${cells.length} cell(s); this step's table has ${last.table[0].length}`);
        } else {
          last.table.push(cells);
        }
      } else if (cur) {
        fail(lineNo, 'table row without a preceding step');
      } else {
        fail(lineNo, 'table row before any Scenario or Background');
      }
      continue;
    }
    // Anything else (Feature narrative: "As a…/I want…/So that…") is ignored.
  }
  flushOutline();
  if (pendingTags.length) fail(lineNo, `dangling tags (${pendingTags.join(' ')}) at end of file`);
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

// --- Snippets ----------------------------------------------------------------

/**
 * Build a paste-ready step definition for an unbound step: numbers become
 * (\d+) / ([\d.]+) captures, "quoted strings" become "([^"]*)", everything
 * else is regex-escaped. The generated body THROWS — an empty body would turn
 * the pasted definition into an instant vacuous pass, the exact failure mode
 * this harness exists to prevent.
 * @param {string} text step text as written in the feature file
 * @returns {string}
 */
function buildSnippet(text) {
  let src = '';
  let params = 0;
  let last = 0;
  const token = /"[^"]*"|\d+(?:\.\d+)?/g;
  let m;
  while ((m = token.exec(text))) {
    src += escapeRegExp(text.slice(last, m.index));
    params += 1;
    src += m[0].startsWith('"') ? '"([^"]*)"'
      : m[0].includes('.') ? '([\\d.]+)'
        : '(\\d+)';
    last = m.index + m[0].length;
  }
  src += escapeRegExp(text.slice(last));
  src = src.replace(/\//g, '\\/'); // keep the emitted /.../ literal valid JS
  const args = ['w'];
  for (let i = 1; i <= params; i++) args.push(`p${i}`);
  return `reg.define(/^${src}$/, (${args.join(', ')}) => {\n  throw new Error('pending: implement this step');\n});`;
}

// --- Execution --------------------------------------------------------------

/**
 * Run a flat list of steps against a shared world. Throws on an undefined step
 * or a failing assertion. Exposed so the harness self-test can drive it without
 * going through node:test.
 *
 * `world.defer(fn)` registers scenario-scoped cleanup: deferred functions run
 * in reverse (LIFO) order after the steps, INCLUDING when a step failed — so a
 * failing assertion can't leak temp dirs/processes. The step failure, if any,
 * outranks cleanup errors; with no step failure the first cleanup error throws.
 * (`defer` is a reserved key on the world.)
 * @param {Step[]} steps
 * @param {StepRegistry} registry
 * @param {Record<string, any>} [world]
 * @returns {Promise<Record<string, any>>}
 */
async function executeSteps(steps, registry, world = {}) {
  /** @type {Array<(w: Record<string, any>) => any>} */
  const deferred = [];
  world.defer = (/** @type {(w: Record<string, any>) => any} */ fn) => { deferred.push(fn); };
  let failure = null;
  try {
    for (const step of steps) {
      const found = registry.find(step.text);
      if (!found) {
        throw new Error(`Undefined step: ${step.text}\nDefine it with:\n${buildSnippet(step.text)}`);
      }
      const args = step.table ? [...found.args, new DataTable(step.table)] : found.args;
      await found.fn(world, ...args);
    }
  } catch (e) {
    failure = e;
  }
  for (let i = deferred.length - 1; i >= 0; i--) {
    try { await deferred[i](world); } catch (e) { failure = failure ?? e; }
  }
  if (failure) throw failure;
  return world;
}

/**
 * Register one node:test per scenario. Scenarios whose steps aren't all
 * defined register as TODO (see runFeatures for the guard that keeps TODO from
 * silently swallowing a bound feature). Tag mapping: @skip → skipped, @todo →
 * runs but doesn't gate the suite, @only → honored under `--test-only`.
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
    const tags = new Set(sc.tags);
    /** @type {{ skip?: boolean, todo?: boolean, only?: boolean }} */
    const opts = {};
    if (tags.has('@skip')) opts.skip = true;
    if (tags.has('@todo')) opts.todo = true;
    if (tags.has('@only')) opts.only = true;
    test(title, opts, async () => { await executeSteps(steps, registry); });
  }
}

/**
 * @param {string} file
 * @param {StepRegistry} registry
 */
function runFeatureFile(file, registry) {
  runFeature(parseFeature(fs.readFileSync(file, 'utf8'), file), registry);
}

// --- High-level runner --------------------------------------------------------

/**
 * Discover and run every *.feature in `dir`, each against its OWN scoped
 * registry — one feature's step patterns can never match another feature's
 * steps, so there is no global step namespace to collide in.
 *
 * Guards registered alongside the scenarios:
 *  - every key in `definers` must name an existing feature file (a renamed
 *    feature can't silently strand its steps);
 *  - within each feature, every step must match exactly one definition — no
 *    ambiguity, and (unless the feature is listed in `wip`) no unbound steps,
 *    because unbound scenarios register as TODO, which node:test reports as
 *    PASSING. The failure message includes a paste-ready snippet per missing
 *    step. @skip'd scenarios are ratcheted too: skip means "don't run",
 *    never "don't bind".
 *
 * @param {string} dir directory containing .feature files
 * @param {Record<string, (reg: StepRegistry) => any>} definers feature basename → step definer
 * @param {{ wip?: Iterable<string> }} [opts] feature basenames still bootstrapping (TODO allowed)
 */
function runFeatures(dir, definers, opts = {}) {
  const wip = new Set(opts.wip || []);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.feature')).sort();
  const bases = files.map((f) => f.replace(/\.feature$/, ''));

  test('step definers map only to existing feature files', () => {
    const orphaned = Object.keys(definers).filter((k) => !bases.includes(k));
    assert.deepStrictEqual(orphaned, [], `definers with no matching .feature in ${dir}: ${orphaned.join(', ')}`);
  });

  for (const file of files) {
    const base = file.replace(/\.feature$/, '');
    const featureFile = path.join(dir, file);
    const definer = definers[base];
    if (definer !== undefined && typeof definer !== 'function') {
      throw new TypeError(`definer for "${base}" must be a function, got ${typeof definer}`);
    }
    const registry = new StepRegistry();
    if (definer) definer(registry);
    const parsed = parseFeature(fs.readFileSync(featureFile, 'utf8'), featureFile);

    test(`${base} :: step definitions are ${wip.has(base) ? 'unambiguous' : 'complete and unambiguous'}`, () => {
      const steps = [...parsed.background, ...parsed.scenarios.flatMap((s) => s.steps)];
      const ambiguous = steps
        .filter((s) => registry.steps.filter((d) => s.text.match(d.re)).length > 1)
        .map((s) => `"${s.text}"`);
      assert.strictEqual(ambiguous.length, 0, `steps matching >1 definition: ${ambiguous.join('; ')}`);
      if (!wip.has(base)) {
        const unresolved = [...new Set(steps.filter((s) => !registry.find(s.text)).map((s) => s.text))];
        assert.strictEqual(unresolved.length, 0,
          `unbound steps would register as TODO (passing); bind them or add '${base}' to wip:\n\n`
          + unresolved.map((t) => `// ${t}\n${buildSnippet(t)}`).join('\n\n'));
      }
    });

    runFeature(parsed, registry);
  }
}

module.exports = {
  parseFeature, StepRegistry, executeSteps, runFeature, runFeatureFile, runFeatures,
  DataTable, buildSnippet, GherkinSyntaxError,
};
