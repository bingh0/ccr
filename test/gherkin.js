// @ts-check
// test/gherkin.js
//
// Vendored copy of gherkin-node-test@0.11.0 at commit e0d1ec1 (MIT —
// github.com/bingh0/gherkin-node-test, npm: gherkin-node-test). That package is
// the canonical source; this copy is kept in-tree so ccr's acceptance suite runs
// on a bare `node --test` with zero install, preserving the zero-runtime-
// dependency story. When the parser changes, change it there and re-sync here
// (this file is the upstream index.js with only this vendor note inserted after
// the @ts-check line). e0d1ec1 is 0.11.0 plus the annotation fix that makes
// executeSteps typecheck under the W it declares — folded into the next release.
//
// ccr uses the runner half of this file: parseFeature, StepRegistry,
// executeSteps, runFeature, runFeatures, DataTable, buildSnippet, and
// GherkinSyntaxError. The linter half (lintFeature) and the run manifest ship
// with the copy but are not wired up here — see docs/GHERKIN.md.
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
// The high-level entry point is runFeatures(dir, definers, { wip, manifest }):
// it discovers every *.feature in dir, runs each against its OWN scoped
// registry (step patterns never leak between features), and registers guard
// tests that fail on ambiguous steps, on unbound steps (which would otherwise
// register as TODO — reported as PASSING by node:test), and on definer keys
// that match no feature file. A feature still being bootstrapped opts out of
// the unbound-step ratchet by name via `wip`. `manifest` opts into the run
// manifest — a committed record of what ran, one sorted {file, title, status}
// row per scenario (see createManifestWriter). ONE runFeatures call per test
// file — a second call in the same file is refused as a registered failing
// test (see below).
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
//   - a Feature with no scenarios (a header + narrative registers nothing and
//     would read as a passing file)
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
// LINTER ROLE: lintFeature(text, filename?) exposes the same dialect gate plus
// deterministic spec lints (no-Then, banned vagueness, single-row outlines) as
// pure text-in/findings-out — no fs, no registration — for repos whose runner
// is something else (vitest-cucumber, cucumber-js). See its doc comment.
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
  /* node:coverage ignore next 4 */
  if (isBun) {
    methodRegister(test, title, opts, fn);
    return;
  }
  test(title, opts, fn);
}

/**
 * Register on a method-form test function — skip/todo as methods rather than
 * options. This is bun:test's shape, and vitest's, which is why bindRunner
 * accepts exactly this shape and nothing wider. The shape is strict about
 * `.todo(name, fn)` accepting a body: jest's `test.todo` REJECTS one
 * ("Todo must be called with only a description"), so jest is not this shape
 * — and the body cannot be dropped to accommodate it, because the throwing
 * todo body is load-bearing under `bun test --todo`. `opts.todo` may carry a
 * reason string; method-form runners have nowhere to put it, so the reason
 * stays visible by the same route as on Bun: the todo body throws it.
 * @param {any} t
 * @param {string} title
 * @param {{ skip?: boolean, todo?: boolean | string }} opts
 * @param {() => (void | Promise<void>)} fn
 */
function methodRegister(t, title, opts, fn) {
  if (opts.skip) t.skip(title, fn);
  else if (opts.todo) t.todo(title, fn);
  else t(title, fn);
}

/**
 * Bind the runner entry points to a host test function instead of the
 * runtime's built-in runner. This is the supported way to run features under
 * vitest — the `gherkin-node-test/vitest` entry is exactly
 * `bindRunner(vitest.test)` — or under any runner exposing the method-form
 * shape `test(name, fn)` with `.skip(name, fn)` and `.todo(name, fn)`.
 *
 * Everything else is unchanged: scoped registries, the unbound-step ratchet,
 * the @only and duplicate-title rejections all register through the bound
 * test function. Only the one-runFeatures-call-per-file guard is bypassed —
 * see runFeatures for why it is native-runner-only.
 * @param {any} testFn a `test` function with `.skip` and `.todo` methods
 * @returns {{ runFeature: (parsed: ParsedFeature, registry: StepRegistry<any>) => void,
 *             runFeatureFile: (file: string, registry: StepRegistry<any>) => void,
 *             runFeatures: (dir: string, definers: Record<string, Definer<any>>, opts?: { wip?: Iterable<WipEntry>, manifest?: string }) => void }}
 */
