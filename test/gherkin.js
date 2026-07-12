// @ts-check
// test/gherkin.js
//
// Vendored copy of gherkin-node-test@0.3.0 (MIT — github.com/bingh0/gherkin-node-test,
// npm: gherkin-node-test). That package is the canonical source; this copy is kept
// in-tree so ccr's acceptance suite runs on a bare `node --test` with zero install,
// preserving the zero-runtime-dependency story. When the parser changes, change it
// there and re-sync here (this file is the upstream index.js with only this
// vendor note inserted after the @ts-check line).
//
// gherkin-node-test
// A tiny, zero-dependency Gherkin runner on top of the runtime's built-in test
// runner: node:test under Node, bun:test natively under Bun, and node:test
// under Deno (whose node:test bridges to the native Deno.test runner).
//
// It parses the practical core of Gherkin — Feature / Background / Scenario /
// Scenario Outline + Examples, with Given·When·Then·And·But·* steps, step-level
// data tables, and @skip/@todo/@only tags — and turns each scenario into one
// runner test(). Scenario Outlines are expanded once per Examples row.
//
// The high-level entry point is runFeatures(dir, definers, { wip }): it
// discovers every *.feature in dir, runs each against its OWN scoped registry
// (step patterns never leak between features), and registers guard tests that
// fail on ambiguous steps, on unbound steps (which would otherwise register as
// TODO — reported as PASSING by node:test), and on definer keys that match no
// feature file. A feature still being bootstrapped opts out of the unbound-step
// ratchet by name via `wip`. ONE runFeatures call per test file — a second
// call in the same file is refused as a registered failing test (see below).
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
//   Tags:               @skip → never run (steps must still bind); @todo →
//                       registered, never gates. @only is REJECTED as a
//                       registered failing test: focus semantics differ
//                       irreconcilably across the runtimes (Node: inert
//                       without --test-only; Bun/Deno: focuses its file on
//                       every run, and Deno exits 0 — a committed @only would
//                       silently narrow a CI run). Focus one scenario with the
//                       runner's own per-run flag instead (see README).
//                       Tags on Feature: apply to all its scenarios; all other
//                       tags (e.g. @AC3) are carried but have no effect.
//                       Combining @skip/@todo/@only on one scenario is a loud
//                       error — runners disagree on which would win.
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
// See README.md for the full grammar and rationale.
//
// No npm deps — Node ≥18 stdlib only. Run with `node --test`, `bun test`, or
// `deno test --allow-read` (Deno needs read permission for the .feature files).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const url = require('node:url');

// Under Bun, register tests natively on bun:test: Bun's node:test shim is
// partial (its own compat docs say "use bun:test instead") and deliberately
// drops the `only:` option. The dynamic specifier keeps each runtime loading
// only its own module. Deno is NOT a special case here: its node:test is a
// faithful polyfill that bridges to the native Deno.test runner (option-form
// skip/todo honored), so `deno test` runs this via node:test natively.
const isBun = !!process.versions.bun;
const isDeno = !!(/** @type {any} */ (globalThis).Deno?.version?.deno);
const { test } = require(isBun ? 'bun:test' : 'node:test');

/**
 * Register one test on the active runner. node:test takes skip/todo as
 * options; bun:test takes them as methods. At most one of the two is ever
 * set (the parser rejects combined semantic tags), so the method chain cannot
 * silently invent a precedence the other runner disagrees with. The runners'
 * focus mechanisms (only: / test.only) are never used — @only is rejected
 * instead (see runFeature), because focus behaves three different ways on the
 * three runtimes.
 * @param {string} title
 * @param {{ skip?: boolean, todo?: boolean | string }} opts
 * @param {() => (void | Promise<void>)} fn
 */
function registerTest(title, opts, fn) {
  // The Bun branch is invisible to `node --test` coverage by construction;
  // it is exercised by running this same suite under `bun test` (CI bun lane).
  /* node:coverage ignore next 6 */
  if (isBun) {
    if (opts.skip) test.skip(title, fn);
    else if (opts.todo) test.todo(title, fn);
    else test(title, fn);
    return;
  }
  test(title, opts, fn);
}

