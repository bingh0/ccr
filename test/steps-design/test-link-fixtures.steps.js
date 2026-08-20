// @ts-check
'use strict';
// Design-tier steps for features/design/test-link-fixtures.feature: the link
// helpers in test/_links.js, driven directly. The design tier's charter is
// implementation contracts one level below the product surface — and this one
// is a contract the TEST SUITE holds itself to, since a fixture the platform
// cannot build is how a ratified @security scenario came to pass while
// asserting nothing.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultDirUsable } = require('../../src/instance-slot');
const links = require('../_links');

/** Temp dirs matching the probe's own naming, so "left nothing behind" is checkable. */
const probeLitter = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ccr-linkprobe-'));

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineTestLinkFixturesSteps(reg) {
  const sandbox = (/** @type {Record<string, any>} */ w) => {
    if (!w.dir) {
      w.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-links-'));
      w.defer(() => fs.rmSync(w.dir, { recursive: true, force: true }));
    }
    return w.dir;
  };

  // ── Given ─────────────────────────────────────────────────────────────────

  reg.define(/^a real directory for the link to point at$/, (w) => {
    w.target = path.join(sandbox(w), 'real');
    fs.mkdirSync(w.target);
  });

  // The capability is INJECTED rather than probed for these two, so both
  // branches are exercised on every machine. Probing here would mean the
  // skip-reason path only ever ran on unprivileged Windows and the no-skip
  // path only ever ran everywhere else — each half untested where it matters.
  reg.define(/^a machine that cannot create a symlink to a file$/, (w) => { w.available = false; });
  reg.define(/^a machine that can create a symlink to a file$/, (w) => { w.available = true; });

  reg.define(/^a scenario step that cannot build its fixture here$/, (w) => {
    w.fixture = 'a symlink pointing at another file';
    w.limit = 'Windows without Developer Mode cannot create one';
  });

  // ── When ──────────────────────────────────────────────────────────────────

  reg.define(/^the suite plants a directory link beside it$/, (w) => {
    w.link = path.join(sandbox(w), 'link');
    links.plantDirLink(w.target, w.link);
  });

  reg.define(/^the suite is asked whether file symlinks can be created$/, (w) => {
    w.answer = links.fileSymlinksAvailable();
  });

  reg.define(/^the suite decides whether such a test should run$/, (w) => {
    w.skip = links.skipWithoutFileSymlinks(w.available);
  });

  reg.define(/^the step declines to run$/, (w) => {
    w.announced = [];
    links.announceUnbuildable(w.fixture, w.limit, (/** @type {string} */ s) => w.announced.push(s));
  });

  // ── Then ──────────────────────────────────────────────────────────────────

  reg.define(/^the planted link reports as a symbolic link$/, (w) => {
    assert.strictEqual(fs.lstatSync(w.link).isSymbolicLink(), true,
      'a junction must be indistinguishable from a symlink to lstat, or the guard under test is not being exercised');
  });

  reg.define(/^the slot directory check accepts the real directory and refuses the link$/, (w) => {
    assert.strictEqual(defaultDirUsable(w.target), true, 'the real directory is usable');
    assert.strictEqual(defaultDirUsable(w.link), false, 'the link is not');
  });

  reg.define(/^the answer matches what creating one on this machine actually does$/, (w) => {
    // The far side: attempt it here, without going through the helper, so the
    // probe is checked against the filesystem rather than against itself.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-links-oracle-'));
    let reality = false;
    try {
      const target = path.join(dir, 't');
      fs.writeFileSync(target, 'x');
      fs.symlinkSync(target, path.join(dir, 'l'), 'file');
      reality = true;
    } catch {
      reality = false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(w.answer, reality);
  });

  reg.define(/^the probe leaves nothing behind on disk$/, () => {
    const before = probeLitter();
    links.probeFileSymlinks();
    assert.deepStrictEqual(probeLitter(), before, 'the probe cleaned up after itself');
  });

  reg.define(/^it yields a skip reason naming the privilege that is missing$/, (w) => {
    assert.strictEqual(typeof w.skip, 'string', 'a reason, not a bare true');
    assert.match(w.skip, /Developer Mode|elevated/,
      'the reason must say what the machine is missing — a skip nobody can act on is the debt this file refuses');
  });

  reg.define(/^it yields no skip at all$/, (w) => {
    assert.strictEqual(w.skip, false);
  });

  reg.define(/^the reason is written to the runner's error output$/, (w) => {
    assert.strictEqual(w.announced.length, 1, 'exactly one announcement');
  });

  reg.define(/^the message names both the fixture and the platform limit$/, (w) => {
    const msg = w.announced.join('');
    assert.ok(msg.includes(w.fixture), `names the fixture: ${msg}`);
    assert.ok(msg.includes(w.limit), `names the limit: ${msg}`);
  });
};