function bindRunner(testFn) {
  if (typeof testFn !== 'function' || typeof testFn.skip !== 'function' || typeof testFn.todo !== 'function') {
    throw new TypeError(
      'bindRunner(test) requires a test function with .skip and .todo methods '
      + '(vitest and bun:test are both this shape); got '
      + (typeof testFn === 'function' ? 'a function without them' : typeof testFn));
  }
  /** @type {typeof registerTest} */
  const register = (title, opts, fn) => methodRegister(testFn, title, opts, fn);
  return {
    runFeature: (parsed, registry) => runFeature(parsed, registry, register),
    runFeatureFile: (file, registry) => runFeatureFile(file, registry, register),
    runFeatures: (dir, definers, opts) => runFeatures(dir, definers, opts, register),
  };
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

/** @typedef {{ keyword: string, text: string, line: number, table?: string[][] }} Step */
/** @typedef {{ name: string, steps: Step[], line: number, tags: string[] }} Scenario */
/** @typedef {{ name: string, line: number, rows: number, header: string[], headerLine: number, placeholders: string[] }} OutlineMeta */
/** @typedef {{ line: number, text: string, inBody: boolean }} NarrativeLine */
/** @typedef {{ feature: string, featureLine: number, background: Step[], scenarios: Scenario[], outlines: OutlineMeta[], narrative: NarrativeLine[], file: string }} ParsedFeature */
/**
 * A step implementation. `W` is the world's ACCRETED shape — what the steps
 * build up over a scenario, not a constructor contract: the world is born
 * `{}`, so a field in `W` proves its key is spelled consistently, never that
 * a step has assigned it yet. Enforced by the consumer's own type-check, not
 * by the runner — the runtime guards below owe nothing to it. Args arrive as
 * the regex capture strings plus, when the step has a table, a trailing
 * DataTable — typed as the union because that is what actually arrives; a
 * captured number is a string until the step coerces it.
 * @template [W=Record<string, any>]
 * @typedef {(world: W & { defer(fn: (world: W) => (void | Promise<void>)): void }, ...args: (string | DataTable)[]) => (void | Promise<void>)} StepFn
 */
/**
 * A step-definer module: receives a feature's scoped registry, defines its
 * steps. The annotation seam for typed worlds — `Definer<MyWorld>` is how a
 * definer passed to runFeatures gets a typed `world` without a cast.
 * `unknown` return, deliberately: define() returns `this`, and definers
 * routinely trail-return the registry by accident.
 * @template [W=Record<string, any>]
 * @typedef {(reg: StepRegistry<W>) => unknown} Definer
 */
/**
 * The instance type of a (possibly typed) registry, exported so consumers of
 * the `export =` entry never have to spell `InstanceType<typeof StepRegistry>`.
 * @template [W=Record<string, any>]
 * @typedef {StepRegistry<W>} Registry
 */

/**
 * Thrown when a feature file uses syntax this parser does not support, or a
 * malformed construct it would otherwise mis-read. The message is prefixed with
 * `file:line:` and `.line` carries the 1-based line number.
 */
class GherkinSyntaxError extends Error {
  /**
   * @param {string} message @param {number} line
   * @param {'dialect' | 'no-scenarios'} [rule] which lint rule this refusal
   *   surfaces as — the parser's refusals are the error tier of the lint, and
   *   lintFeature must not have to re-derive which rule fired from message
   *   text. 'dialect' unless the refusal has its own ratified rule name.
   */
  constructor(message, line, rule = 'dialect') {
    super(message);
    this.name = 'GherkinSyntaxError';
    this.line = line;
    this.rule = rule;
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
  let featureLine = 0;
  let backgroundSeen = false;
  /** @type {Step[]} */
  const background = [];
  /** @type {Scenario[]} */
  const scenarios = [];
  /** @type {OutlineMeta[]} */
  const outlines = [];
  /** @type {NarrativeLine[]} */
  const narrative = [];
  /** @type {Step[] | null} */
  let cur = null;        // array currently collecting steps
  /** @type {{ name: string, steps: Step[], header: string[] | null, headerLine: number, rows: string[][], examplesSeen: boolean, line: number, tags: string[] } | null} */
  let outline = null;    // set while inside a Scenario Outline
  let inExamples = false;
  /** @type {string[]} */
  let featureTags = [];
  /** @type {string[]} */
  let pendingTags = [];  // collected @tags awaiting a Feature:/Scenario:/Outline:

  /**
   * @param {number} line
   * @param {string} msg
   * @param {'dialect' | 'no-scenarios'} [rule]
   * @returns {never}
   */
  const fail = (line, msg, rule) => {
    throw new GherkinSyntaxError(`${filename}:${line}: ${msg}`, line, rule);
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
    const { name, steps, header, headerLine, rows, examplesSeen, line, tags } = outline;
    if (steps.length === 0) fail(line, `Scenario Outline "${name}" has no steps`);
    if (!examplesSeen) fail(line, 'Scenario Outline has no Examples: block');
    if (!header) fail(line, 'Scenario Outline Examples: has no header row');
    if (rows.length === 0) fail(line, 'Scenario Outline Examples: has a header but no data rows');
    // The placeholder names the outline's source actually references — title,
    // step text, and step-table cells, pre-substitution, in first-appearance
    // order. Recorded so the linter's unused-column rule reads the parser's own
    // account of what was referenced, exactly as near-miss-keyword reads its
    // account of what was dropped.
    /** @type {string[]} */
    const placeholders = [];
    const seenRef = new Set();
    /** @param {string} s */
    const collectRefs = (s) => {
      for (const mm of s.matchAll(/<([^>]+)>/g)) {
        if (!seenRef.has(mm[1])) { seenRef.add(mm[1]); placeholders.push(mm[1]); }
      }
    };
    collectRefs(name);
    for (const st of steps) {
      collectRefs(st.text);
      if (st.table) for (const r of st.table) for (const c of r) collectRefs(c);
    }
    outlines.push({ name, line, rows: rows.length, header, headerLine, placeholders });
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
          line: st.line,
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
      flushOutline(); feature = m[1]; featureSeen = true; featureLine = lineNo; featureTags = takeTags(); noTagConflict(featureTags, lineNo); cur = null; inExamples = false; continue;
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
      outline = { name: m[1], steps: [], header: null, headerLine: 0, rows: [], examplesSeen: false, line: lineNo, tags: [...featureTags, ...takeTags()] };
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
      cur.push({ keyword: m[1], text: m[2], line: lineNo });
      continue;
    }
    if (line.startsWith('|')) {
      noTags(lineNo);
      const cells = splitRow(line, lineNo);
      if (outline && inExamples) {
        if (!outline.header) {
          outline.header = cells;
          outline.headerLine = lineNo;
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
    // Anything else (Feature narrative: "As a…/I want…/So that…") is ignored —
    // but recorded: these are exactly the lines the parser drops in silence,
    // and the linter's near-miss-keyword rule reads them off the parse, so
    // "dropped by the parser" and "checked by the lint" can never drift apart.
    // `inBody` = inside a Scenario/Outline/Background body, the scope of the
    // step-keyword half of that rule.
    narrative.push({ line: lineNo, text: line, inBody: cur !== null });
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
  // A Feature with no scenarios is the same hazard one level up: the file
  // registers nothing, contributes zero assertions, and reads as a passing
  // file to every consumer — the runner, the linter, and a human scanning
  // green output. A header plus narrative is exactly how a spec that was
  // *meant* to be written looks.
  if (scenarios.length === 0) {
    // If a construct near miss is why the file is empty ("scenario: s"), name
    // it: "no scenarios" alone points at the wrong line for the most common
    // cause, and lintFeature returns early on a dialect error, so its
    // near-miss-keyword scan never runs for this file.
    let hint = '';
    for (const n of narrative) {
      const c = n.text.match(CONSTRUCT_SHAPE);
      if (!c) continue;
      const exact = CONSTRUCT_BY_KEY.get(c[1].toLowerCase().replace(/\s+/g, ''));
      if (exact && c[0] !== exact) {
        hint = ` (line ${n.line} "${c[0]}" is not the exact construct keyword "${exact}")`;
        break;
      }
    }
    fail(featureLine, `Feature "${feature}" has no scenarios — the file enforces nothing and would read as passing${hint}`, 'no-scenarios');
  }
  return { feature, featureLine, background, scenarios, outlines, narrative, file: filename };
}

// --- Linter -------------------------------------------------------------------

/**
 * @typedef {'error' | 'warn'} LintSeverity
 * @typedef {{ rule: 'dialect' | 'no-scenarios' | 'no-then' | 'vague-then' | 'single-row-outline'
 *                   | 'near-miss-keyword' | 'dropped-prose' | 'duplicate-title' | 'unused-column'
 *                   | 'strict-tag',
 *             severity: LintSeverity, line: number, message: string }} LintFinding
 */

/**
 * Source-level construct titles (Scenario and Scenario Outline, per file) that
 * repeat an earlier title. Shared by the linter's duplicate-title rule and the
 * runner's rejection so the two can never disagree about what counts as a
 * duplicate. Titles are compared pre-expansion: two outlines sharing a title
 * expand to byte-identical test names (the [n] suffix indexes rows within ONE
 * outline), and a plain scenario sharing an outline's title collides with it
 * under any --test-name-pattern that names either.
 * @param {ParsedFeature} parsed
 * @returns {{ kind: string, title: string, line: number, firstLine: number }[]}
 */
function duplicateTitles(parsed) {
  const outlineLines = new Set(parsed.outlines.map((o) => o.line));
  const constructs = [
    ...parsed.scenarios
      .filter((sc) => !outlineLines.has(sc.line))
      .map((sc) => ({ kind: 'Scenario', title: sc.name, line: sc.line })),
    ...parsed.outlines.map((o) => ({ kind: 'Scenario Outline', title: o.name, line: o.line })),
  ].sort((a, b) => a.line - b.line);
  /** @type {Map<string, number>} */
  const firstAt = new Map();
  /** @type {{ kind: string, title: string, line: number, firstLine: number }[]} */
  const dupes = [];
  for (const c of constructs) {
    const first = firstAt.get(c.title);
    if (first !== undefined) dupes.push({ ...c, firstLine: first });
    else firstAt.set(c.title, c.line);
  }
  // Post-expansion backstop: REGISTERED names must be unique even when the
  // source titles differ — a plain scenario literally titled "adds 1 [1]"
  // collides with an outline row's expanded name without any source-level
  // duplicate. Source dupes are reported above with better messages; this
  // pass only adds collisions those didn't imply. (Rows of one outline can
  // never collide with each other — the [n] suffix increments per row.)
  const flaggedLines = new Set(dupes.map((d) => d.line));
  /** @type {Map<string, number>} */
  const nameAt = new Map();
  for (const sc of parsed.scenarios) {
    const prev = nameAt.get(sc.name);
    if (prev === undefined) { nameAt.set(sc.name, sc.line); continue; }
    if (flaggedLines.has(sc.line)) continue;
    dupes.push({ kind: 'Scenario', title: sc.name, line: sc.line, firstLine: prev });
    flaggedLines.add(sc.line);
  }
  return dupes.sort((a, b) => a.line - b.line);
}

/** The primary step keywords; And/But/* inherit the most recent one. */
const PRIMARY_KEYWORDS = new Set(['Given', 'When', 'Then']);

// Case-insensitive lookup from a step keyword to its one correct spelling. `*`
// is excluded: it has no case variants, so it cannot be a near miss.
const STEP_KEYWORD_BY_LOWER = new Map(
  ['Given', 'When', 'Then', 'And', 'But'].map((k) => [k.toLowerCase(), k]));

// A line that is shaped like a construct header — a construct word (any case,
// any spacing) followed by a colon — but is not the one exact form the parser
// recognizes. Shared by the linter's near-miss-keyword rule and the parser's
// no-scenarios hint (module-level consts are initialized before either runs). Keyed by the construct word lowercased with whitespace removed,
// so `SCENARIO OUTLINE:`, `Scenario outline:` and `ScenarioOutline:` all
// resolve to the same correction. `Rule:` is deliberately absent: the exact
// form is itself a dialect error, so a near miss is not a rescue — and
// "rule: never deploy on Friday" is plausible prose.
const CONSTRUCT_SHAPE = /^(feature|background|scenario\s*outline|scenario|examples)\s*:/i;
const CONSTRUCT_BY_KEY = new Map([
  ['feature', 'Feature:'],
  ['background', 'Background:'],
  ['scenario', 'Scenario:'],
  ['scenariooutline', 'Scenario Outline:'],
  ['examples', 'Examples:'],
]);

// Words that make a Then assert nothing checkable. Deliberately short — every
// entry is a word whose presence in an outcome step is near-certainly vacuous
// ("Then it works correctly"). Consumers wanting a house list run their own
// pass over the same parse; this one is the floor, not the ceiling.
const VAGUE_THEN = /\b(works|correctly|properly|as expected|handles|appropriate)\b/i;

/**
 * Lint one feature file's text: the dialect gate plus deterministic spec
 * lints. Pure text-in/findings-out — no filesystem, no environment, no test
 * registration — so it behaves identically on Node, Bun, and Deno, and
 * directory walking stays in the consumer. This is the supported way to use
 * gherkin-node-test as a LINTER inside a repo whose runner is something else
 * (vitest-cucumber, cucumber-js): the linter gates dialect membership and
 * spec quality; the executor's interpretation of the file stays authoritative.
 *
 * Rules:
 *  - `dialect` (error): the text is outside the supported subset — the exact
 *    GherkinSyntaxError the runner would throw, as a finding. The parser stops
 *    at the first violation, so a dialect finding is always alone.
 *  - `no-scenarios` (error): a Feature header with no scenarios under it — the
 *    file enforces nothing and reads as passing to the runner, the linter, and
 *    a human scanning green output. Surfaced by the same parser refusal as
 *    `dialect` (and so also always alone), but under its own rule name: "add a
 *    scenario or delete the file" is a different remedy than "fix this line".
 *  - `no-then` (warn): a scenario whose own steps never resolve to Then — it
 *    runs code but asserts nothing. And/But/* inherit the preceding primary
 *    keyword (a Background is walked first, so a scenario continuing the
 *    Background's context is resolved correctly).
 *  - `vague-then` (warn): a Then-resolved step containing a word from the
 *    banned-vagueness list above.
 *  - `single-row-outline` (warn): a Scenario Outline with one Examples row —
 *    a scenario with extra ceremony, and usually a missing case.
 *  - `duplicate-title` (error): a Scenario or Scenario Outline title already
 *    used earlier in the file. Titles are the runner's only handle on a
 *    scenario — the library rejects @only precisely so that one scenario is
 *    focused via `--test-name-pattern` / `-t` / `--filter`, and a duplicated
 *    title breaks that prescription silently: the pattern matches both copies,
 *    failure reports cannot tell them apart, and two outlines sharing a title
 *    expand to byte-identical test names (the [n] suffix indexes rows within
 *    one outline, not across outlines). Compared pre-expansion, per file.
 *  - `unused-column` (warn): an Examples column no `<placeholder>` in the
 *    outline's title, steps, or step tables ever references — a case someone
 *    wrote down that no assertion consumes. The inverse direction (a
 *    placeholder with no matching column) is already a dialect error. Reported
 *    at the header row's line. Deliberately a warn: a leading label column
 *    (`| case | … |`) that exists for the human reader is a legitimate style,
 *    and repos that ban it can escalate the finding themselves.
 *  - `near-miss-keyword` (warn): a silently dropped line that was almost
 *    certainly meant as syntax, read off the parser's own record of the lines
 *    it ignored as narrative. Two shapes:
 *      - inside a scenario or Background body, a line whose first word matches
 *        a step keyword case-insensitively but not exactly (`when I add 5`,
 *        `GIVEN a counter`) — the requirement it stated is gone;
 *      - anywhere, a line shaped like a construct header but not in the one
 *        exact form the parser recognizes (`scenario: b`, `Scenario : b`,
 *        `SCENARIO OUTLINE: b`) — the construct never starts, and what follows
 *        it silently belongs to whatever came before (a lowercase `scenario:`
 *        merges its steps into the PREVIOUS scenario, unseeable by the
 *        no-steps guard and `no-then` because the scenario never exists).
 *    This is the same hazard as a near-miss semantic tag (`@Skip`), which the
 *    parser rejects outright; a near-miss step or construct keyword still
 *    parses, so it surfaces here instead. The step check is scoped to bodies
 *    because the Feature narrative is prose by design and may open a sentence
 *    with "when" or "and"; the construct check is not scoped, because the
 *    trailing colon makes the line syntax-shaped wherever it appears. `Rule:`
 *    is exempt from the construct check — see CONSTRUCT_BY_KEY. The no-steps
 *    guard and `no-then` between them catch a dropped step only at the
 *    extremes (a scenario's only step, or its only Then); a near miss in a
 *    scenario that keeps a Given and a Then is otherwise invisible.
 *  - `dropped-prose` (warn): any OTHER line inside a scenario, Scenario
 *    Outline, or Background body that the parser dropped as narrative — the
 *    floor under `near-miss-keyword`, so that no in-body line vanishes without
 *    a finding. Prose in a body reads like a requirement and enforces nothing
 *    ("the balance must never go negative"); the remedy is to make it a step
 *    or mark it a `#` comment, which is visibly non-enforcing. A line already
 *    claimed by a near-miss finding is not double-reported: near miss is the
 *    sharper diagnosis. The Feature narrative stays exempt — prose is its job.
 *  - `strict-tag` (error, strict mode only): a `@skip` or `@only` tag.
 *    Reviewed output carries no silent debt or focus: a skip hides a
 *    scenario from every run with no ledger entry, and focus is a per-run
 *    CLI flag by the @only doctrine. `@todo` is deliberately exempt
 *    (visionary ruling, 2026-08-03): the stale-@todo inversion polices it at
 *    run time, so a committed @todo is honest, visible, self-retiring debt.
 *    Reported at the header line of each construct the tag reaches — a
 *    feature-level tag lands on every scenario it hides.
 *
 * Findings from a Scenario Outline are reported once per source construct,
 * not once per expanded row — except a vague-then introduced BY a placeholder
 * substitution, which is reported for exactly the rows that produce it.
 *
 * Severity is descriptive, not policy: `dialect` is an error because the
 * runner would refuse the file, and `duplicate-title` is an error because the
 * runner refuses it too (a registered failing test, same mechanism as @only);
 * the remaining lints warn because adopting them on an existing suite needs a
 * debt register, and that register (a wip-style allowlist, filtering by rule)
 * belongs to the consumer.
 *
 * New rules must pass the four admission tests in docs/lint-admission.md
 * before they appear here — and every rule admitted here must be pinned by a
 * scenario in features/dialect-gate.feature, or it is untested contract.
 * Admission records for shipped rules live in that document's appendix.
 *
 * Strict mode (`opts.strict`) is one bit: every warning above is promoted to
 * an error — same rule, same line, same message — and the strict-only rules
 * (`strict-tag`) join in. Nothing is ever removed or reworded by promotion,
 * so a strict-clean file is clean in default mode by construction. There is
 * no relaxed mode, per the fence: `--strict` promotes, nothing demotes.
 *
 * @param {string} text     raw .feature file contents
 * @param {string} [filename] used only to prefix the dialect finding's message
 * @param {{ strict?: boolean }} [opts]
 * @returns {LintFinding[]} sorted by line, then declaration order
 */
function lintFeature(text, filename = '<feature>', opts = {}) {
  /** @type {ParsedFeature} */
  let parsed;
  try {
    parsed = parseFeature(text, filename);
  } catch (e) {
    if (!(e instanceof GherkinSyntaxError)) throw e;
    // The structured finding already carries .line; strip the parser's
    // file:line prefix so consumers composing "file:line: message" from the
    // finding don't print it twice.
    const prefix = `${filename}:${e.line}: `;
    const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
    return [{ rule: e.rule, severity: 'error', line: e.line, message }];
  }

  /** @type {LintFinding[]} */
  const findings = [];
  const seen = new Set();
  /** @param {LintFinding['rule']} rule @param {LintSeverity} severity @param {number} line @param {string} message */
  const add = (rule, severity, line, message) => {
    // Identical (rule, line, message) triples collapse: expanded outline rows
    // share their source lines, so a row-independent finding lands once while
    // a substitution-dependent one (different message text) lands per row.
    const key = `${rule}\u0000${line}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, severity, line, message });
  };
  /** @param {LintFinding['rule']} rule @param {number} line @param {string} message */
  const warn = (rule, line, message) => add(rule, 'warn', line, message);
  /** @param {Step} st */
  const checkVague = (st) => {
    const m = st.text.match(VAGUE_THEN);
    if (m) {
      warn('vague-then', st.line,
        `vague Then "${st.text}" — "${m[0]}" is not a checkable outcome; name the observable result`);
    }
  };

  // Background steps are shared by every scenario: resolve and lint them once.
  /** @type {string | null} */
  let bgLast = null;
  for (const st of parsed.background) {
    if (PRIMARY_KEYWORDS.has(st.keyword)) bgLast = st.keyword;
    if (bgLast === 'Then') checkVague(st);
  }

  const outlineByLine = new Map(parsed.outlines.map((o) => [o.line, o]));
  for (const sc of parsed.scenarios) {
    const outline = outlineByLine.get(sc.line);
    let last = bgLast;
    let hasThen = false;
    for (const st of sc.steps) {
      if (PRIMARY_KEYWORDS.has(st.keyword)) last = st.keyword;
      if (last === 'Then') { hasThen = true; checkVague(st); }
    }
    if (!hasThen) {
      const label = outline ? `Scenario Outline "${outline.name}"` : `Scenario "${sc.name}"`;
      warn('no-then', sc.line, `${label} has no Then step — it runs code but asserts nothing`);
    }
  }

  for (const o of parsed.outlines) {
    if (o.rows === 1) {
      warn('single-row-outline', o.line,
        `Scenario Outline "${o.name}" has one Examples row — a scenario with extra ceremony, and usually a missing case`);
    }
    // unused-column: read off the parser's own record of which placeholder
    // names the outline's source references (OutlineMeta.placeholders), so the
    // rule cannot disagree with the substitution that actually ran.
    const referenced = new Set(o.placeholders);
    for (const col of o.header) {
      if (!referenced.has(col)) {
        warn('unused-column', o.headerLine,
          `Examples column "${col}" is never referenced by Scenario Outline "${o.name}" — a case written down that no step or title consumes`);
      }
    }
  }

  // duplicate-title: an error, not a warn — the runner refuses the file (a
  // registered failing test, the @only mechanism), because a duplicated title
  // breaks the focus workflow the @only rejection prescribes.
  // Message is runner-neutral on purpose: lint finding text is part of the
  // byte-for-byte parity contract with the cargo sibling, whose name filter
  // is `cargo test -- '<substring>'`, not --test-name-pattern.
  for (const d of duplicateTitles(parsed)) {
    add('duplicate-title', 'error', d.line,
      `${d.kind} title "${d.title}" repeats line ${d.firstLine}'s — the title is the runner's only handle on a scenario (name-filter selection, failure reports), and duplicates cannot be told apart`);
  }

  // near-miss-keyword. Walks the narrative lines the parser recorded as it
  // dropped them — the parser's fall-through IS the definition of "silently
  // dropped", so the rule cannot drift from the parse. A correctly cased step
  // or an exact construct header never appears here: the parser consumed it.
  /** @type {Set<number>} lines a near-miss finding already accounts for */
  const nearMissed = new Set();
  for (const n of parsed.narrative) {
    const c = n.text.match(CONSTRUCT_SHAPE);
    if (c) {
      const exact = CONSTRUCT_BY_KEY.get(c[1].toLowerCase().replace(/\s+/g, ''));
      if (exact && c[0] !== exact) {
        nearMissed.add(n.line);
        warn('near-miss-keyword', n.line,
          `"${c[0]}" is not the construct keyword "${exact}" — constructs are recognized only in that exact form, so this line is parsed as narrative: the construct never starts, and what follows it belongs to whatever came before`);
      }
      continue;
    }
    // Step keywords are checked only inside a body: the Feature narrative is
    // prose by design and may open a sentence with "when" or "and".
    if (!n.inBody) continue;
    // Require a word followed by whitespace and something else: a bare "given"
    // could not have been a step at any casing, so it is ordinary narrative.
    const m = n.text.match(/^(\S+)\s+\S/);
    if (!m) continue;
    const exact = STEP_KEYWORD_BY_LOWER.get(m[1].toLowerCase());
    if (exact && m[1] !== exact) {
      nearMissed.add(n.line);
      warn('near-miss-keyword', n.line,
        `"${m[1]}" is not the step keyword "${exact}" — keywords are exact-case, so this line is parsed as narrative and its requirement is silently dropped`);
    }
  }

  // dropped-prose: the floor under near-miss-keyword — every in-body narrative
  // line the walk above did not claim gets a finding, so no line inside a body
  // vanishes in silence. Near miss keeps its lines: it is the sharper
  // diagnosis, and one finding per dropped line is the accounting contract.
  // Lines ABOVE the Feature: header are covered too (ratified 2026-08-03,
  // owner queue): they are under no Feature, so the narrative exemption does
  // not apply — only tags and # comments live up there.
  for (const n of parsed.narrative) {
    if (nearMissed.has(n.line)) continue;
    if (n.line < parsed.featureLine) {
      warn('dropped-prose', n.line,
        `"${n.text}" precedes the Feature: line — the parser drops it silently and it enforces nothing; move it below the Feature: header, or make it a # comment`);
      continue;
    }
    if (!n.inBody) continue;
    warn('dropped-prose', n.line,
      `"${n.text}" is not a step — the parser drops this line silently and it enforces nothing; make it a Given/When/Then step, or a # comment if it is commentary`);
  }

  if (opts.strict) {
    // strict-tag: reviewed output carries no committed debt or focus (see the
    // rule's entry in the doc comment). Reported at the tagged construct's
    // header line — the parser does not record tag lines, and the tag sits
    // immediately above the header it modifies. Expanded outline rows share
    // their source line and tags, so add()'s dedup collapses them to one
    // finding per construct; a feature-level tag lands on every scenario it
    // reaches, which is exactly how many scenarios it hides.
    // @todo is deliberately NOT here (visionary ruling, 2026-08-03 review,
    // position 17): the stale-@todo inversion polices the tag at run time —
    // a @todo that still fails is honest declared debt reviewed output may
    // carry, and one that passes is already red. Lint has nothing to add.
    for (const sc of parsed.scenarios) {
      for (const tag of ['@skip', '@only']) {
        if (!sc.tags.includes(tag)) continue;
        add('strict-tag', 'error', sc.line, STRICT_TAG_MESSAGE[tag]);
      }
    }
    // Promotion is one bit, applied last: same rule, same line, same message.
    // Strict may add findings and raise severity — never remove or reword —
    // so a strict-clean file is clean in default mode by construction.
    for (const f of findings) if (f.severity === 'warn') f.severity = 'error';
  }

  return findings.sort((a, b) => a.line - b.line);
}

// What strict mode says about each semantic tag. Every message derives its fix
// from the finding alone (admission test 1), and every fix is a diff in the
// reviewed file (admission test 2).
/** @type {Record<string, string>} */
const STRICT_TAG_MESSAGE = {
  '@skip': 'tag "@skip" has no place in reviewed output — a committed skip hides this scenario from every run, debt with no ledger entry; make the scenario pass or delete it',
  '@only': 'tag "@only" has no place in reviewed output — focus is a per-run flag (--test-name-pattern / -t / --filter), never a committed edit; remove the tag',
};

// --- The step-definition lint -------------------------------------------------
//
// lintFeature's companion, aimed at the other side of the contract: the step
// definition source. One default rule, `unearned-absence` (ratified
// 2026-08-25 on the six-corpus measurement — see docs/lint-admission.md),
// fires on absence assertions whose needle is a string or regex LITERAL:
// the unfalsifiable class, where a wrong needle goes green forever. A
// needle the suite itself produced (an identifier) is structurally
// controlled and stays out of the default. `rest-signature` rides along per
// its own ruling: the runner exempts rest-form callbacks from the
// args-consumption guard, so the lint records each one as a sighting.
//
// Sanction is a statement-attached marker naming its rule and its prover:
//   // step-lint: allow unearned-absence -- guarded: the positive assertion above proves the needle
// A marker without a reason sanctions nothing; a marker whose rule does not
// fire on its statement is itself a finding (`stale-marker`). Markers
// attach to STATEMENTS, not lines — the scan joins wrapped statements
// (method-chain continuations rejoin tight) so a formatter's re-wrapping
// can neither detach a marker nor hide a negation.
//
// Pure text-in/findings-out, warn-class, never a gate. Scan-root coverage
// is the caller's job — the one field incident behind this rule came from
// negation lines OUTSIDE the lint's roots, so scan everything your steps
// import.

// The unearned-absence forms: literal-needle negations across every
// assertion dialect in use. `LIT` requires a quote or a regex literal in
// the matcher argument — an identifier-only needle never matches.
const STEP_LINT_NEGATION_FORMS = [
  /\.not\.(?:toContain|toMatch)\(\s*["'`/]/,
  // Literal second argument only: an identifier needle is a value the
  // suite produced, and a trailing string is a failure MESSAGE, not a
  // needle (adversarial review 2026-08-25, findings 3 and 4).
  /assert\.doesNotMatch\([^,]*,\s*["'`/]/,
  /\.ok\(\s*!.*\.(?:includes|match|test)\(\s*["'`]/,
  /\.ok\(\s*!\s*\/.*\/[a-z]*\.test\(/,
  /assert\.notStrictEqual\([^,]*,\s*["'`][^"'`]*["'`]\s*[,)]/,
  /\?\..*\.not\.toBe\(\s*["'`]/,
];

// Any parameter list carrying a rest parameter after the world, followed by
// an arrow or a function body — define-call, function-form, and
// wrapper-defined rest all sight (adversarial review 2026-08-25, finding 7;
// spread-call false positives are structurally unlikely: a call's argument
// list is not followed by `=>` or `{`).
const STEP_LINT_REST_FORM = /\(\s*[\w$]+\s*,[^()]*\.\.\.[^()]*\)\s*(?:=>|\{)/;

const STEP_LINT_MARKER = /step-lint:\s*allow\s+([a-z-]+)(?:\s*--\s*(\S.*))?/;

// A marker RULES only as a comment's own leading content; the same text
// nested inside another comment marker, or quoted anywhere, is MENTION —
// documentation showing the grammar must not trip the grammar (pre-release
// review, finding 9: the lint could not document itself).
const STEP_LINT_MARKER_USE = /^\s*(?:\/\/|\/\*|\*)\s*step-lint:/;
const STEP_LINT_TRAILING_USE = /^\/\/\s*step-lint:/;

/**
 * Group source lines into logical statements — the sanctioning unit.
 *
 * Braces are CONTAINERS, never joiners: a line that opens a block is a
 * complete header statement and resets the continuation carry, so the
 * canonical `module.exports = (reg) => { … }` wrapper can never collapse a
 * definer body into one statement (adversarial review 2026-08-25, the
 * CRITICAL finding — a marker anywhere in the body sanctioned everything).
 * Continuation depth counts parens and brackets only; string and template
 * state carries across lines; regex literals and trailing comments are
 * skipped by the standard preceded-by heuristic. Markers are read from
 * COMMENT text only — a marker inside a string literal is fixture data,
 * not a ruling — and a reasoned marker that ends up attached to nothing
 * (a blank line between it and its statement, or nothing following) is
 * returned as an orphan so the caller can say so loudly: a sanction that
 * silently evaporates is the exact silence this lint exists to refuse.
 * Comment-shaped lines are exempt from scanning per the line-shape lesson
 * (lexing without parser context desyncs; this lint's false-positive path
 * is loud). Two known misreads, both loud-direction: the interior lines of
 * a multi-line template literal scan as code (a negation in template TEXT
 * false-fires visibly), and a keyword-preceded regex (`return /x/.test(y)`)
 * reads as division, which can merge statements but never silently pass
 * one that carries no marker.
 * @param {string} text
 * @returns {{ statements: { line: number, code: string, markers: { rule: string, reason: string | null, line: number }[] }[],
 *             orphans: { rule: string, reason: string | null, line: number }[] }}
 */
function stepLintStatements(text) {
  const lines = text.split('\n');
  /** @type {{ line: number, code: string, markers: { rule: string, reason: string | null, line: number }[] }[]} */
  const statements = [];
  /** @type {{ rule: string, reason: string | null, line: number }[]} */
  const orphans = [];
  /** @type {{ rule: string, reason: string | null, line: number }[]} */
  let pendingMarkers = [];
  /** @type {{ line: number, code: string, markers: { rule: string, reason: string | null, line: number }[] } | null} */
  let current = null;
  let depth = 0;
  let quote = '';
  const flush = () => { if (current) { statements.push(current); current = null; } };

  // One line's code portion and structure: trailing-comment text split off,
  // paren/bracket delta, brace opens/closes, quote state carried in/out.
  const scan = (/** @type {string} */ raw) => {
    let d = 0;
    let opens = 0;
    let closes = 0;
    let codeEnd = raw.length;
    let trailing = '';
    let prev = '';
    /** @type {[number, number][]} */
    const excised = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '/' && raw[i + 1] === '/') { codeEnd = i; trailing = raw.slice(i); break; }
      if (c === '/' && raw[i + 1] === '*') {
        const e = raw.indexOf('*/', i + 2);
        if (e === -1) { codeEnd = i; break; }
        // Excised from the scanned code: an inline block comment (a JSDoc
        // param annotation, typically) must not break a form's shape — a
        // JSDoc'd rest parameter is still a rest parameter.
        excised.push([i, e + 2]);
        i = e + 1;
        continue;
      }
      if (c === '/' && (prev === '' || /[=(\[{,;:!&|?+\-*%~^<>]/.test(prev))) {
        let inClass = false;
        for (i++; i < raw.length; i++) {
          const r = raw[i];
          if (r === '\\') { i++; continue; }
          if (inClass) { if (r === ']') inClass = false; continue; }
          if (r === '[') inClass = true;
          else if (r === '/') break;
        }
        prev = '/';
        continue;
      }
      if ('(['.includes(c)) d++;
      else if (')]'.includes(c)) d--;
      else if (c === '{') opens++;
      else if (c === '}') closes++;
      if (!/\s/.test(c)) prev = c;
    }
    if (quote === "'" || quote === '"') quote = ''; // plain strings never span lines
    let codeStr = raw.slice(0, codeEnd);
    for (let k = excised.length - 1; k >= 0; k--) {
      const [from, to] = excised[k];
      if (from < codeEnd) codeStr = codeStr.slice(0, from) + ' ' + codeStr.slice(Math.min(to, codeEnd));
    }
    return { code: codeStr, trailing, delta: d, opens, closes };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const inTemplate = quote === '`';
    const isComment = !inTemplate
      && (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'));
    if (isComment) {
      const m = STEP_LINT_MARKER_USE.test(raw) ? STEP_LINT_MARKER.exec(raw) : null;
      if (m) {
        const entry = { rule: m[1], reason: m[2] ? m[2].trim() : null, line: i + 1 };
        if (current) current.markers.push(entry);
        else pendingMarkers.push(entry);
      }
      continue;
    }
    if (!trimmed) {
      if (!current) {
        for (const m of pendingMarkers) if (m.reason !== null) orphans.push(m);
        pendingMarkers = [];
      }
      continue;
    }
    const { code, trailing, delta, opens, closes } = scan(raw);
    const codeTrim = code.trim();
    const joinsChain = codeTrim.startsWith('.');
    if (current && (depth > 0 || joinsChain)) {
      current.code += joinsChain ? codeTrim : ` ${codeTrim}`;
    } else {
      flush();
      current = { line: i + 1, code: codeTrim, markers: pendingMarkers };
      pendingMarkers = [];
    }
    const tm = trailing && STEP_LINT_TRAILING_USE.test(trailing) ? STEP_LINT_MARKER.exec(trailing) : null;
    if (tm && current) current.markers.push({ rule: tm[1], reason: tm[2] ? tm[2].trim() : null, line: i + 1 });
    depth = Math.max(0, depth + delta);
    if (opens !== closes) {
      // Block boundary: the header (or closer) is complete, and inner lines
      // start fresh — the container never joins its contents.
      flush();
      depth = 0;
    } else if (depth === 0) {
      const next = lines[i + 1];
      if (!(next && next.trimStart().startsWith('.'))) flush();
    }
  }
  flush();
  for (const m of pendingMarkers) if (m.reason !== null) orphans.push(m);
  return { statements, orphans };
}

/**
 * Lint step-definition source for hollow-binding text shapes. Same finding
 * shape as lintFeature — `{ rule, severity, line, message }[]`, sorted by
 * line, all warn-class. `config.rules` adds `{ pattern, reason }` pairs;
 * all config rules share the rule name `custom`, so one `allow custom`
 * marker sanctions every config rule firing on that statement — a
 * documented granularity limit.
 * @param {string} text step-definition source
 * @param {string} [filename] used only to prefix messages
 * @param {{ rules?: { pattern: RegExp | string, reason: string }[] }} [config]
 * @returns {{ rule: string, severity: 'warn', line: number, message: string }[]}
 */
function lintStepDefinitionSource(text, filename = '<steps>', config = {}) {
  /** @type {{ rule: string, severity: 'warn', line: number, message: string }[]} */
  const findings = [];
  const custom = (config.rules || []).map((r) => ({
    pattern: r.pattern instanceof RegExp ? r.pattern : new RegExp(r.pattern),
    reason: r.reason,
  }));
  const { statements, orphans } = stepLintStatements(text);
  for (const m of orphans) {
    findings.push({
      rule: 'stale-marker', severity: 'warn', line: m.line,
      message: `${filename}:${m.line}: marker names "${m.rule}" but sanctions nothing — a blank line `
        + '(or the end of the file) separates it from any statement; attach it to the statement it '
        + 'rules, or delete it. A ruling that silently evaporates is the silence this lint refuses',
    });
  }
  for (const stmt of statements) {
    /** @type {Set<string>} */
    const fired = new Set();
    const sanctioned = (/** @type {string} */ rule) =>
      stmt.markers.some((m) => m.rule === rule && m.reason !== null);
    const excerpt = stmt.code.length > 60 ? `${stmt.code.slice(0, 60)}…` : stmt.code;
    if (STEP_LINT_NEGATION_FORMS.some((re) => re.test(stmt.code))) {
      fired.add('unearned-absence');
      if (!sanctioned('unearned-absence')) {
        findings.push({
          rule: 'unearned-absence', severity: 'warn', line: stmt.line,
          message: `${filename}:${stmt.line}: absence over a literal needle — \`${excerpt}\` is `
            + 'unfalsifiable when the needle is wrong: the search finds nothing, the line stays green, '
            + 'and what it denies may be present under different words. Prove the needle can fire (a '
            + 'control run, a same-scope positive, or a typed predicate), rewrite in the positive '
            + 'direction, or sanction: // step-lint: allow unearned-absence -- <what proves the needle>',
        });
      }
    }
    if (STEP_LINT_REST_FORM.test(stmt.code)) {
      fired.add('rest-signature');
      if (!sanctioned('rest-signature')) {
        findings.push({
          rule: 'rest-signature', severity: 'warn', line: stmt.line,
          message: `${filename}:${stmt.line}: rest-form step callback — the runner exempts it from the `
            + 'args-consumption guard (Function.length lies for rest), so this signature no longer '
            + 'declares what it consumes. Record the ruling: // step-lint: allow rest-signature -- '
            + '<why this step takes whatever arrives>',
        });
      }
    }
    for (const c of custom) {
      if (!c.pattern.test(stmt.code)) continue;
      fired.add('custom');
      if (sanctioned('custom')) continue;
      findings.push({
        rule: 'custom', severity: 'warn', line: stmt.line,
        message: `${filename}:${stmt.line}: \`${excerpt}\` — ${c.reason} Sanction: `
          + '// step-lint: allow custom -- <what makes this instance sound>',
      });
    }
    for (const m of stmt.markers) {
      if (m.reason !== null && !fired.has(m.rule)) {
        findings.push({
          rule: 'stale-marker', severity: 'warn', line: m.line,
          message: `${filename}:${m.line}: marker names "${m.rule}" but the rule does not fire on `
            + 'this statement — the ruling has outlived its subject; delete the marker, or restore '
            + 'what it sanctioned',
        });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

// --- Step registry ----------------------------------------------------------

/**
 * @template [W=Record<string, any>] the world this registry's steps share —
 *   see StepFn for what `W` does and does not prove
 */
class StepRegistry {
  constructor() {
    /** @type {{ re: RegExp, fn: StepFn<W> }[]} */
    this.steps = [];
  }

  /**
   * @param {RegExp | string} pattern RegExp (capture groups become step args) or exact string
   * @param {StepFn<W>} fn
   * @returns {this}
   */
  define(pattern, fn) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(`^${escapeRegExp(pattern)}$`);
    this.steps.push({ re, fn });
    return this;
  }

  /**
   * @param {string} text
   * @returns {{ fn: StepFn<W>, args: string[], re: RegExp } | null}
   */
  find(text) {
    for (const s of this.steps) {
      const m = text.match(s.re);
      if (m) return { fn: s.fn, args: m.slice(1), re: s.re };
    }
    return null;
  }
}

// --- The args-consumption guard ----------------------------------------------
//
// The ratified convention (2026-08-24, gh#4 item (a)): a step callback
// declares exactly what its sentence produces — the world, then one plain
// positional parameter per capture and per data table. Rest-form is the
// sanctioned "I take whatever" (exempt here, sighted by the companion lint);
// a non-capturing group is the sanctioned "varies but unconsumed"; defaults
// have no place in a step signature. The check runs at INVOKE time — tables
// are appended only then, and `Function.length` lies for rest-style callbacks
// — which also means its reach follows execution: a body that never runs
// (@skip, an execution filter, an unbound todo) is never checked.

/** @type {WeakMap<Function, { rest: boolean, dflt: string | null, declared: number } | null>} */
const signatureCache = new WeakMap();

/**
 * Parse a step callback's parameter list from its source. Returns null when
 * the source is unreadable (native/bound functions) — the guard fails open
 * there rather than guessing. `declared` counts step parameters (world
 * excluded); `dflt` is the first defaulted parameter's name, because a
 * default makes `Function.length` stop counting: an honest signature would
 * read as under-consuming, and on a zero-capture step the default hides
 * entirely — which is why defaults are refused on sight, not counted.
 * @param {Function} fn
 * @returns {{ rest: boolean, dflt: string | null, declared: number } | null}
 */
function analyzeSignature(fn) {
  if (signatureCache.has(fn)) return signatureCache.get(fn) ?? null;
  const src = String(fn);
  /** @type {{ rest: boolean, dflt: string | null, declared: number } | null} */
  let result = null;
  if (!src.includes('[native code]')) {
    /** @type {string[] | null} */
    let params = null;
    const paren = src.indexOf('(');
    const arrow = src.indexOf('=>');
    if (arrow !== -1 && (paren === -1 || arrow < paren)) {
      // Bare-identifier arrow: `w => …` — one parameter, no default, no rest.
      const name = src.slice(0, arrow).replace(/^async\s+/, '').trim();
      params = name ? [name] : [];
    } else if (paren !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = paren; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
        // Unterminated comments cannot appear in a syntactically valid
        // function, but the scan must be total anyway: a failed skip ends
        // the scan (end stays -1 → fail open) instead of cycling.
        else if (c === '/' && src[i + 1] === '*') {
          const close = src.indexOf('*/', i);
          if (close === -1) break;
          i = close + 1;
        } else if (c === '/' && src[i + 1] === '/') {
          const nl = src.indexOf('\n', i);
          if (nl === -1) break;
          i = nl;
        } else if (c === "'" || c === '"' || c === '`') {
          const q = c;
          for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
        }
      }
      if (end !== -1) {
        const span = src.slice(paren + 1, end)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');
        params = [];
        let cur = '';
        let d = 0;
        for (const ch of span) {
          if ('([{'.includes(ch)) d++;
          else if (')]}'.includes(ch)) d--;
          if (ch === ',' && d === 0) { params.push(cur.trim()); cur = ''; continue; }
          cur += ch;
        }
        if (cur.trim()) params.push(cur.trim());
      }
    }
    if (params) {
      let rest = false;
      /** @type {string | null} */
      let dflt = null;
      for (const p of params) {
        if (p.startsWith('...')) { rest = true; continue; }
        let d = 0;
        for (let i = 0; i < p.length; i++) {
          const c = p[i];
          if ('([{'.includes(c)) d++;
          else if (')]}'.includes(c)) d--;
          else if (c === '=' && d === 0 && p[i + 1] !== '>' && p[i + 1] !== '='
            && p[i - 1] !== '=' && p[i - 1] !== '!' && p[i - 1] !== '<' && p[i - 1] !== '>') {
            if (!dflt) dflt = p.slice(0, i).trim();
            break;
          }
        }
      }
      result = { rest, dflt, declared: Math.max(0, params.length - 1) };
    }
  }
  signatureCache.set(fn, result);
  return result;
}

/**
 * The refusal message for one invocation, or null. `produced` is what this
 * invocation carries (captures, plus its data table as one argument).
 * @param {Step} step
 * @param {{ fn: Function, re: RegExp }} found
 * @param {number} produced
 * @returns {string | null}
 */
function consumptionError(step, found, produced) {
  const sig = analyzeSignature(found.fn);
  if (!sig) return null; // unreadable source — fail open, never guess
  if (sig.dflt) {
    return `step "${step.text}": definition ${found.re} defaults parameter "${sig.dflt}" — a step `
      + 'argument always arrives, so a default only hides drift (and Function.length stops counting '
      + 'at it); declare the parameter plainly, or take rest (w, ...args)';
  }
  if (sig.rest) return null; // the sanctioned "I take whatever" — lint-sighted, not refused
  if (produced === sig.declared) return null;
  if (produced > sig.declared) {
    // The table is appended last, so an under-consuming table step always
    // drops it — the worst variant, named as such.
    const table = step.table
      ? (produced - sig.declared === 1 ? ' — its data table would be silently dropped'
        : ' — including its data table, silently dropped')
      : '';
    return `step "${step.text}" produced ${produced} argument(s) but definition ${found.re} declares `
      + `${sig.declared} parameter(s) after the world${table}; consume what the sentence `
      + 'parameterizes, make the unconsumed group(s) non-capturing (?:…), or declare rest (w, ...args)';
  }
  return `step "${step.text}" produced ${produced} argument(s) but definition ${found.re} declares `
    + `${sig.declared} parameter(s) after the world — the extra parameter(s) would be undefined on `
    + 'every run; remove them, or capture in the pattern what they should receive';
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
 * The ambiguity refusal for a list of steps, or null: the first step
 * matching more than one binding, named together with every matching
 * pattern, so the fix (tighten one pattern until exactly one matches) is
 * derivable from the failure alone. One definition shared by the
 * executeSteps preflight and runFeature's registration-time check, so the
 * two can never drift.
 * @template [W=Record<string, any>]
 * @param {Step[]} steps @param {StepRegistry<W>} registry
 * @returns {Error | null}
 */
function ambiguityError(steps, registry) {
  for (const step of steps) {
    const matches = registry.steps.filter((s) => step.text.match(s.re));
    if (matches.length > 1) {
      return new Error(`Ambiguous step: ${step.text}\nmatches ${matches.length} definitions:\n`
        + matches.map((m) => `  ${m.re}`).join('\n')
        + '\ntighten the patterns until exactly one matches — the scenario did not execute');
    }
  }
  return null;
}

/**
 * Run a flat list of steps against a shared world. Throws on an ambiguous
 * step (before any step runs), an undefined step, or a failing assertion.
 * Exposed so the harness self-test can drive it without going through
 * node:test.
 *
 * `world.defer(fn)` registers scenario-scoped cleanup: deferred functions run
 * in reverse (LIFO) order after the steps, INCLUDING when a step failed — so a
 * failing assertion can't leak temp dirs/processes. The step failure, if any,
 * outranks cleanup errors; with no step failure the first cleanup error throws.
 * (`defer` is a reserved key on the world.)
 * @template [W=Record<string, any>]
 * @param {Step[]} steps
 * @param {StepRegistry<W>} registry
 * @param {W} [world]
 * @returns {Promise<W>}
 */
async function executeSteps(steps, registry, world = /** @type {W} */ ({})) {
  // Ambiguity preflight, before ANY step runs: a step matching two bindings
  // must fail the scenario without executing it — which binding would have
  // run is silent information, and running "up to the ambiguous step" would
  // leak a partial execution into the world.
  const amb = ambiguityError(steps, registry);
  if (amb) throw amb;
  /** @type {Array<(w: W) => any>} */
  const deferred = [];
  // The world a step sees is W plus the defer seam — derived from StepFn's
  // own first parameter, so this view and the declared contract can't drift.
  const w = /** @type {Parameters<StepFn<W>>[0]} */ (world);
  w.defer = (fn) => { deferred.push(fn); };
  // Failure is a FLAG, not a truthy value: `throw undefined` must still fail
  // the scenario — a falsy throw read through truthiness would report a
  // failing step as passing (and, under the @todo inversion, as a false
  // "stale tag" red telling the author to remove a tag that is not stale).
  let failed = false;
  /** @type {unknown} */
  let failure;
  try {
    for (const step of steps) {
      const found = registry.find(step.text);
      if (!found) {
        throw new Error(`Undefined step: ${step.text}\nDefine it with:\n${buildSnippet(step.text)}`);
      }
      const args = step.table ? [...found.args, new DataTable(step.table)] : found.args;
      // The args-consumption guard, per invocation: what this step produced
      // against what the signature declares (see consumptionError). Checked
      // before the body runs — a refused binding must not half-execute.
      const refusal = consumptionError(step, found, args.length);
      if (refusal) throw new Error(refusal);
      await found.fn(w, ...args);
    }
  } catch (e) {
    failed = true;
    failure = e;
  }
  for (let i = deferred.length - 1; i >= 0; i--) {
    try { await deferred[i](w); } catch (e) {
      if (!failed) { failed = true; failure = e; }
    }
  }
  if (failed) throw failure;
  return world;
}

/**
 * Register one runner test per scenario. Scenarios whose steps aren't all
 * defined register as TODO (see runFeatures for the guard that keeps TODO from
 * silently swallowing a bound feature). Tag mapping: @skip → skipped; @todo →
 * inverted (xfail) as a plain test: the body runs on every runtime, an
 * expected failure is printed and gates nothing, and a @todo that PASSES is
 * red naming the stale tag. (Plain registration means the JS runtimes show
 * no todo marker for these — todo-ness lives in the printed line, the
 * feature file, and the manifest row; the cargo sibling's harness supports
 * kind markers and keeps its [todo] label — accepted asymmetry, ratified
 * 2026-08-03.) @only maps to NOTHING — it registers a failing test
 * instead, because the runners' focus semantics are irreconcilable: Node keeps
 * only: inert without --test-only; Bun and Deno focus the file on every run
 * with no flag, and Deno exits 0 doing it, so a committed @only would silently
 * narrow a CI run there. Rejection is uniform, additive (every scenario still
 * registers and runs — nothing narrows), and REGISTERED rather than thrown, so
 * Deno's load-throw swallow can't eat it. Focus one scenario with the runner's
 * own per-run flag instead: `node --test --test-name-pattern <re>`,
 * `bun test -t <re>`, or `deno test --filter <text>` — a CLI argument can't be
 * committed into the suite, which is the point.
 * @template [W=Record<string, any>]
 * @param {ParsedFeature} parsed
 * @param {StepRegistry<W>} registry
 * @param {typeof registerTest} [register] test-registration hook; supplied by
 *   bindRunner, defaults to the runtime's native runner
 * @param {ManifestRecorder | null} [recorder] run-manifest recorder; supplied
 *   by runFeatures when its `manifest` option is set
 */
function runFeature(parsed, registry, register = registerTest, recorder = null) {
  const base = featureBase(parsed.file);
  if (parsed.scenarios.some((sc) => sc.tags.includes('@only'))) {
    const msg = `${parsed.file}: @only is not supported; run one scenario with `
      + '`node --test --test-name-pattern <re>` / `bun test -t <re>` / `deno test --filter <text>`';
    register(`${base} :: @only is not supported`, {}, () => { throw new Error(msg); });
  }
  // Duplicate titles are rejected the same way as @only, and for the same
  // reason: the @only rejection prescribes focusing one scenario by title
  // pattern, and a duplicated title silently breaks that prescription — the
  // pattern matches every copy, and two outlines sharing a title expand to
  // byte-identical test names. Rejection is additive: every scenario below
  // still registers and runs; nothing narrows.
  const dupes = duplicateTitles(parsed);
  if (dupes.length) {
    const list = dupes.map((d) => `"${d.title}" (lines ${d.firstLine} and ${d.line})`).join('; ');
    register(`${base} :: scenario titles must be unique`, {}, () => {
      throw new Error(
        `${parsed.file}: duplicate scenario title(s): ${list} — the title is how one scenario is `
        + 'focused (--test-name-pattern / -t / --filter) and how failures are reported; rename the copies apart');
    });
  }
  // Third rejection, same additive shape: a definition no scenario consumes
  // is dead code in the step layer — the wip ratchet's dual (wip catches
  // scenarios without definitions; this catches definitions without
  // scenarios). Consumption is counted HERE, at registration, in a pass of
  // its own: every scenario counts — @skip'd, @todo'd, and wip-held rows
  // included — because registration runs under every execution filter, and
  // the count must not ride along inside the unbound-step filter below
  // (full evaluation is incidental there; an early-exit rewrite would
  // silently stop counting for wip-held rows while both stayed green). A
  // definition matched by an ambiguous step still counts as consumed:
  // ambiguity carries its own refusal, and the remedy here must stay
  // unique — delete the definition, or write the scenario it serves.
  const consumed = new Set();
  for (const sc of parsed.scenarios) {
    for (const step of [...parsed.background, ...sc.steps]) {
      for (const def of registry.steps) {
        if (step.text.match(def.re)) consumed.add(def);
      }
    }
  }
  const unused = registry.steps.filter((d) => !consumed.has(d));
  if (unused.length) {
    const list = unused.map((d) => String(d.re)).join('; ');
    register(`${base} :: every definition has a consumer`, {}, () => {
      throw new Error(
        `${parsed.file}: unused step definition(s) registered by the "${base}" definer: ${list} — `
        + 'matched by no scenario step; delete the definition, or restore the scenario meant to '
        + 'consume it (a spec-first consumer can be held in the wip register while the code catches up)');
    });
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
      recorder?.static(parsed.file, sc.name, 'unbound');
      register(title, { todo: reason }, () => { throw new Error(reason); });
      continue;
    }
    // Ambiguity is a BINDING defect, so it is detected at registration and
    // outranks the tags below: @skip must not park it (skip means "don't
    // run", never "don't bind" — the same precedence the unbound check above
    // applies), and @todo must not wear it as declared debt (the inversion
    // would print a binding defect as an expected failure). The refusal
    // registers as a plain failing test either way.
    const amb = ambiguityError(steps, registry);
    if (amb) {
      const refuse = async () => { throw amb; };
      register(title, {}, recorder ? recorder.wrap(parsed.file, sc.name, refuse) : refuse);
      continue;
    }
    const tags = new Set(sc.tags);
    const body = async () => { await executeSteps(steps, registry); };
    // @todo is inverted (xfail), and registered as a PLAIN test so the
    // inversion is the verdict on every runtime — the runtimes' own todo
    // modes disagree about whether todo bodies even run (node always, bun
    // only under --todo, Deno never), and node reports a failing todo as
    // passing, which would let a stale tag hide. Inverted, the declared debt
    // runs everywhere: while the scenario still fails, the failure is
    // printed and gates nothing; the run that would first turn it green
    // goes red instead, naming the stale tag — the same one-way ratchet the
    // wip register applies to unbound scenarios.
    if (tags.has('@todo')) {
      const inverted = async () => {
        try {
          await body();
        } catch (e) {
          const first = String(/** @type {any} */ (e)?.message ?? e).split('\n')[0];
          console.error(`@todo "${title}" fails as declared — gating nothing until it passes: ${first}`);
          return;
        }
        throw new Error(
          `${parsed.file}: @todo scenario "${sc.name}" now passes — the tag is stale; remove @todo so the scenario gates the run`);
      };
      // Execution-recorded, unlike @skip: the inversion runs everywhere, so
      // the row is deterministic — 'todo' while the debt still fails, and
      // 'failed' when the tag is stale, so a red run's account explains
      // itself (see wrap's mapping doc).
      register(title, {}, recorder
        ? recorder.wrap(parsed.file, sc.name, inverted, { ok: 'todo', err: 'failed' })
        : inverted);
      continue;
    }
    if (tags.has('@skip')) {
      // A skipped scenario's status comes from its TAG: skip bodies run
      // nowhere, so 'skipped' is recorded at registration — see
      // createManifestWriter's determinism rules.
      recorder?.static(parsed.file, sc.name, 'skipped');
      register(title, { skip: true }, body);
      continue;
    }
    if (recorder) {
      register(title, {}, recorder.wrap(parsed.file, sc.name, body));
      continue;
    }
    register(title, {}, body);
  }
}

/**
 * @template [W=Record<string, any>]
 * @param {string} file
 * @param {StepRegistry<W>} registry
 * @param {typeof registerTest} [register] test-registration hook; supplied by
 *   bindRunner, defaults to the runtime's native runner
 */
function runFeatureFile(file, registry, register = registerTest) {
  runFeature(parseFeature(fs.readFileSync(file, 'utf8'), file), registry, register);
}

// --- Run manifest -------------------------------------------------------------

/** @typedef {'passed' | 'failed' | 'skipped' | 'todo' | 'unbound'} ManifestStatus */

// The account's first line: an in-band schema-version declaration, so the
// file explains itself on any machine with no other context. Version bumps
// ONLY on a change that would mislead a version-1 reader (a new status value
// is not one; a changed row shape or sort order is). Format-named, not
// tool-named — gherkin-cargo-test writes byte-identical accounts.
const MANIFEST_VERSION_LINE = JSON.stringify({ 'run-manifest': 1 });

/**
 * Compare two strings by Unicode CODE POINT — the manifest's sort order. JS
 * string comparison is UTF-16 code-unit order, which disagrees with
 * code-point order for astral characters (an emoji sorts before U+FF3A by
 * code unit, after it by code point). Rust's str ordering IS code-point
 * order, so the byte-parity contract with the cargo sibling pins code
 * points. Lone surrogates (not producible from a UTF-8 feature file) still
 * compare deterministically.
 * @param {string} a @param {string} b @returns {number}
 */
function compareCodePoints(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = /** @type {number} */ (a.codePointAt(i));
    const cb = /** @type {number} */ (b.codePointAt(j));
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

/**
 * The recorder behind runFeatures' `manifest` option: a written account of
 * what ran — every registered scenario as one `{file, title, status}` row —
 * so a downstream reader can notice what DIDN'T run. A feature file absent
 * from the runner is absent from every manifest, and that absence is
 * detectable by joining manifests against the feature-file tree; test results
 * alone can never show it. Rows are scenarios only (path + title is the whole
 * identity scheme — rename resolution is a reader's competence, not this
 * file's); guard tests have no feature-file identity and fail the run
 * loudly on their own channel, so they are not rows.
 *
 * Reporter-shaped, deliberately: it observes outcomes and writes bytes; it
 * never gates a test, never reads a previous manifest, never alters what
 * registers — the runner stays stateless.
 *
 * Determinism rules, so a committed manifest's bytes change only when results
 * change:
 *  - No timestamps, no durations — volatile fields churn git for nothing;
 *    dating comes from the commit that touches the file.
 *  - Rows sort by file, then title, then status (code-point order) and
 *    serialize as NDJSON with fixed key order; `file` is recorded RELATIVE to
 *    the manifest file's own directory and `\` normalizes to `/`, so the same
 *    run writes the same bytes on every platform, at every checkout path, and
 *    however the caller spelled the feature dir — an absolute `dir` argument
 *    must not leak machine paths into committed bytes.
 *  - @skip / unbound are recorded at REGISTRATION, never from body
 *    execution: those bodies run nowhere or inconsistently (the runtimes
 *    disagree about todo-mode bodies — node always executes them, bun only
 *    under --todo, Deno never). @todo records from EXECUTION since the
 *    inversion made its body run everywhere: 'todo' while the declared debt
 *    still fails, 'failed' when the tag has gone stale — a red run's
 *    account must explain the red (ratified 2026-08-03). Plain bound
 *    scenarios record passed or failed.
 *  - The file is written exactly ONCE, when every expected outcome has been
 *    recorded. A filtered (--test-name-pattern / -t / --filter), bailed, or
 *    crashed run never writes — a partial account must not overwrite a full
 *    one. A write failure (missing directory, missing Deno --allow-write) is
 *    loud: it throws from the last scenario's body — unless that scenario
 *    itself failed, in which case its own failure outranks the write failure
 *    (executeSteps' cleanup precedence), and the next full run stays loud.
 *  - The FIRST LINE is the in-band schema declaration (`{"run-manifest":1}`)
 *    — see MANIFEST_VERSION_LINE for the versioning rule. Zero rows write
 *    the declaration line alone (unreachable from the public path: an empty
 *    feature directory is refused before a recorder exists, and every
 *    parsed file carries at least one scenario).
 *  - A RE-INVOKED scenario body is refused loudly, the @only doctrine one
 *    level up. vitest's retry and repeats both re-run the same registered
 *    body, and they assign OPPOSITE verdicts to the same observed sequence
 *    (fail-then-pass is a pass under retry, a fail under repeats) — from
 *    inside the body the two modes are indistinguishable, so no recording
 *    rule can be honest in both. The second invocation throws a named error
 *    (failing the run on every runtime) and poisons the recorder: nothing
 *    further is written. A run without failures never triggers retry, so
 *    deterministic suites never see the refusal; bun's --rerun-each re-runs
 *    whole files (fresh recorder per run) and is naturally immune.
 * @param {string} manifestPath
 */
function createManifestWriter(manifestPath) {
  /** @type {{ file: string, title: string, status: ManifestStatus }[]} */
  const rows = [];
  let pending = 0;        // wrapped scenario bodies not yet resolved
  let registered = false; // set by done() once every row source is known
  let poisoned = false;   // a body was re-invoked; the account is unreliable
  const base = path.dirname(path.resolve(manifestPath));
  /** @param {string} f */
  const norm = (f) => path.relative(base, path.resolve(f)).split(path.sep).join('/');
  const maybeWrite = () => {
    if (poisoned || !registered || pending > 0) return;
    // Every account begins with the in-band schema declaration — the file
    // must explain itself to whoever holds it, with no other context. The
    // key names the FORMAT, not the tool: the cargo sibling writes these
    // exact bytes too. Zero rows (unreachable from the public path — an
    // empty directory is refused before a recorder exists) still write the
    // declaration line: whatever this writer writes is an account.
    const text = MANIFEST_VERSION_LINE + '\n' + [...rows]
      .sort((a, b) => compareCodePoints(a.file, b.file)
        || compareCodePoints(a.title, b.title)
        || compareCodePoints(a.status, b.status))
      .map((r) => JSON.stringify({ file: r.file, title: r.title, status: r.status }) + '\n')
      .join('');
    fs.writeFileSync(manifestPath, text);
  };
  return {
    /**
     * Record a status known at registration time (@skip / @todo / unbound).
     * @param {string} file @param {string} title @param {ManifestStatus} status
     */
    static(file, title, status) {
      rows.push({ file: norm(file), title, status });
    },
    /**
     * Wrap a scenario body: its resolution records a row (the failure still
     * propagates — recording never swallows it). A plain bound scenario maps
     * resolve → 'passed', throw → 'failed'. The @todo inversion passes its
     * own mapping: the INVERTED body resolving means the debt still fails
     * (row 'todo'), and it throwing means the tag went stale — the run is
     * red and the account must be able to explain it, so the row is
     * 'failed', never a green-looking declaration (ratified 2026-08-03,
     * owner queue). Both mappings are execution-recorded and deterministic:
     * @todo bodies run on every runtime since the inversion.
     * @param {string} file @param {string} title
     * @param {() => Promise<void>} fn
     * @param {{ ok: ManifestStatus, err: ManifestStatus }} [statuses]
     * @returns {() => Promise<void>}
     */
    wrap(file, title, fn, statuses = { ok: 'passed', err: 'failed' }) {
      pending += 1;
      let invoked = false;
      return async () => {
        if (invoked) {
          // Poison FIRST: this throw fails the run, but the runner may have
          // already observed every first invocation and written — later
          // completions must not write again on top of a refused run.
          poisoned = true;
          throw new Error(
            `run manifest: scenario "${title}" was invoked again after its outcome was recorded — `
            + 'this runner re-runs test bodies (vitest retry/repeats?). Retry and repeats assign '
            + 'opposite verdicts to the same rerun sequence, so no manifest row can be honest about '
            + 'one; the manifest is refused instead. Disable retry/repeats for this suite, or drop '
            + 'the manifest option.');
        }
        invoked = true;
        let threw = false;
        try {
          await fn();
        } catch (e) {
          threw = true;
          throw e;
        } finally {
          rows.push({ file: norm(file), title, status: threw ? statuses.err : statuses.ok });
          pending -= 1;
          try {
            maybeWrite();
          } catch (e) {
            // The scenario's own failure outranks a write failure — the same
            // precedence executeSteps gives step failures over cleanup
            // errors. A green last scenario still surfaces the write failure
            // loudly, and the next full run stays loud either way.
            if (!threw) throw e;
          }
        }
      };
    },
    /** Every registration has happened; write now if nothing is pending. */
    done() {
      registered = true;
      maybeWrite();
    },
  };
}

/** @typedef {ReturnType<typeof createManifestWriter>} ManifestRecorder */

// One live claim per manifest path per process: two runFeatures calls whose
// manifests share one path would silently overwrite each other's account —
// last writer wins, and each write is "complete" for only its own directory.
// The claim is keyed by the CALL's identity (test file + feature dir), not
// counted, so a watch-mode re-execution of the same call re-claims its own
// path freely — the same reason the one-call-per-file rule keys on identity.
// The refusal is a registered failing test, never a throw (the one-call
// rule's Deno-swallow reasoning applies unchanged), and it is additive: the
// call's scenarios still register and run; only its manifest is withheld.
// Two calls in PARALLEL processes (node's per-file isolation) are out of any
// in-process guard's sight — keep one path per feature directory.
/** @type {Map<string, { identity: string, dir: string }>} */
const manifestClaims = new Map();

// --- High-level runner --------------------------------------------------------

/**
 * One `wip` allowlist entry: a feature basename (the whole feature is still
 * bootstrapping) or `{ feature, scenarios }` (only those scenarios are, named
 * by source title). A structured shape rather than a `"base::title"` string
 * because titles are free text — no delimiter is safe to split on.
 * @typedef {string | { feature: string, scenarios: string[] }} WipEntry
 */

/**
 * Discover and run every *.feature in `dir`, each against its OWN scoped
 * registry — one feature's step patterns can never match another feature's
 * steps, so there is no global step namespace to collide in.
 *
 * Guards registered alongside the scenarios:
 *  - every key in `definers` and every feature named in `wip` must match an
 *    existing feature file (a renamed feature can't silently strand its steps
 *    — or its allowlist entry);
 *  - within each feature, every step must match exactly one definition — no
 *    ambiguity, and (unless allowed by `wip`) no unbound steps, because
 *    unbound scenarios register as TODO, which node:test reports as PASSING.
 *    The failure message includes a paste-ready snippet per missing step.
 *    @skip'd scenarios are ratcheted too: skip means "don't run", never
 *    "don't bind";
 *  - `wip` itself is ratcheted: an entry whose feature (or scenario) has
 *    become fully bound FAILS until the entry is removed — an allowlist that
 *    could rot silently would hold the unbound-step ratchet open for nothing.
 *
 * `wip` entries come in two shapes. A feature basename holds the whole
 * feature open. `{ feature, scenarios }` holds open only the named scenarios
 * — by SOURCE title, so an outline's title covers every expanded row — and
 * keeps the full ratchet on the rest of the feature. Scenario wip means
 * "expected-unbound", never "skip": a listed scenario whose steps all happen
 * to be bound runs normally (and trips the staleness guard). The two shapes
 * are mutually exclusive per feature — a basename entry would silently
 * swallow a scenario list for the same feature, so that combination throws.
 *
 * One runFeatures call per test file, enforced: a second call in the same
 * test file registers a single failing test naming the fix and does nothing
 * else. See filesWithRunFeatures above for why (Deno silently swallows a
 * load-time throw once an earlier call has registered a test — a second call
 * is exactly where a bad definer or an unparseable feature would vanish).
 * Give each feature directory its own test file.
 *
 * `manifest` (opt-in) names a file to receive the run manifest: one sorted
 * `{file, title, status}` NDJSON row per registered scenario (post-expansion —
 * outline rows land individually, exactly as they registered), written only
 * when the full run has been observed. See createManifestWriter for the
 * format and determinism rules. One manifest per runFeatures call — and since
 * the rule above is one call per test file, per feature directory. A second
 * call claiming a path this process already claimed is refused as a
 * registered failing test (see manifestClaims); calls in parallel processes
 * are out of any guard's sight — keep one path per feature directory.
 * Under Deno the write needs `--allow-write=<its directory>`.
 *
 * @param {string} dir directory containing .feature files
 * @param {Record<string, Definer<any>>} definers feature basename → step definer;
 *   annotate an entry `Definer<MyWorld>` to type its steps' world — the record
 *   stays `any` deliberately: each feature has its OWN world, and one type
 *   parameter here would collapse them all into one
 * @param {{ wip?: Iterable<WipEntry>, manifest?: string }} [opts] features (or
 *   scenarios) still bootstrapping (TODO allowed); run-manifest output path
 * @param {typeof registerTest} [register] test-registration hook; supplied by
 *   bindRunner, defaults to the runtime's native runner
 */
function runFeatures(dir, definers, opts = {}, register = registerTest) {
  // The one-call-per-file rule is native-runner-only. Both of its halves are
  // wrong under an injected runner: the Deno load-throw swallow it guards
  // against doesn't exist there (vitest reports a load-time throw as a
  // collection error, loudly), and its bookkeeping breaks — vitest's watch
  // mode re-executes a spec file inside a worker whose require cache (and so
  // filesWithRunFeatures) survives, so the second run of the SAME single call
  // would trip the guard.
  const native = register === registerTest;
  const testFile = currentTestFile();
  if (native && filesWithRunFeatures.has(testFile.key)) {
    register('runFeatures: one call per test file', {}, () => {
      throw new Error(
        `runFeatures(${JSON.stringify(dir)}, …) is a second runFeatures call in ${testFile.display} — `
        + 'one call per test file: a load-time error in a later call (a non-function definer, an '
        + 'unparseable feature file) is silently swallowed under Deno once an earlier call has '
        + 'registered a test. Give each feature directory its own test file.');
    });
    return;
  }

  // Normalize the wip allowlist into its two granularities. Shape errors
  // throw at load, like a bad definer: a malformed allowlist must not become
  // a silently narrower (or wider) one.
  /** @type {Set<string>} */
  const wip = new Set();
  /** @type {Map<string, Set<string>>} */
  const wipScenarios = new Map();
  for (const entry of opts.wip || []) {
    if (typeof entry === 'string') { wip.add(entry); continue; }
    const shaped = !!entry && typeof entry === 'object'
      && typeof entry.feature === 'string'
      && Array.isArray(entry.scenarios) && entry.scenarios.length > 0
      && entry.scenarios.every((t) => typeof t === 'string');
    if (!shaped) {
      throw new TypeError(
        `wip entry must be a feature basename or { feature, scenarios: [source titles] }, got ${JSON.stringify(entry)}`);
    }
    const titles = wipScenarios.get(entry.feature) || new Set();
    for (const t of entry.scenarios) titles.add(t);
    wipScenarios.set(entry.feature, titles);
  }
  for (const base of wipScenarios.keys()) {
    if (wip.has(base)) {
      throw new TypeError(
        `'${base}' is in wip both as a whole feature and per-scenario — the basename entry `
        + 'would silently swallow the scenario list; keep exactly one of the two');
    }
  }

  // A malformed manifest option throws at load, like a bad definer or a bad
  // wip entry: '' or a non-string must not silently become "no manifest" —
  // that would be coverage accounting that silently doesn't run, the exact
  // class the manifest exists to expose.
  if (opts.manifest !== undefined && (typeof opts.manifest !== 'string' || opts.manifest === '')) {
    throw new TypeError(`manifest must be a non-empty file path, got ${JSON.stringify(opts.manifest)}`);
  }

  // Directory refusals are REGISTERED failing tests, not throws, for the
  // Deno-swallow reason the one-call rule documents — and they consume the
  // one-call slot, because they DID register. A missing directory would
  // otherwise surface as a raw ENOENT stack, and an empty one as a silently
  // green zero-scenario run: coverage accounting that quietly enforces
  // nothing, the exact class this runner exists to refuse.
  /** @type {string[]} */
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.feature')).sort();
  } catch (e) {
    // Total: every readdir failure is a registered refusal naming the path —
    // ENOENT and ENOTDIR are the fix-your-call cases with their own words; a
    // permission error keeps the OS detail. A raw stack here would be the
    // exact loudness-without-remedy this refusal exists to replace.
    const code = /** @type {any} */ (e)?.code;
    const [title, msg] = code === 'ENOENT'
      ? ['runFeatures: the feature directory is missing',
        `runFeatures: feature directory ${JSON.stringify(dir)} does not exist — nothing was enforced; `
        + 'point the runner at the directory holding the .feature files']
      : code === 'ENOTDIR'
        ? ['runFeatures: the feature path is not a directory',
          `runFeatures: ${JSON.stringify(dir)} is not a directory — nothing was enforced; `
          + 'point the runner at the directory holding the .feature files, not at a file']
        : ['runFeatures: the feature directory is unreadable',
          `runFeatures: cannot read feature directory ${JSON.stringify(dir)} — nothing was enforced: ${e}`];
    if (native) filesWithRunFeatures.add(testFile.key);
    register(title, {}, () => { throw new Error(msg); });
    return;
  }
  if (files.length === 0) {
    if (native) filesWithRunFeatures.add(testFile.key);
    register('runFeatures: the feature directory is empty', {}, () => {
      throw new Error(
        `runFeatures: no .feature files were found in ${JSON.stringify(dir)} — nothing was enforced; `
        + 'add the feature files there, or point the runner at the directory holding them');
    });
    return;
  }
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
  if (native) filesWithRunFeatures.add(testFile.key);

  // Created after validation, alongside the one-call slot: a call that threw
  // its load-time error never observed a full run, so it must not write.
  // A path another call already claimed is refused (see manifestClaims):
  // the refusal registers a failing test and withholds only the manifest —
  // every scenario below still registers and runs.
  /** @type {ManifestRecorder | null} */
  let recorder = null;
  if (opts.manifest) {
    const manifest = opts.manifest;
    const identity = `${testFile.key}\u0000${dir}`;
    const claim = manifestClaims.get(manifest);
    if (claim && claim.identity !== identity) {
      register('run manifest: one path per runFeatures call', {}, () => {
        throw new Error(
          `${JSON.stringify(manifest)} is already the manifest of the runFeatures call for `
          + `${JSON.stringify(claim.dir)} — two accounts sharing one path silently overwrite each `
          + 'other (last writer wins, each complete for only its own directory); give each feature '
          + 'directory its own manifest path');
      });
    } else {
      manifestClaims.set(manifest, { identity, dir });
      recorder = createManifestWriter(manifest);
    }
  }

  register('step definers and wip entries map only to existing feature files', {}, () => {
    const orphaned = Object.keys(definers).filter((k) => !bases.includes(k));
    assert.deepStrictEqual(orphaned, [], `definers with no matching .feature in ${dir}: ${orphaned.join(', ')}`);
    const wipOrphaned = [...wip, ...wipScenarios.keys()].filter((k) => !bases.includes(k));
    assert.deepStrictEqual(wipOrphaned, [], `wip entries with no matching .feature in ${dir}: ${wipOrphaned.join(', ')}`);
  });

  for (const { base, parsed, registry } of features) {
    const titles = wipScenarios.get(base);
    const mode = wip.has(base) ? 'unambiguous'
      : titles ? 'complete outside wip and unambiguous'
        : 'complete and unambiguous';
    register(`${base} :: step definitions are ${mode}`, {}, () => {
      const allSteps = [...parsed.background, ...parsed.scenarios.flatMap((s) => s.steps)];
      const ambiguous = allSteps
        .filter((s) => registry.steps.filter((d) => s.text.match(d.re)).length > 1)
        .map((s) => `"${s.text}"`);
      assert.strictEqual(ambiguous.length, 0, `steps matching >1 definition: ${ambiguous.join('; ')}`);
      /** @param {Step[]} steps */
      const unbound = (steps) => [...new Set(steps.filter((s) => !registry.find(s.text)).map((s) => s.text))];
      if (wip.has(base)) {
        // The staleness half of the ratchet: an allowlist that could rot
        // silently would hold the unbound-step check open for nothing.
        assert.notStrictEqual(unbound(allSteps).length, 0,
          `'${base}' is fully bound — remove it from wip; the entry now only holds the unbound-step ratchet open`);
        return;
      }
      if (!titles) {
        const unresolved = unbound(allSteps);
        assert.strictEqual(unresolved.length, 0,
          `unbound steps would register as TODO (passing); bind them or add '${base}' to wip:\n\n`
          + unresolved.map((t) => `// ${t}\n${buildSnippet(t)}`).join('\n\n'));
        return;
      }
      // Scenario-scoped wip. Titles are SOURCE titles: a plain scenario's
      // name, or an outline's pre-substitution title covering every expanded
      // row (expanded scenarios keep their outline's source line — the same
      // resolution duplicateTitles uses). The duplicate-title rejection is
      // what makes a source title an unambiguous address here.
      /** @type {Map<number, string>} */
      const outlineByLine = new Map(parsed.outlines.map((o) => [o.line, o.name]));
      /** @param {ParsedFeature['scenarios'][number]} sc */
      const sourceTitle = (sc) => outlineByLine.get(sc.line) ?? sc.name;
      const known = new Set(parsed.scenarios.map(sourceTitle));
      const unknown = [...titles].filter((t) => !known.has(t));
      assert.deepStrictEqual(unknown, [],
        `wip scenario titles with no matching Scenario/Scenario Outline in ${parsed.file}: `
        + unknown.map((t) => `'${t}'`).join(', '));
      // Background steps belong to every scenario, so they are enforced
      // exactly as often as an enforced scenario exists to carry them.
      const enforced = parsed.scenarios.filter((sc) => !titles.has(sourceTitle(sc)));
      const unresolved = unbound(enforced.flatMap((sc) => [...parsed.background, ...sc.steps]));
      assert.strictEqual(unresolved.length, 0,
        `unbound steps would register as TODO (passing); bind them or add their scenarios to '${base}''s wip entry:\n\n`
        + unresolved.map((t) => `// ${t}\n${buildSnippet(t)}`).join('\n\n'));
      // Per-scenario staleness, same ratchet as the whole-feature form.
      const stale = [...titles].filter((t) => parsed.scenarios
        .filter((sc) => sourceTitle(sc) === t)
        .every((sc) => unbound([...parsed.background, ...sc.steps]).length === 0));
      assert.deepStrictEqual(stale, [],
        `wip scenarios in '${base}' are fully bound — remove them from the wip entry: `
        + stale.map((t) => `'${t}'`).join(', '));
    });

    runFeature(parsed, registry, register, recorder);
  }
  // Every row source is now known. If nothing is left pending (every scenario
  // was @skip/@todo/unbound), this is also the write.
  recorder?.done();
}

module.exports = {
  parseFeature, lintFeature, lintStepDefinitionSource, StepRegistry, executeSteps,
  runFeature, runFeatureFile, runFeatures,
  bindRunner, DataTable, buildSnippet, GherkinSyntaxError,
};