// ONE runFeatures call per test file, enforced. Under Deno, a top-level throw
// that happens AFTER an earlier test() has been registered in the same file is
// silently swallowed — `deno test` exits 0. A second runFeatures call is
// exactly where that swallow would hide a load-time error (a non-function
// definer, an unparseable feature file). Confining each test file to a single
// call keeps every load-time error ahead of every registration, so it surfaces
// loudly on all three runtimes.
//
// "The current test file" is identified by TWO signals combined, because each
// alone has a mode where different test files collapse to one value (and a
// collapsed key would falsely refuse a legitimate suite — this guard must
// never inflict the narrowing it exists to prevent):
//  - main module (Bun.main / Deno.mainModule follow the file being collected;
//    Node's require.main is the test file, one process per file) — but under
//    `node --test --experimental-test-isolation=none` every file shares one
//    process and require.main pins to the FIRST test file;
//  - the calling file from the stack (the runFeatures call site physically
//    lives in the test file) — but a shared helper module that wraps
//    runFeatures would put the same helper file in every stack.
// Two files collide only if BOTH signals collide, and even then the refusal is
// a loud failing test, never a silent skip.
const filesWithRunFeatures = new Set();

// This module's own identity in stack frames: a path under Node/Bun, a
// file:// URL under Deno.
const SELF_FILES = [__filename, url.pathToFileURL(__filename).href];

/**
 * The file whose code called into this module — the first stack frame outside
 * index.js. All three runtimes emit V8-style "at fn (path:line:col)" frames.
 * @returns {string} '' when no frame parses (exotic embedder) — the
 *   main-module half of the key still distinguishes test files there.
 */
function callerFile() {
  let found = '';
  for (const frame of (new Error().stack || '').split('\n')) {
    const t = frame.trim();
    if (!t.startsWith('at ')) continue;
    let loc = t.slice(3);
    // "at fn (path:1:2)" → path:1:2 — tolerating parens inside the path
    const open = loc.indexOf('(');
    if (open !== -1 && loc.endsWith(')')) loc = loc.slice(open + 1, -1);
    const m = loc.match(/^(.+):\d+:\d+$/);
    if (m && !SELF_FILES.includes(m[1])) { found = m[1]; break; }
  }
  return found;
}

/** @returns {{ key: string, display: string }} */
function currentTestFile() {
  const g = /** @type {any} */ (globalThis);
  // The Bun/Deno branches are invisible to `node --test` coverage by
  // construction; the CI bun and deno lanes exercise them.
  /* node:coverage ignore next 3 */
  const main = isBun ? g.Bun.main
    : isDeno ? g.Deno.mainModule
      : (require.main?.filename ?? process.argv[1] ?? '');
  const caller = callerFile();
  return { key: `${main}\u0000${caller}`, display: caller || main || 'this test file' };
}

/** @typedef {{ keyword: string, text: string, table?: string[][] }} Step */
/** @typedef {{ name: string, steps: Step[], line: number, tags: string[] }} Scenario */
/** @typedef {{ feature: string, background: Step[], scenarios: Scenario[], file: string }} ParsedFeature */
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

/**
 * A feature's basename — the key used in `definers`, in guard-test titles, and
 * in the @only rejection title. One definition so the three sites can never
 * drift apart.
 * @param {string} file path or basename of a .feature file
 * @returns {string}
 */
