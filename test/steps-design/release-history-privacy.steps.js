// @ts-check
'use strict';
// Design-tier steps for features/design/release-history-privacy.feature:
// scanHistory over hand-built commit chains.
//
// The repositories here are built object by object rather than by shelling out
// to git, for the reason the whole fixture layer gives — the suite must pass on
// a machine with no git installed. test/history-privacy.test.js is the far
// side, running the same scanner over THIS repository's real history and
// checking it against what `git grep` says.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanHistory } = require('../../scripts/history-privacy');
const { writeLoose, writeTrees, writeCommit } = require('../steps/_git-fixture');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineReleaseHistoryPrivacySteps(reg) {
  const gitDir = (/** @type {Record<string, any>} */ w) => {
    if (!w.gitDir) {
      w.gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-hist-'));
      w.defer(() => fs.rmSync(w.gitDir, { recursive: true, force: true }));
      fs.mkdirSync(path.join(w.gitDir, 'objects'), { recursive: true });
      w.privatePatterns = [];
    }
    return w.gitDir;
  };

  /**
   * One commit over a one-file tree, chained onto whatever came before.
   * @param {Record<string, any>} w
   * @param {string} name
   * @param {Buffer} content
   * @param {string} message
   */
  const commitWith = (w, name, content, message) => {
    const dir = gitDir(w);
    const oid = writeLoose(dir, 'blob', content);
    const tree = writeTrees(dir, new Map([[name, { oid, mode: 0o100644 }]]));
    const parents = w.tip ? [w.tip] : [];
    return writeCommit(dir, tree, { parents, message });
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^the private pattern "([^"]+)"$/, (w, src) => {
    gitDir(w);
    w.privatePatterns.push(new RegExp(String(src), 'i'));
  });

  reg.define(/^a published commit whose tree holds "([^"]+)" saying "([^"]+)"$/, (w, name, text) => {
    w.published = commitWith(w, String(name), Buffer.from(String(text)), 'published');
    w.tip = w.published;
  });

  reg.define(/^an unpublished commit whose tree holds "([^"]+)" saying "([^"]+)"$/, (w, name, text) => {
    w.tip = commitWith(w, String(name), Buffer.from(String(text)), 'unpublished');
  });

  reg.define(/^an unpublished commit whose tree holds a binary "([^"]+)" containing "([^"]+)"$/, (w, name, text) => {
    // A NUL inside the sniff window is what makes it binary; the string is
    // present in full, so a scanner that ignored the NUL would report it.
    w.tip = commitWith(w, String(name), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      Buffer.from(String(text)),
    ]), 'unpublished binary');
  });

  reg.define(/^a chain of (\d+) unpublished commits each carrying "([^"]+)" saying "([^"]+)"$/,
    (w, count, name, text) => {
      // Each commit gets its own message, so the commits differ while the BLOB
      // stays byte-identical — which is the case the scanner must attribute to
      // all of them rather than to whichever it reached first.
      for (let i = 0; i < Number(count); i += 1) {
        w.tip = commitWith(w, String(name), Buffer.from(String(text)), `unpublished ${i + 1}`);
      }
    });

  reg.define(/^the unpublished commit object is removed$/, (w) => {
    const oid = /** @type {string} */ (w.tip);
    fs.rmSync(path.join(gitDir(w), 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the unpublished history is scanned$/, (w) => {
    w.result = scanHistory(gitDir(w), {
      tip: w.tip,
      published: w.published,
      privatePatterns: w.privatePatterns,
    });
  });

  reg.define(/^the tip and the published commit are the same$/, (w) => {
    w.result = scanHistory(gitDir(w), {
      tip: w.published,
      published: w.published,
      privatePatterns: w.privatePatterns,
    });
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the scan is clean$/, (w) => {
    assert.deepStrictEqual(
      { state: w.result.state, hits: w.result.hits },
      { state: 'clean', hits: [] });
  });

  reg.define(/^the scan is unavailable$/, (w) => {
    assert.strictEqual(w.result.state, 'unavailable');
  });

  reg.define(/^the scan refuses, naming "([^"]+)"$/, (w, literal) => {
    assert.strictEqual(w.result.state, 'hits');
    const literals = w.result.hits.map((/** @type {any} */ h) => h.literal);
    assert.ok(literals.includes(literal),
      `expected a finding naming ${literal}, got ${JSON.stringify(literals)}`);
  });

  reg.define(/^the scan refuses, naming (\d+) commits$/, (w, count) => {
    assert.strictEqual(w.result.state, 'hits');
    const commits = new Set(w.result.hits.map((/** @type {any} */ h) => h.commit));
    assert.strictEqual(commits.size, Number(count));
  });

  reg.define(/^no commits were scanned$/, (w) => {
    assert.strictEqual(w.result.commitsScanned, 0);
  });
};
