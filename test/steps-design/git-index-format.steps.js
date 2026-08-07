// @ts-check
'use strict';
// Design-tier steps for features/design/git-index-format.feature: readIndex
// against explicit bytes. The design tier drives the parser DIRECTLY — its
// charter is implementation contracts, one level below the product surface the
// visionary's features hold through composeFrame.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readIndex } = require('../../src/git-index');
const { writeIndexV } = require('./_design-fixture');

const OID = '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d';
const OID256 = OID + '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d'.slice(0, 24);

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitIndexFormatSteps(reg) {
  const gitDir = (/** @type {Record<string, any>} */ w) => {
    if (!w.gitDir) {
      w.gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-idx-'));
      w.defer(() => fs.rmSync(w.gitDir, { recursive: true, force: true }));
    }
    return w.gitDir;
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^an index written at version (\d) with the paths "([^"]+)" and "([^"]+)"$/, (w, v, a, b) => {
    writeIndexV(gitDir(w), /** @type {2|3|4} */ (Number(v)),
      [{ path: a, oid: OID }, { path: b, oid: OID }]);
  });

  reg.define(/^an index written at version 3 whose entry "([^"]+)" carries extended flags$/, (w, p) => {
    writeIndexV(gitDir(w), 3, [{ path: p, oid: OID, extended: true }]);
  });

  reg.define(/^an index holding "([^"]+)" at stages 1, 2 and 3$/, (w, p) => {
    writeIndexV(gitDir(w), 2, [1, 2, 3].map((stage) => ({ path: p, oid: OID, stage })));
  });

  reg.define(/^a sha-256 repository whose index holds "([^"]+)"$/, (w, p) => {
    fs.writeFileSync(path.join(gitDir(w), 'config'),
      '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n');
    writeIndexV(gitDir(w), 2, [{ path: p, oid: OID256 }]);
  });

  reg.define(/^an index written at version 2 and then truncated mid-entry$/, (w) => {
    writeIndexV(gitDir(w), 2, [{ path: 'a.txt', oid: OID }], { truncateBy: 30 });
  });

  reg.define(/^an index claiming 40 entries but holding 1$/, (w) => {
    writeIndexV(gitDir(w), 2, [{ path: 'a.txt', oid: OID }], { lieCount: 40 });
  });

  reg.define(/^a git directory with no index file$/, (w) => { gitDir(w); });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the index is read$/, (w) => { w.result = readIndex(gitDir(w)); });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^(\d+) entr(?:y|ies) comes? back$/, (w, n) => {
    assert.ok(w.result !== null, 'the read refused a well-formed index');
    assert.strictEqual(w.result.entries.length, Number(n),
      `expected ${n} entries, got ${JSON.stringify(w.result.entries.map((/** @type {any} */ e) => e.path))}`);
  });

  reg.define(/^entry (\d+) is "([^"]+)" at stage (\d)$/, (w, i, p, stage) => {
    const e = w.result.entries[Number(i)];
    assert.ok(e, `no entry ${i}`);
    assert.strictEqual(e.path, p);
    assert.strictEqual(e.stage, Number(stage));
  });

  reg.define(/^every entry is "([^"]+)" with a distinct stage$/, (w, p) => {
    const stages = w.result.entries.map((/** @type {any} */ e) => {
      assert.strictEqual(e.path, p);
      return e.stage;
    });
    assert.strictEqual(new Set(stages).size, stages.length,
      `stages repeat: ${stages.join(', ')}`);
  });

  reg.define(/^entry (\d+)'s id is (\d+) hex characters$/, (w, i, len) => {
    const e = w.result.entries[Number(i)];
    assert.ok(e, `no entry ${i}`);
    assert.match(e.oid, new RegExp(`^[0-9a-f]{${len}}$`));
  });

  reg.define(/^the read refuses$/, (w) => {
    assert.strictEqual(w.result, null,
      `expected a refusal, got ${w.result && w.result.entries.length} entries`);
  });
};