function featureBase(file) {
  return path.basename(file).replace(/\.feature$/, '');
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
  /**
   * Reject a combination of semantic tags: node:test takes them as options
   * (with its own precedence), bun:test as mutually exclusive methods — a
   * combination cannot mean the same thing on both runners, so it must not
   * mean anything silently.
   * @param {string[]} tags @param {number} lineNo
   */
  const noTagConflict = (tags, lineNo) => {
    const semantic = [...new Set(tags.filter((t) => t === '@skip' || t === '@todo' || t === '@only'))];
    if (semantic.length > 1) {
      fail(lineNo, `conflicting tags (${semantic.join(' ')}) — @skip/@todo/@only are mutually exclusive; keep exactly one`);
    }
  };
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
        // silently inert — @Skip would run a scenario meant to be skipped,
        // @Only would dodge the loud @only rejection. Reject it loudly.
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
      flushOutline(); feature = m[1]; featureSeen = true; featureTags = takeTags(); noTagConflict(featureTags, lineNo); cur = null; inExamples = false; continue;
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
      noTagConflict(outline.tags, lineNo);
      cur = outline.steps; inExamples = false; continue;
    }
    if ((m = line.match(/^Scenario:\s*(.*)$/))) {
      flushOutline();
      const sc = { name: m[1], steps: [], line: lineNo, tags: [...featureTags, ...takeTags()] };
      noTagConflict(sc.tags, lineNo);
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
  return { feature, background, scenarios, file: filename };
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
 * Register one runner test per scenario. Scenarios whose steps aren't all
 * defined register as TODO (see runFeatures for the guard that keeps TODO from
 * silently swallowing a bound feature). Tag mapping: @skip → skipped, @todo →
 * doesn't gate the suite. @only maps to NOTHING — it registers a failing test
 * instead, because the runners' focus semantics are irreconcilable: Node keeps
 * only: inert without --test-only; Bun and Deno focus the file on every run
 * with no flag, and Deno exits 0 doing it, so a committed @only would silently
 * narrow a CI run there. Rejection is uniform, additive (every scenario still
 * registers and runs — nothing narrows), and REGISTERED rather than thrown, so
 * Deno's load-throw swallow can't eat it. Focus one scenario with the runner's
 * own per-run flag instead: `node --test --test-name-pattern <re>`,
 * `bun test -t <re>`, or `deno test --filter <text>` — a CLI argument can't be
 * committed into the suite, which is the point.
 * @param {ParsedFeature} parsed
 * @param {StepRegistry} registry
 */
function runFeature(parsed, registry) {
  if (parsed.scenarios.some((sc) => sc.tags.includes('@only'))) {
    const base = featureBase(parsed.file);
    const msg = `${parsed.file}: @only is not supported; run one scenario with `
      + '`node --test --test-name-pattern <re>` / `bun test -t <re>` / `deno test --filter <text>`';
    registerTest(`${base} :: @only is not supported`, {}, () => { throw new Error(msg); });
  }
  for (const sc of parsed.scenarios) {
    const steps = [...parsed.background, ...sc.steps];
    const title = `${parsed.feature} :: ${sc.name}`;
    const missing = steps.filter((s) => !registry.find(s.text));
    if (missing.length) {
      const reason = `${missing.length} undefined step(s); first: "${missing[0].text}"`;
      // The placeholder body THROWS its reason: an empty body would pass
      // vacuously under modes that execute todo bodies — `bun test --todo`
      // even FAILS a todo that passes. A throwing todo gates nothing on
      // either runner and keeps the reason visible wherever bodies run.
      registerTest(title, { todo: reason }, () => { throw new Error(reason); });
      continue;
    }
    const tags = new Set(sc.tags);
    /** @type {{ skip?: boolean, todo?: boolean }} */
    const opts = {};
    if (tags.has('@skip')) opts.skip = true;
    if (tags.has('@todo')) opts.todo = true;
    registerTest(title, opts, async () => { await executeSteps(steps, registry); });
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
 * One runFeatures call per test file, enforced: a second call in the same
 * test file registers a single failing test naming the fix and does nothing
 * else. See filesWithRunFeatures above for why (Deno silently swallows a
 * load-time throw once an earlier call has registered a test — a second call
 * is exactly where a bad definer or an unparseable feature would vanish).
 * Give each feature directory its own test file.
 *
 * @param {string} dir directory containing .feature files
 * @param {Record<string, (reg: StepRegistry) => any>} definers feature basename → step definer
 * @param {{ wip?: Iterable<string> }} [opts] feature basenames still bootstrapping (TODO allowed)
 */
function runFeatures(dir, definers, opts = {}) {
  const testFile = currentTestFile();
  if (filesWithRunFeatures.has(testFile.key)) {
    registerTest('runFeatures: one call per test file', {}, () => {
      throw new Error(
        `runFeatures(${JSON.stringify(dir)}, …) is a second runFeatures call in ${testFile.display} — `
        + 'one call per test file: a load-time error in a later call (a non-function definer, an '
        + 'unparseable feature file) is silently swallowed under Deno once an earlier call has '
        + 'registered a test. Give each feature directory its own test file.');
    });
    return;
  }

  const wip = new Set(opts.wip || []);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.feature')).sort();
  const bases = files.map(featureBase);

  // Validate and parse EVERYTHING before registering any test: a bad definer
  // or an unparseable feature must fail at load, before half a suite exists.
  const features = files.map((file) => {
    const base = featureBase(file);
    const featureFile = path.join(dir, file);
    const definer = definers[base];
    if (definer !== undefined && typeof definer !== 'function') {
      throw new TypeError(`definer for "${base}" must be a function, got ${typeof definer}`);
    }
    const registry = new StepRegistry();
    if (definer) definer(registry);
    const parsed = parseFeature(fs.readFileSync(featureFile, 'utf8'), featureFile);
    return { base, parsed, registry };
  });

  // The file's one-call slot is consumed HERE, after validation — a call that
  // threw its documented load-time error (bad definer, unparseable feature)
  // must not poison the slot: the corrected retry is still the file's first
  // *registering* call. Registrations start below, so from this point the
  // call is the one the rule permits.
  filesWithRunFeatures.add(testFile.key);

  registerTest('step definers map only to existing feature files', {}, () => {
    const orphaned = Object.keys(definers).filter((k) => !bases.includes(k));
    assert.deepStrictEqual(orphaned, [], `definers with no matching .feature in ${dir}: ${orphaned.join(', ')}`);
  });

  for (const { base, parsed, registry } of features) {
    registerTest(`${base} :: step definitions are ${wip.has(base) ? 'unambiguous' : 'complete and unambiguous'}`, {}, () => {
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
