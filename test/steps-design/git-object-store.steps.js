// @ts-check
'use strict';
// Design-tier steps for features/design/git-object-store.feature: readObject
// and readHeadTree against hand-assembled loose objects and packs.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { readObject, readHeadTree } = require('../../src/git-objects');
const { writeLoose, writeTrees, writeCommit, frame } = require('../steps/_git-fixture');
const { writePack, simpleDelta } = require('./_design-fixture');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineGitObjectStoreSteps(reg) {
  const gitDir = (/** @type {Record<string, any>} */ w) => {
    if (!w.gitDir) {
      w.gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-obj-'));
      w.defer(() => fs.rmSync(w.gitDir, { recursive: true, force: true }));
      fs.mkdirSync(path.join(w.gitDir, 'objects'), { recursive: true });
    }
    return w.gitDir;
  };

  /** Both delta scenarios differ only in how the delta names its base. */
  const packWithDelta = (/** @type {Record<string, any>} */ w, /** @type {string} */ baseText, /** @type {string} */ suffix, /** @type {6|7} */ kind) => {
    const base = Buffer.from(baseText);
    const target = Buffer.concat([base, Buffer.from(suffix)]);
    const baseOid = frame('blob', base).oid;
    w.oid = frame('blob', target).oid;
    writePack(gitDir(w), [
      { type: 3, data: base, oid: baseOid },
      kind === 6
        ? { type: 6, data: simpleDelta(base, target), oid: w.oid, baseIndex: 0 }
        : { type: 7, data: simpleDelta(base, target), oid: w.oid, baseOid },
    ]);
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^a loose blob "([^"]+)"$/, (w, text) => {
    w.oid = writeLoose(gitDir(w), 'blob', Buffer.from(text));
  });

  reg.define(/^a pack holding a blob "([^"]+)"$/, (w, text) => {
    const data = Buffer.from(text);
    w.oid = frame('blob', data).oid;
    writePack(gitDir(w), [{ type: 3, data, oid: w.oid }]);
  });

  reg.define(/^a pack whose blob "([^"]+)" has an ofs-delta extending it with "([^"]+)"$/,
    (w, baseText, suffix) => packWithDelta(w, baseText, suffix, 6));

  reg.define(/^a pack whose blob "([^"]+)" has a ref-delta extending it with "([^"]+)"$/,
    (w, baseText, suffix) => packWithDelta(w, baseText, suffix, 7));

  reg.define(/^an empty object store$/, (w) => {
    gitDir(w);
    w.oid = 'deadbeef'.repeat(5);
  });

  reg.define(/^a loose object that inflates far past the object cap$/, (w) => {
    // A zlib bomb in git clothing: tiny on disk, vast when inflated. Written
    // at the id the read will ask for, so only the cap can refuse it.
    const bloated = Buffer.concat([
      Buffer.from('blob 67108864\0', 'latin1'),
      Buffer.alloc(64 * 1024 * 1024),
    ]);
    w.oid = '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d';
    const dir = path.join(gitDir(w), 'objects', w.oid.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, w.oid.slice(2)), zlib.deflateSync(bloated));
  });

  reg.define(/^a repository whose HEAD names a branch with no commits$/, (w) => {
    // Exactly what `git init` leaves: a symbolic HEAD, no ref behind it.
    fs.writeFileSync(path.join(gitDir(w), 'HEAD'), 'ref: refs/heads/main\n');
  });

  reg.define(/^a repository whose HEAD commit holds "([^"]+)" and "([^"]+)"$/, (w, a, b) => {
    const g = gitDir(w);
    w.blobOids = {
      [a]: frame('blob', Buffer.from(`content of ${a}`)).oid,
      [b]: frame('blob', Buffer.from(`content of ${b}`)).oid,
    };
    const files = new Map(Object.entries(w.blobOids).map(([p, oid]) => [p, { oid, mode: 0o100644 }]));
    const commit = writeCommit(g, writeTrees(g, files));
    fs.mkdirSync(path.join(g, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(g, 'refs', 'heads', 'main'), commit + '\n');
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^(?:that|the delta's) object is read$/, (w) => {
    w.result = readObject(gitDir(w), w.oid);
  });

  reg.define(/^an absent id is read$/, (w) => {
    w.result = readObject(gitDir(w), w.oid);
  });

  reg.define(/^the committed tree is read$/, (w) => {
    w.tree = readHeadTree(gitDir(w));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^it comes back as a "([^"]+)" holding "([^"]+)"$/, (w, type, text) => {
    assert.ok(w.result !== null, 'the object came back as nothing');
    assert.strictEqual(w.result.type, type);
    assert.strictEqual(w.result.data.toString('utf8'), text);
  });

  reg.define(/^the read answers nothing$/, (w) => {
    assert.strictEqual(w.result, null);
  });

  reg.define(/^it holds (\d+) paths$/, (w, n) => {
    assert.ok(w.tree !== null, 'the committed tree came back unreadable, not empty');
    assert.strictEqual(w.tree.size, Number(n),
      `expected ${n} paths, got: ${[...w.tree.keys()].join(', ')}`);
  });

  reg.define(/^it maps "([^"]+)" to that file's blob id$/, (w, p) => {
    const got = w.tree.get(p);
    assert.ok(got, `"${p}" is not in the flattened tree`);
    assert.strictEqual(got.oid, w.blobOids[p]);
  });
};
