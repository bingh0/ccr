// @ts-check
'use strict';
// Step definitions for features/pane-blobs.feature.
//
// These drive the REAL path: a real file at a real configured path, through
// composeFrame's pane branch (config → src/pane-blob.js verifier → renderPane).
// Nothing is stubbed, because every scenario here is about what happens when
// the file on disk is not what ccr hoped for, and a stub would be ccr's hope.
//
// The hotkey scenarios are the exception: hotkeys are a HOST capability that
// lives in scripts/launch.sh and tmux performs the keystroke, so — exactly as
// features/sidecar-hosting.feature already does for the copy-mode hook — they
// are pinned structurally against the launcher rather than by spawning tmux.

const assert = require('node:assert');
const { refuteWithControl } = require('./_absence');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { composeFrame } = require('../../src/sidecar');
const { renderPane } = require('../../src/render/pane');
const { loadPaneBlob } = require('../../src/pane-blob');
// features/design/test-link-fixtures.feature. Two @security scenarios in this
// file need a fixture some platforms cannot build — a FIFO, and a symlink to a
// file. Neither has a faithful substitute, so both DECLINE OUT LOUD: a Gherkin
// scenario whose steps quietly no-op still reports as passing, which is how a
// ratified security guarantee came to assert nothing here on Windows.
const {
  SKIP_REASON, fileSymlinksAvailable, plantFileLink, announceUnbuildable,
} = require('../_links');

const ROOT = path.join(__dirname, '..', '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'pane-blob.golden.json'), 'utf8'));

// Witness modules for the structural refusals below: each names a place in
// ccr that legitimately does the thing the pane path must not, so a needle
// that stops matching real code fails its control instead of certifying the
// pane clean of something nobody looks for any more.
const srcOf = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Source with comments removed, for structural assertions.
 *
 * These files EXPLAIN their own restrictions in prose ("never a prompt file",
 * "never blob content"), so a naive grep for a forbidden word finds the
 * documentation promising not to do the thing and fails. Strip the commentary
 * and assert against what actually executes.
 * @param {string} src
 * @param {'sh'|'js'} lang
 */
const code = (src, lang) => src
  .split('\n')
  .filter((l) => !(lang === 'sh' ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/).test(l))
  .join('\n');
/** Any control byte other than the newlines that separate a frame's lines. */
const CTRL_IN_FRAME = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function definePaneBlobsSteps(reg) {
  const tmp = (/** @type {Record<string, any>} */ w) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-pane-'));
    w.defer(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };

  /** Write the blob file for the configured pane. */
  const writeBlob = (/** @type {Record<string, any>} */ w, /** @type {any} */ body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    fs.writeFileSync(w.blobPath, text);
    return text;
  };

  /**
   * Does the pane name the configured path?
   *
   * Not simply `includes(source)`: the source line is clamped to the pane width
   * — the contract's "clamp to the cell" — so a long path is legitimately drawn
   * truncated, and demanding the whole string asserts something the renderer
   * never promised. It passed only because /tmp is short; a macOS tmpdir
   * (/var/folders/<2>/<24>/T/…) runs past the 72 columns these scenarios render
   * at, which is why this was green on Linux and red on macOS.
   *
   * So: the full path, or a rendered line that is a non-trivial prefix of it.
   * Still fails when the path is absent, which is what the scenarios are for.
   */
  const namesSource = (/** @type {string} */ frame, /** @type {string} */ source) =>
    frame.includes(source)
    || frame.split('\n').some((l) => l.trim().length >= 16 && source.startsWith(l.trim()));

  /**
   * The view cycle, as a rule rather than as numbers scattered through the
   * assertions: index 0 is ccr's economy view, index 1 is the built-in git
   * pane, and the i-th CONFIGURED pane is index 2+i. Displayed positions are
   * 1-based over the whole cycle.
   *
   * These exist because the cycle gained a view (the git pane) and every
   * hardcoded `2/2` in this file became wrong at once. A binding that states
   * the rule survives the next view; one that states a number has to be found
   * and chased, and the ones that are merely *loose* enough to keep passing are
   * the dangerous half.
   */
  const paneView = (i = 0) => 2 + i;
  const cycleLen = (/** @type {Record<string, any>} */ w) => 2 + w.panes.length;
  const panePos = (/** @type {Record<string, any>} */ w, i = 0) => `${paneView(i) + 1}/${cycleLen(w)}`;
  const atPos = (/** @type {string} */ p) => new RegExp(p.replace('/', '\\/'));

  /**
   * Render the configured pane through the whole real wiring.
   * A scenario that needs a pane-HEIGHT budget (row overflow) sets `w.maxRows`;
   * composeFrame sizes itself to the real pane and has no such knob, so those
   * render one level down, through the same verifier and the same renderer.
   */
  const render = (/** @type {Record<string, any>} */ w, /** @type {{ cols?: number }} */ opts = {}) => {
    const cols = opts.cols || 72;
    if (w.maxRows) {
      const res = loadPaneBlob(w.blobPath, { now: w.now || Date.now() });
      w.frame = renderPane(res, { source: w.source, position: panePos(w), width: cols, maxRows: w.maxRows });
    } else {
      w.frame = composeFrame(w.stateDir, { now: w.now || Date.now(), view: paneView(), panes: w.panes, cols });
    }
    w.plain = plain(w.frame);
    return w.frame;
  };

  /** A valid v1 blob, cloned so a scenario can bend one field. */
  const validBlob = (over = {}) => JSON.parse(JSON.stringify({ ...GOLDEN, ...over }));

  // ── Background ────────────────────────────────────────────────────────────

  reg.define(/^a pane blob path listed in the sidecar configuration$/, (w) => {
    w.dir = tmp(w);
    w.stateDir = tmp(w);
    w.source = path.join(w.dir, 'sidecar.json');
    w.blobPath = w.source;
    w.panes = [{ path: w.blobPath, source: w.source }];
  });

  // ── Discovery ─────────────────────────────────────────────────────────────

  reg.define(/^no other blob paths are configured$/, (w) => {
    assert.strictEqual(w.panes.length, 1);
  });
  reg.define(/^the sidecar starts$/, (w) => { writeBlob(w, GOLDEN); render(w); });
  reg.define(/^exactly one external pane joins the view cycle$/, (w) => {
    // "Exactly one" is a claim about the cycle's LENGTH: the configured pane
    // occupies its own index, and the very next index wraps to the start rather
    // than inventing a second pane. Both halves matter — the wrap is what makes
    // it one rather than many.
    const atPane = plain(composeFrame(w.stateDir, { view: paneView(), panes: w.panes, cols: 72 }));
    const past = plain(composeFrame(w.stateDir, { view: cycleLen(w), panes: w.panes, cols: 72 }));
    assert.match(atPane, atPos(panePos(w)), `the pane is position ${panePos(w)}`);
    assert.ok(!atPos(panePos(w)).test(past), 'the index past the last pane wraps rather than inventing one');
    // "Wraps" precisely: the frame past the end IS the frame at the start. This
    // says it without depending on what view 0 happens to be showing — an empty
    // state dir legitimately renders the waiting line rather than the economy.
    assert.strictEqual(past, plain(composeFrame(w.stateDir, { view: 0, panes: w.panes, cols: 72 })));
  });
  reg.define(/^the sidecar reads no path it was not given$/, () => {
    // Structural: discovery is configuration, so nothing in the pane path may
    // enumerate a directory or guess a name. Assert against CODE, not prose —
    // these files' comments legitimately discuss what they refuse to do.
    for (const f of ['src/pane-config.js', 'src/pane-blob.js']) {
      const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'), 'js');
      refuteWithControl(/readdirSync|globSync|\bglob\(/, src, srcOf('src/transcripts.js'),
        `${f} must not enumerate paths`);
    }
  });

  reg.define(/^a valid v1 blob at the configured path$/, (w) => { writeBlob(w, GOLDEN); });
  reg.define(/^the pane renders$/, (w) => { render(w); });
  reg.define(/^the sidecar's only filesystem access for that pane is the configured path$/, (w) => {
    // Prove it by removing every other file: the pane must render identically
    // from the one path it was given.
    const before = render(w);
    for (const f of fs.readdirSync(w.dir)) {
      if (path.join(w.dir, f) !== w.blobPath) fs.rmSync(path.join(w.dir, f), { force: true });
    }
    assert.strictEqual(render(w), before, 'the pane depends on its configured path alone');
  });
  reg.define(/^the sidecar has spawned no process and opened no database for it$/, () => {
    // The structural invariant, asserted here for this feature and enforced
    // globally against the whole module graph by sidecar-capabilities.test.js.
    for (const f of ['src/pane-blob.js', 'src/pane-config.js', 'src/render/pane.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      refuteWithControl(/child_process|sqlite|require\('node:(net|http|https|dgram|tls)'\)/, src,
        srcOf('src/doctor.js'), `${f} must hold no process, network, or database capability`);
    }
  });

  // ── Rendering a healthy blob ──────────────────────────────────────────────

  reg.define(/^the golden fixture blob at the configured path$/, (w) => { writeBlob(w, GOLDEN); });
  reg.define(/^the pane shows the title "([^"]+)" and the tool "([^"]+)"$/, (w, title, tool) => {
    assert.match(w.plain, new RegExp(String(title)));
    assert.match(w.plain, new RegExp(String(tool)));
  });
  reg.define(/^all seven rows render in blob order$/, (w) => {
    const labels = GOLDEN.rows.map((/** @type {any} */ r) => r.label);
    assert.strictEqual(labels.length, 7, 'the fixture still carries seven rows');
    const positions = labels.map((/** @type {string} */ l) => w.plain.indexOf(l));
    assert.ok(positions.every((/** @type {number} */ p) => p >= 0), 'every row is present');
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepStrictEqual(positions, sorted, 'rows render in blob order');
  });
  reg.define(/^the row "([^"]+)" shows "([^"]+)" with the alert light$/, (w, label, value) => {
    const line = w.frame.split('\n').find((/** @type {string} */ l) => plain(l).includes(String(label)));
    assert.ok(line, `row ${label} present`);
    assert.match(plain(line), new RegExp(String(value)));
    assert.ok(line.includes(RED), 'alert renders red');
  });

  reg.define(/^a valid v1 blob whose basis reads "([^"]+)" at "([^"]+)"$/, (w, label, at) => {
    writeBlob(w, validBlob({ basis: { label, at } }));
    w.basisLabel = label; w.basisAt = at;
  });
  reg.define(/^the blob file was written (\d+) minutes ago$/, (w, n) => {
    const when = Date.now() - Number(n) * 60000;
    fs.utimesSync(w.blobPath, when / 1000, when / 1000);
  });
  reg.define(/^the pane chrome shows "([^"]+)" and "([^"]+)" unparsed$/, (w, label, at) => {
    assert.match(w.plain, new RegExp(String(label)));
    // Verbatim: ccr never reformats basis.at, so the exact string survives.
    assert.ok(w.plain.includes(at), `basis.at must render verbatim, got: ${w.plain}`);
  });
  reg.define(/^the pane chrome shows "blob written ([^"]+) ago"$/, (w, shown) => {
    assert.ok(w.plain.includes(`blob written ${shown} ago`), `expected write age ${shown} in: ${w.plain}`);
  });

  reg.define(/^a valid v1 blob whose file was written (\d+) (seconds|hours|days) ago$/, (w, n, unit) => {
    writeBlob(w, GOLDEN);
    const mult = unit === 'seconds' ? 1000 : unit === 'hours' ? 3600000 : 86400000;
    const when = Date.now() - Number(n) * mult;
    fs.utimesSync(w.blobPath, when / 1000, when / 1000);
  });

  reg.define(/^a valid v1 blob with a row carrying spark values 2, 5, 3, and 8$/, (w) => {
    writeBlob(w, validBlob({ rows: [{ label: 'fence', value: 'clean', status: 'ok', spark: [2, 5, 3, 8] }] }));
  });
  reg.define(/^the row shows a four-glyph sparkline whose tallest glyph is the 8$/, (w) => {
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const line = w.plain.split('\n').find((/** @type {string} */ l) => l.includes('fence'));
    const spark = [...line].filter((/** @type {string} */ c) => glyphs.includes(c));
    assert.strictEqual(spark.length, 4, `expected four spark glyphs, got ${spark.join('')}`);
    // 8 is the row's max, so it takes the tallest glyph, and it is the last value.
    assert.strictEqual(spark[3], '█');
    assert.ok(glyphs.indexOf(spark[3]) > glyphs.indexOf(spark[0]), '8 renders taller than 2');
  });

  reg.define(/^a valid v1 blob whose rows array is empty$/, (w) => { writeBlob(w, validBlob({ rows: [] })); });
  reg.define(/^the pane shows a named no-rows body$/, (w) => {
    assert.match(w.plain, /no rows/, 'an empty body is named, not blank');
  });
  reg.define(/^the title, basis, and age chrome render intact$/, (w) => {
    assert.match(w.plain, /trace/);
    assert.match(w.plain, /refresh/);
    assert.match(w.plain, /blob written .+ ago/);
  });

  // ── The status vocabulary ─────────────────────────────────────────────────

  reg.define(/^a valid v1 blob with a row "([^"]+)" at status "([^"]+)" and a row "([^"]+)" at status "([^"]+)"$/,
    (w, l1, s1, l2, s2) => {
      writeBlob(w, validBlob({ rows: [
        { label: l1, value: 'x', status: s1 },
        { label: l2, value: 'y', status: s2 },
      ] }));
      w.rowA = l1; w.rowB = l2;
    });
  const lineFor = (/** @type {Record<string, any>} */ w, /** @type {string} */ label) =>
    w.frame.split('\n').find((/** @type {string} */ l) => plain(l).includes(label));
  reg.define(/^the row "([^"]+)" shows the dark marker$/, (w, label) => {
    const line = lineFor(w, String(label));
    assert.ok(line, `row ${label} present`);
    assert.ok(plain(line).includes('◌'), 'dark uses its own hollow marker');
    assert.ok(!line.includes(GREEN), 'dark is never green');
  });
  reg.define(/^the row "([^"]+)" shows the dim off render$/, (w, label) => {
    const line = lineFor(w, String(label));
    assert.ok(line, `row ${label} present`);
    assert.ok(line.includes('\x1b[2m'), 'off renders dim');
    assert.ok(!line.includes(GREEN), 'off is never green');
  });
  reg.define(/^the two renders are visibly different from each other and from the green light$/, (w) => {
    const a = lineFor(w, w.rowA);
    const b = lineFor(w, w.rowB);
    const markerOf = (/** @type {string} */ l) => plain(l).trim().charAt(0);
    assert.notStrictEqual(markerOf(a), markerOf(b), 'dark and off must not share a glyph');
    assert.ok(!a.includes(GREEN) && !b.includes(GREEN), 'neither is the green light');
  });

  reg.define(/^a valid v1 blob with a row whose status reads "([^"]+)"$/, (w, status) => {
    writeBlob(w, validBlob({ rows: [{ label: 'mystery', value: '1', status }] }));
  });
  reg.define(/^that row renders with the dark marker$/, (w) => {
    const line = lineFor(w, 'mystery');
    assert.ok(line && plain(line).includes('◌'), 'an unknown status falls back to dark');
  });
  reg.define(/^the row is not dropped and shows no green light$/, (w) => {
    const line = lineFor(w, 'mystery');
    assert.ok(line, 'the row is still rendered');
    assert.ok(!line.includes(GREEN), 'never green');
  });

  // ── Untrusted strings ─────────────────────────────────────────────────────

  reg.define(/^a v1 blob whose title, labels, values, details, and message embed escape and control bytes$/, (w) => {
    const evil = '\x1b]0;PWNED\x07\x1b]52;c;cHduZWQ=\x07\x1b[31mX\x1b[6n';
    w.evil = evil;   // the control arm for the Thens: what went IN must not come out
    writeBlob(w, {
      v: 1, tool: 'gt' + evil, title: 'trace' + evil, status: 'ok',
      basis: { label: 'refresh' + evil, at: '2026-08-01' + evil }, message: null,
      rows: [{ label: 'lbl' + evil, value: 'val' + evil, status: 'ok', detail: 'det' + evil }],
    });
  });
  reg.define(/^every rendered field shows the text with control bytes stripped$/, (w) => {
    assert.ok(!CTRL_IN_FRAME.test(w.plain), 'control bytes survived into the pane');
    assert.match(w.plain, /trace/, 'the inert text still renders');
  });
  reg.define(/^the terminal receives no escape sequence originating from blob content$/, (w) => {
    // ccr's OWN colour runs are legitimate; nothing else may introduce an escape.
    refuteWithControl('\x1b', plain(w.frame), w.evil,
      'a blob-sourced escape reached the frame');
  });
  reg.define(/^the clipboard, window title, and pane chrome are untouched by the blob$/, (w) => {
    for (const seq of [']52;c;', ']0;']) {
      refuteWithControl('\x1b' + seq, w.frame, w.evil, `blob introduced ${seq}`);
    }
  });

  reg.define(/^a valid v1 blob with a detail of four hundred lines$/, (w) => {
    const detail = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    writeBlob(w, validBlob({ rows: [{ label: 'big', value: 'v', status: 'ok', detail }] }));
  });
  reg.define(/^the detail renders clamped to its single-line cell$/, (w) => {
    const lines = w.frame.split('\n');
    assert.ok(lines.length < 50, `a 400-line detail must not become 400 pane lines (got ${lines.length})`);
    for (const l of lines) assert.ok(plain(l).length <= 72, 'every line stays inside the pane width');
  });
  reg.define(/^the basis and age chrome remain visible$/, (w) => {
    assert.match(w.plain, /refresh/);
    assert.match(w.plain, /blob written .+ ago/);
  });
  reg.define(/^the pane does not fall back to an error state$/, (w) => {
    // step-lint: allow unearned-absence -- every alternative is asserted POSITIVELY elsewhere in this file: invalid (the invalid-state step), unreadable, cannot read, and oversized each have their own matching Then
    assert.ok(!/invalid|unreadable|oversized|cannot read/.test(w.plain), `fell back: ${w.plain}`);
  });

  // ── The verifier ──────────────────────────────────────────────────────────

  reg.define(/^a blob at the configured path that parses as JSON but carries no basis$/, (w) => {
    const b = validBlob(); delete b.basis; w.written = writeBlob(w, b);
  });
  reg.define(/^the pane shows an invalid state naming the configured path$/, (w) => {
    assert.match(w.plain, /invalid/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
  });
  reg.define(/^no byte of the file's content appears in the pane$/, (w) => {
    // Derive the needles from the bytes THIS scenario actually wrote. Hardcoding
    // the golden fixture's words made this vacuous wherever the file was
    // something else — the unreadable scenario writes "{ this is not json", none
    // of whose words were ever being checked.
    assert.ok(w.written, 'the scenario recorded what it wrote');
    const tokens = String(w.written).split(/[^A-Za-z0-9_-]+/).filter((t) => t.length >= 4);
    assert.ok(tokens.length, 'the file had some content worth checking');
    for (const t of new Set(tokens)) {
      assert.ok(!w.plain.includes(t), `file content leaked into the pane: ${t}`);
    }
  });
  reg.define(/^the invalid state is visibly distinct from the unreadable and waiting states$/, (w) => {
    const invalid = w.plain;
    writeBlob(w, 'not json at all');
    const unreadable = plain(render(w));
    fs.rmSync(w.blobPath, { force: true });
    const waiting = plain(render(w));
    assert.notStrictEqual(invalid, unreadable);
    assert.notStrictEqual(invalid, waiting);
    assert.notStrictEqual(unreadable, waiting);
  });

  reg.define(/^a blob with status "broken" whose message is absent$/, (w) => {
    writeBlob(w, validBlob({ status: 'broken', message: null }));
  });
  reg.define(/^the pane shows the invalid state$/, (w) => { assert.match(w.plain, /invalid/); });
  reg.define(/^no rows from that blob are rendered$/, (w) => {
    for (const r of GOLDEN.rows) assert.ok(!w.plain.includes(r.label), `row ${r.label} leaked`);
  });

  reg.define(/^a valid v1 blob that also carries a "__proto__" key at the top level and in a row$/, (w) => {
    // Raw text: JSON.stringify cannot express a __proto__ KEY, and the parser
    // producing one is the whole point.
    const rows = '[{"label":"a","value":"1","status":"ok","__proto__":{"rowPolluted":"yes"}}]';
    w.protoText = `{"v":1,"tool":"gt","title":"t","status":"ok","basis":{"label":"r","at":"x"},`
      + `"message":null,"rows":${rows},"__proto__":{"polluted":"yes"}}`;
    w.written = writeBlob(w, w.protoText);
    w.clean = { v: 1, tool: 'gt', title: 't', status: 'ok', basis: { label: 'r', at: 'x' }, message: null,
      rows: [{ label: 'a', value: '1', status: 'ok' }] };
  });
  reg.define(/^the pane renders exactly as it does for the same blob without those keys$/, (w) => {
    const withProto = w.plain;
    writeBlob(w, w.clean);
    assert.strictEqual(plain(render(w)), withProto, 'a prototype key changed the render');
    // Render equality alone is unfalsifiable here — the renderer reads only
    // named fields, so it holds even if the verifier spread the whole input.
    // Assert the VALIDATED OBJECT's own keys instead: that is what
    // "whitelist-construct, never merge" actually means, and spreading the
    // parsed input makes this fail immediately.
    writeBlob(w, w.protoText);
    const res = loadPaneBlob(w.blobPath, { now: Date.now() });
    assert.strictEqual(res.state, 'ok');
    assert.deepStrictEqual(Object.keys(res.blob).sort(),
      ['basis', 'message', 'rows', 'status', 'title', 'tool', 'v'],
      'the validated blob carries exactly the v1 fields and nothing merged in');
    assert.deepStrictEqual(Object.keys(res.blob.rows[0]).sort(),
      ['detail', 'label', 'spark', 'status', 'value'],
      'a validated row carries exactly the v1 row fields');
    assert.ok(!Object.prototype.hasOwnProperty.call(res.blob, '__proto__'),
      'no __proto__ own-property survived into the result');
  });
  reg.define(/^no property of any shared prototype has been altered$/, () => {
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined, 'Object.prototype polluted');
    assert.strictEqual(/** @type {any} */ ({}).rowPolluted, undefined, 'Object.prototype polluted via a row');
  });

  reg.define(/^the file at the configured path is malformed in a way that fails validation$/, (w) => {
    const b = validBlob(); delete b.tool; writeBlob(w, b);
  });
  reg.define(/^the sidecar ticks three times$/, (w) => {
    w.frames = [];
    const started = Date.now();
    for (let i = 0; i < 3; i++) w.frames.push(composeFrame(w.stateDir, { view: paneView(), panes: w.panes, cols: 72 }));
    w.elapsed = Date.now() - started;
  });
  reg.define(/^all three ticks complete on schedule$/, (w) => {
    assert.strictEqual(w.frames.length, 3, 'every tick produced a frame');
    assert.ok(w.elapsed < 2000, `three ticks took ${w.elapsed}ms — the loop is being blocked`);
  });
  reg.define(/^the economy view still renders in the cycle$/, (w) => {
    fs.writeFileSync(path.join(w.stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 4.8' }, rate_limits: {}, cost: { total_cost_usd: 1 },
    }));
    assert.match(plain(composeFrame(w.stateDir, { view: 0, panes: w.panes, cols: 72 })), /economy/,
      'a malformed blob must cost its pane, never the sidecar');
  });

  reg.define(/^a valid v1 blob with a row whose spark carries a value that parses to infinity$/, (w) => {
    // 1e400 has no JSON literal but parses to Infinity — the reason the contract
    // requires FINITE numbers rather than merely numbers.
    writeBlob(w, '{"v":1,"tool":"gt","title":"t","status":"ok","basis":{"label":"r","at":"x"},'
      + '"message":null,"rows":[{"label":"row","value":"7","status":"ok","spark":[1,1e400,3]}]}');
  });
  reg.define(/^that row renders without a sparkline$/, (w) => {
    const line = lineFor(w, 'row');
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    assert.ok(line, 'the row is present');
    assert.ok(![...plain(line)].some((c) => glyphs.includes(c)), 'the sparkline is dropped');
  });
  reg.define(/^the row's label, value, and status render normally$/, (w) => {
    const line = lineFor(w, 'row');
    assert.match(plain(line), /row/);
    assert.match(plain(line), /7/);
    assert.ok(line.includes(GREEN), 'an ok row keeps its green light');
  });

  // ── Forward compatibility ─────────────────────────────────────────────────

  reg.define(/^the golden fixture blob carrying extra unrecognized fields at the top level and in a row$/, (w) => {
    const b = validBlob();
    b.futureField = { anything: true };
    b.rows[0].futureRowField = 'ignored';
    writeBlob(w, b);
  });
  reg.define(/^the pane renders exactly as it does for the golden fixture alone$/, (w) => {
    const withExtras = w.plain;
    writeBlob(w, GOLDEN);
    assert.strictEqual(plain(render(w)), withExtras, 'unknown fields must change nothing');
  });

  // ── Honesty states ────────────────────────────────────────────────────────

  reg.define(/^a v1 blob with status "broken" and the message "([^"]+)"$/, (w, message) => {
    writeBlob(w, validBlob({ status: 'broken', message }));
    w.message = message;
  });
  reg.define(/^the pane shows a failure state carrying "([^"]+)" with the basis chrome$/, (w, message) => {
    assert.match(w.plain, /broken/);
    assert.ok(w.plain.includes(message), 'the producer\'s own message is shown');
    assert.match(w.plain, /refresh/, 'the basis chrome survives the failure');
  });
  reg.define(/^any rows in the broken blob are ignored$/, (w) => {
    for (const r of GOLDEN.rows) assert.ok(!w.plain.includes(r.label), `row ${r.label} rendered on a broken blob`);
  });
  reg.define(/^no rows from any earlier healthy blob are shown$/, (w) => {
    // Render a healthy blob first, then the broken one: nothing may persist.
    writeBlob(w, GOLDEN); render(w);
    writeBlob(w, validBlob({ status: 'broken', message: w.message || 'failed' }));
    const after = plain(render(w));
    for (const r of GOLDEN.rows) assert.ok(!after.includes(r.label), 'a stale healthy row survived');
  });

  reg.define(/^no file exists at the configured path$/, (w) => { fs.rmSync(w.blobPath, { force: true }); });
  reg.define(/^the pane shows a waiting state naming the configured path$/, (w) => {
    assert.match(w.plain, /waiting/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
  });
  reg.define(/^the pane is not skipped from the view cycle$/, (w) => {
    assert.match(w.plain, atPos(panePos(w)), 'a configured pane keeps its position even with no blob');
  });

  reg.define(/^the file at the configured path is not parseable JSON this tick$/, (w) => {
    w.written = writeBlob(w, '{ "producer": "gherkin-trace", "leak": "sentinel-token" ');
  });
  reg.define(/^the pane shows an unreadable state naming the path$/, (w) => {
    assert.match(w.plain, /unreadable/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
  });

  reg.define(/^the configured path exists but cannot be read as a regular file$/, (w) => {
    fs.rmSync(w.blobPath, { force: true });
    fs.mkdirSync(w.blobPath);                  // a directory is not a regular file
  });
  reg.define(/^the pane shows a cannot-read state naming the path and the reason class$/, (w) => {
    assert.match(w.plain, /cannot read/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
    assert.match(w.plain, /\((directory|permission|symlink|not a regular file|unavailable)\)/,
      `a reason class is named: ${w.plain}`);
  });
  reg.define(/^the state is visibly distinct from the waiting state$/, (w) => {
    const cannotRead = w.plain;
    try { fs.rmdirSync(w.blobPath); } catch { fs.rmSync(w.blobPath, { force: true }); }
    assert.notStrictEqual(plain(render(w)), cannotRead, 'a chmod mistake must not look like patience');
  });

  reg.define(/^the configured path is a pipe that never yields bytes$/, (w) => {
    fs.rmSync(w.blobPath, { force: true });
    // "mkfifo did not throw" is NOT evidence of a pipe: Windows runners ship
    // MSYS mkfifo with Git, which exits 0 without creating a FIFO on NTFS. The
    // scenario then ran against a path with nothing at it and asserted
    // cannot-read against a waiting state. Confirm the pipe actually exists.
    try {
      execFileSync('mkfifo', [w.blobPath]);
      if (!fs.lstatSync(w.blobPath).isFIFO()) w.skipFifo = true;
    } catch { w.skipFifo = true; }
    // Declining used to be SILENT, so this @security scenario reported green
    // on Windows while asserting nothing at all.
    if (w.skipFifo) {
      announceUnbuildable(
        'pane-blobs @security: a pipe that never yields bytes',
        'this platform has no working mkfifo (MSYS mkfifo exits 0 without creating a FIFO on NTFS)',
      );
    }
  });
  reg.define(/^the pane shows the cannot-read state$/, (w) => {
    if (w.skipFifo) return;
    const frame = plain(w.frames ? w.frames[0] : render(w));
    assert.match(frame, /cannot read/);
  });

  reg.define(/^the configured path is a symlink pointing at another file$/, (w) => {
    // A junction cannot point at a file and a hardlink INVERTS what this
    // scenario asserts — writing through one does reach the target — so there
    // is nothing honest to substitute. Say so where the output is read.
    if (!fileSymlinksAvailable()) {
      announceUnbuildable('pane-blobs @security: a symlink pointing at another file', SKIP_REASON);
      w.skipSymlink = true;
      return;
    }
    const target = path.join(w.dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(GOLDEN));
    fs.rmSync(w.blobPath, { force: true });
    plantFileLink(target, w.blobPath);
    w.symlinkTarget = target;
  });
  reg.define(/^the pane shows the cannot-read state naming the path$/, (w) => {
    if (w.skipSymlink) return;
    assert.match(w.plain, /cannot read/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
  });
  reg.define(/^the sidecar never opens the symlink's target$/, (w) => {
    if (w.skipSymlink) return;
    // The target is a perfectly valid blob; if it were followed, its content
    // would render. Nothing from it may appear.
    refuteWithControl('gherkin-trace', w.plain, JSON.stringify(GOLDEN), 'the symlink was followed');
  });

  reg.define(/^a blob file larger than the size cap$/, (w) => {
    writeBlob(w, JSON.stringify({ ...GOLDEN, pad: 'x'.repeat(300 * 1024) }));
  });
  reg.define(/^the pane shows an oversized state naming the path$/, (w) => {
    assert.match(w.plain, /oversized/);
    assert.ok(namesSource(w.plain, w.source), 'the configured path is named');
  });
  reg.define(/^the file's content is not rendered$/, (w) => {
    refuteWithControl('gherkin-trace', w.plain, JSON.stringify(GOLDEN), 'oversized content leaked');
  });

  reg.define(/^a blob whose version field reads (\d+)$/, (w, v) => {
    writeBlob(w, validBlob({ v: Number(v) }));
    w.version = v;
  });
  reg.define(/^the pane shows an unsupported-version state naming version (\d+)$/, (w, v) => {
    assert.match(w.plain, /unsupported blob version/);
    assert.ok(w.plain.includes(String(v)), 'the version is named');
  });

  reg.define(/^the pane showed the unreadable state last tick$/, (w) => {
    writeBlob(w, 'not json');
    assert.match(plain(render(w)), /unreadable/);
  });
  reg.define(/^the file at the configured path is now a valid v1 blob$/, (w) => { writeBlob(w, GOLDEN); });
  reg.define(/^the next tick renders$/, (w) => { render(w); });
  reg.define(/^the pane shows the healthy view$/, (w) => {
    assert.match(w.plain, /trace/);
    assert.match(w.plain, /attention/);
  });
  reg.define(/^no trace of the error state remains$/, (w) => {
    // step-lint: allow unearned-absence -- same four-word vocabulary, each asserted positively by its own state step in this file
    assert.ok(!/unreadable|invalid|cannot read|oversized/.test(w.plain), 'error states are never sticky');
  });

  reg.define(/^the pane showed the waiting state last tick$/, (w) => {
    fs.rmSync(w.blobPath, { force: true });
    assert.match(plain(render(w)), /waiting/);
  });
  reg.define(/^a valid v1 blob has now appeared at the configured path$/, (w) => { writeBlob(w, GOLDEN); });

  // ── Hotkeys: structural, against the launcher that owns them ──────────────

  const launchSh = () => fs.readFileSync(path.join(ROOT, 'scripts', 'launch.sh'), 'utf8');

  reg.define(/^the tmux host binds ccr's clear hotkey$/, (w) => { w.launchSh = launchSh(); });
  reg.define(/^the configuration names which key it is but supplies no text$/, (w) => {
    // The text is a CONSTANT in ccr's source. Nothing the launcher EXECUTES may
    // read a prompt file, a config string, or any other external text into the
    // keystroke — so assert against the code, not the comments explaining it.
    const sh = code(w.launchSh, 'sh');
    refuteWithControl(/prompt[-_]?file|PROMPT_FILE/i, sh, 'PROMPT_FILE=$HOME/.ccr/prompt-file',
      'no prompt-file path may be read');
    refuteWithControl(/send-keys[^\n]*\$\((?!\s*tmux)/, sh, 'tmux send-keys -t %s "$(cat "$F")" Enter',
      'no command substitution supplies the typed text');
  });
  reg.define(/^the key is pressed and confirmed$/, (w) => {
    // The binding is emitted by printf, so the inner quotes are backslash-escaped
    // in the source. Match either form rather than assuming the escaping.
    const m = /bind-key -n (\S+) confirm-before -p '([^']*)' \\?"(.*?)\\?"/.exec(w.launchSh);
    assert.ok(m, `the confirm-gated binding is emitted: ${w.launchSh.slice(-400)}`);
    w.binding = { key: m[1], prompt: m[2], action: m[3] };
  });
  reg.define(/^the text typed into the Claude pane is the constant from ccr's source$/, (w) => {
    assert.match(w.binding.action, /send-keys -t %s '\/clear' Enter/,
      'the literal /clear comes from the script, never from configuration');
  });
  reg.define(/^no word of it is interpreted as a key name$/, (w) => {
    // Quoted as one literal argument, with exactly one key name after it.
    assert.match(w.binding.action, /'\/clear' Enter$/, 'the text is one quoted literal followed by one submit');
  });
  reg.define(/^exactly one submit follows$/, (w) => {
    assert.strictEqual((w.binding.action.match(/Enter/g) || []).length, 1);
  });

  reg.define(/^the Claude pane's id was captured at launch$/, (w) => {
    w.launchSh = launchSh();
    assert.match(w.launchSh, /CLAUDE_PANE="\$\(tmux -L "\$SOCKET" new-session -d -P -F '#\{pane_id\}'/,
      'the pane id is captured when the session is created');
  });
  reg.define(/^the panes have since been rearranged$/, () => {
    // Nothing to do: the point is that a captured %N does not care.
  });
  reg.define(/^a host hotkey is pressed and confirmed$/, (w) => {
    w.launchSh = w.launchSh || launchSh();
  });
  reg.define(/^the text is typed into the originally captured Claude pane$/, (w) => {
    // The %s is a PLACEHOLDER — asserting on it says nothing about the target.
    // What matters is the argument that fills it, which must be the pane id
    // captured for CLAUDE's pane. (Swapping it to $SIDEBAR_PANE aims /clear at
    // the sidecar's own pane and this assertion is the only thing that notices.)
    const stmt = /printf "bind-key -n F2 confirm-before[\s\S]*?>> "\$RUN_CONF"/.exec(w.launchSh);
    assert.ok(stmt, 'the F2 binding statement is emitted');
    assert.match(stmt[0], /send-keys -t %s '\/clear' Enter/, 'the target is a captured id, not a literal');
    assert.match(stmt[0], /"\$CLAUDE_PANE"/, 'the id filled in is the CLAUDE pane, not any other pane');
    // step-lint: allow unearned-absence -- the line above asserts /"\$CLAUDE_PANE"/ positively on this same statement, proving a "$..._PANE" reference is found here when present
    assert.ok(!/"\$SIDEBAR_PANE"/.test(stmt[0]), 'never the sidecar\'s own pane');
    // step-lint: allow unearned-absence -- the send-keys assertion two lines up matches /send-keys -t %s/ positively in this same launcher, so the prefix is proven; only the relative-index tail is denied
    assert.ok(!/send-keys -t \.\d/.test(w.launchSh), 'never a relative pane index, which retargets after a split');
  });
  reg.define(/^no other pane receives any keystroke$/, (w) => {
    const sends = w.launchSh.match(/send-keys[^\n]*/g) || [];
    for (const s of sends) {
      assert.ok(/-t (%s|\$SIDEBAR_PANE)/.test(s), `every send-keys names an explicit pane: ${s}`);
    }
  });

  reg.define(/^the captured Claude pane no longer exists$/, (w) => { w.launchSh = launchSh(); });
  reg.define(/^a host hotkey is pressed$/, (w) => { w.launchSh = w.launchSh || launchSh(); });
  reg.define(/^nothing is typed anywhere$/, (w) => {
    // tmux's send-keys against a dead pane id is a no-op that fails the command;
    // what matters is that ccr never substitutes a fallback target.
    // step-lint: allow unearned-absence -- the same launcher is asserted to carry /send-keys -t %s/ positively by the typed-into-Claude step, proving this needle's prefix finds real bindings
    assert.ok(!/send-keys -t \.\d|send-keys -t \{/.test(w.launchSh), 'no fallback target exists to retarget onto');
  });

  reg.define(/^the key is pressed once$/, (w) => { w.launchSh = w.launchSh || launchSh(); });
  reg.define(/^nothing is typed and a confirmation prompt appears$/, (w) => {
    assert.match(w.launchSh, /confirm-before -p '[^']*\?/, 'a confirmation prompt gates the key');
  });
  reg.define(/^the confirmation is declined$/, () => { /* tmux drops the command */ });
  reg.define(/^nothing is typed into the Claude pane$/, (w) => {
    // The send-keys is the ARGUMENT to confirm-before, so declining never runs it.
    assert.match(w.launchSh, /confirm-before -p '[^']*' \\?"send-keys/, 'the keystroke is confirm-before\'s argument');
  });

  reg.define(/^a host where no Claude pane id was captured at launch$/, (w) => { w.launchSh = launchSh(); });
  reg.define(/^the session comes up$/, () => { /* structural */ });
  reg.define(/^no hotkey is bound$/, (w) => {
    assert.match(w.launchSh, /if \[ -n "\$CLAUDE_PANE" \]; then\n\s*printf "bind-key/,
      'the binding is emitted only when a pane id was captured');
  });
  reg.define(/^no approximate target is substituted for the captured pane id$/, (w) => {
    const conf = fs.readFileSync(path.join(ROOT, 'sidecar', 'ccr.tmux.conf'), 'utf8');
    // step-lint: allow unearned-absence -- the launcher's own F2 statement is matched positively by the typed-into-Claude step via /bind-key -n F2 confirm-before/, so this needle is proven to find a real binding when one exists
    assert.ok(!/bind-key -n F2/.test(conf), 'the shipped conf binds no approximate F2');
    // Witness: the whole launcher, whose one `else` lives in an unrelated
    // branch — so /else/ is proven able to find a shell alternative here.
    refuteWithControl(/else/, /if \[ -n "\$CLAUDE_PANE" \][\s\S]*?fi/.exec(w.launchSh)?.[0] || '',
      w.launchSh, 'no fallback branch binds an approximate target');
  });

  reg.define(/^a valid v1 blob that also carries an action-like field naming a key and a command$/, (w) => {
    const b = validBlob();
    b.actions = [{ key: 'F5', command: 'rm -rf /', label: 'press F5 to refresh' }];
    w.actionLabel = b.actions[0].label;   // the witness: this is what must not surface
    b.rows[0].action = { key: 'F6', command: 'curl evil.example' };
    writeBlob(w, b);
  });
  reg.define(/^the pane renders and every bound key is pressed$/, (w) => { render(w); });
  reg.define(/^the blob's action-like field is ignored and displayed nowhere$/, (w) => {
    for (const needle of ['F5', 'F6', 'rm -rf', 'curl', 'evil.example']) {
      assert.ok(!w.plain.includes(needle), `blob action content surfaced: ${needle}`);
    }
  });
  reg.define(/^the pane shows no label claiming a key exists$/, (w) => {
    refuteWithControl(/press .* to/i, w.plain, w.actionLabel, 'a blob may not advertise a key');
  });
  reg.define(/^nothing from the blob is ever typed into the Claude pane$/, () => {
    // Structural and absolute: there is no path from blob content to a binding.
    // The launcher's comments discuss blobs at length; its CODE never reads one.
    const sh = code(launchSh(), 'sh');
    // Witness: the UNSTRIPPED launcher, whose comments discuss blobs at length.
    // The code, with comments removed, may not — and if the word ever leaves
    // those comments the control says so rather than this passing for free.
    refuteWithControl(/blob|sidecar\.json/i, sh, launchSh(), 'the launcher never reads blob content');
    const paneSrc = code(fs.readFileSync(path.join(ROOT, 'src', 'render', 'pane.js'), 'utf8'), 'js');
    refuteWithControl(/send-keys|child_process/, paneSrc, launchSh(),
      'the pane renderer holds no keystroke capability');
  });

  // ── The pane surface ──────────────────────────────────────────────────────

  reg.define(/^a second pane blob path listed after the first in the sidecar configuration$/, (w) => {
    writeBlob(w, GOLDEN);
    const second = path.join(w.dir, 'second.json');
    fs.writeFileSync(second, JSON.stringify(validBlob({ title: 'second', tool: 'other-tool' })));
    w.panes = [...w.panes, { path: second, source: second }];
  });
  reg.define(/^the sidecar offers its own economy view$/, (w) => {
    fs.writeFileSync(path.join(w.stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 4.8' }, rate_limits: {}, cost: { total_cost_usd: 1 },
    }));
  });
  reg.define(/^the user cycles the sidecar style$/, (w) => {
    // Economy, then each configured pane at its own index. The built-in git
    // pane sits between them and is not what this scenario is about, so it is
    // stepped over rather than asserted here.
    w.views = [0, paneView(0), paneView(1)]
      .map((v) => plain(composeFrame(w.stateDir, { view: v, panes: w.panes, cols: 72 })));
  });
  reg.define(/^each external pane appears as a whole-pane view in configuration order$/, (w) => {
    assert.match(w.views[0], /economy/, 'the first view is ccr\'s own');
    assert.match(w.views[1], /trace/, 'the first configured pane comes first');
    assert.match(w.views[2], /second/, 'the second configured pane comes second');
    // step-lint: allow unearned-absence -- the line above asserts /second/ positively on views[2], proving the string reaches a rendered view
    assert.ok(!w.views[1].includes('second'), 'panes are whole views, never combined');
  });
  reg.define(/^the chrome shows the pane's position in the cycle$/, (w) => {
    const n = cycleLen(w);
    assert.match(w.views[0], atPos(`1/${n}`), 'the economy view names its own position');
    assert.match(w.views[1], atPos(panePos(w, 0)));
    assert.match(w.views[2], atPos(panePos(w, 1)));
  });
  reg.define(/^no view is truncated to stack beside another$/, (w) => {
    // step-lint: allow unearned-absence -- the whole-pane-view step asserts /economy/ positively on views[0], proving the string renders when the economy panel is the view
    assert.ok(!w.views[1].includes('economy'), 'a pane view never shares the pane with the economy panel');
  });

  reg.define(/^a valid v1 blob with more rows than the pane has lines, one hidden row being dark$/, (w) => {
    const rows = [
      { label: 'r1', value: '1', status: 'ok' },
      { label: 'r2', value: '2', status: 'ok' },
      { label: 'r3', value: '3', status: 'warn' },
      { label: 'hidden-dark', value: '4', status: 'dark' },
      { label: 'r5', value: '5', status: 'off' },
    ];
    writeBlob(w, validBlob({ rows }));
    w.rowsJson = JSON.stringify(rows);   // the witness for the hidden-row refusal
    w.maxRows = 3;          // the pane has room for three lines of body
  });
  reg.define(/^the visible rows are followed by a final line stating how many more rows exist$/, (w) => {
    assert.match(w.plain, /\+3 more/, `expected a collapsed count, got:\n${w.plain}`);
    assert.match(w.plain, /r1/);
    refuteWithControl('hidden-dark', w.plain, w.rowsJson, 'the hidden row is not shown in full');
  });
  reg.define(/^that line carries the dark marker, the worst status among the hidden rows$/, (w) => {
    const line = w.frame.split('\n').find((/** @type {string} */ l) => plain(l).includes('more'));
    assert.ok(line, 'the overflow line exists');
    assert.ok(plain(line).includes('◌'), 'a hidden dark row must still read as darkness');
    assert.ok(!line.includes(GREEN), 'the overflow line is never green');
  });
};
