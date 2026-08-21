// @ts-check
'use strict';
// Step definitions for features/pane-config.feature — drives the real
// src/pane-config.js against real temp directories. Nothing is mocked: the
// point of these scenarios is where ccr looks on a real filesystem, so a fake
// filesystem would test the wrong thing.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadPaneConfig, configPath } = require('../../src/pane-config');

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function definePaneConfigSteps(reg) {
  /** A temp dir removed when the scenario ends, pass or fail. */
  const tmp = (/** @type {Record<string, any>} */ w) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-paneconf-'));
    w.defer(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };

  /** Point CCR_CONFIG at a file inside a fresh temp "config dir". */
  const withConfig = (/** @type {Record<string, any>} */ w, /** @type {string} */ body) => {
    w.configDir = w.configDir || tmp(w);
    w.configFile = path.join(w.configDir, 'config.json');
    if (body != null) fs.writeFileSync(w.configFile, body);
    w.env = { CCR_CONFIG: w.configFile };
    return w.configFile;
  };

  const load = (/** @type {Record<string, any>} */ w) => {
    w.result = loadPaneConfig({ env: w.env || {}, home: w.home || os.homedir() });
    return w.result;
  };

  // --- Where configuration lives ---

  reg.define(/^no CCR_CONFIG override is set$/, (w) => { w.env = { XDG_CONFIG_HOME: '/xdg' }; });
  reg.define(/^ccr resolves its configuration path$/, (w) => {
    w.resolved = configPath(w.env || {});
    w.resolvedNoXdg = configPath({});
  });
  reg.define(/^it reads "ccr\/config\.json" under the XDG config directory$/, (w) => {
    assert.strictEqual(w.resolved, path.join('/xdg', 'ccr', 'config.json'));
  });
  reg.define(/^it falls back to "~\/\.config" when XDG_CONFIG_HOME is unset$/, (w) => {
    assert.strictEqual(w.resolvedNoXdg, path.join(os.homedir(), '.config', 'ccr', 'config.json'));
  });
  reg.define(/^the path is not inside ccr's state directory$/, (w) => {
    const stateDir = path.join(os.homedir(), '.ccr');
    for (const p of [w.resolved, w.resolvedNoXdg]) {
      assert.ok(!p.startsWith(stateDir + path.sep), `config must not live in the state dir: ${p}`);
    }
  });

  // --- A repository can never introduce a pane ---

  reg.define(/^a config file sitting in the current working directory$/, (w) => {
    // Written into a temp dir we then chdir into, so the "repo" is real.
    const repo = tmp(w);
    fs.writeFileSync(path.join(repo, 'config.json'), JSON.stringify({ panes: [{ path: '/repo/planted.json' }] }));
    fs.writeFileSync(path.join(repo, '.ccr.json'), JSON.stringify({ panes: [{ path: '/repo/planted.json' }] }));
    const cwd = process.cwd();
    process.chdir(repo);
    w.defer(() => process.chdir(cwd));
    w.repoDir = repo;
  });
  reg.define(/^a config file in the user's config directory naming no panes$/, (w) => {
    withConfig(w, JSON.stringify({ panes: [] }));
  });
  reg.define(/^the sidecar loads its pane configuration$/, (w) => { load(w); });
  reg.define(/^no pane from the working-directory file is configured$/, (w) => {
    assert.deepStrictEqual(w.result.panes, [], 'a working-directory config must contribute nothing');
  });
  reg.define(/^ccr never searches upward from the working directory for configuration$/, () => {
    // Structural: the resolver is a pure function of env + homedir. If it ever
    // grew an upward walk it would have to consult process.cwd().
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pane-config.js'), 'utf8');
    assert.ok(!/process\.cwd\(\)/.test(src), 'pane-config must never consult the working directory');
    assert.ok(!/readdirSync|existsSync/.test(src), 'no directory probing — the path is computed, not discovered');
  });

  // --- Reading the pane list ---

  reg.define(/^a configuration naming three blob paths in a deliberate order$/, (w) => {
    withConfig(w, JSON.stringify({ panes: [{ path: '/a/one.json' }, { path: '/b/two.json' }, { path: '/c/three.json' }] }));
  });
  reg.define(/^the three panes are configured in exactly that order$/, (w) => {
    assert.deepStrictEqual(w.result.panes.map((/** @type {any} */ p) => p.source),
      ['/a/one.json', '/b/two.json', '/c/three.json']);
  });

  reg.define(/^a configuration naming the same blob path twice$/, (w) => {
    withConfig(w, JSON.stringify({ panes: [{ path: '/same.json' }, { path: '/same.json' }] }));
  });
  reg.define(/^two panes are configured$/, (w) => {
    assert.strictEqual(w.result.panes.length, 2, 'identical paths are never de-duplicated');
  });

  reg.define(/^a configuration naming a blob path relative to itself$/, (w) => {
    withConfig(w, JSON.stringify({ panes: [{ path: 'sub/blob.json' }] }));
  });
  reg.define(/^the pane path resolves against the configuration file's own directory$/, (w) => {
    assert.strictEqual(w.result.panes[0].path, path.join(w.configDir, 'sub', 'blob.json'));
  });

  reg.define(/^a configuration naming a blob path beginning with a tilde$/, (w) => {
    w.home = path.join(os.tmpdir(), 'ccr-fake-home');
    withConfig(w, JSON.stringify({ panes: [{ path: '~/tools/blob.json' }] }));
  });
  reg.define(/^the pane path resolves under the user's home directory$/, (w) => {
    assert.strictEqual(w.result.panes[0].path, path.join(w.home, 'tools', 'blob.json'));
  });

  reg.define(/^a configuration naming a blob path beginning with a tilde and a backslash$/, (w) => {
    w.home = path.join(os.tmpdir(), 'ccr-fake-home');
    withConfig(w, JSON.stringify({ panes: [{ path: '~\\tools\\blob.json' }] }));
  });
  reg.define(/^the pane path begins at the user's home directory$/, (w) => {
    // Deliberately not an equality check: the tail after the tilde stays as the
    // user wrote it, so it is native on Windows and a literal backslash in a
    // filename on POSIX. What must hold on both is that the tilde expanded.
    const got = w.result.panes[0].path;
    assert.ok(got.startsWith(w.home + path.sep), `expected a path under ${w.home}, got: ${got}`);
  });

  reg.define(/^a configuration file saved with a UTF-8 byte-order mark$/, (w) => {
    withConfig(w, '\uFEFF' + JSON.stringify({ panes: [{ path: '/tools/blob.json' }] }));
  });
  reg.define(/^the configured pane is read from it as normal$/, (w) => {
    assert.deepStrictEqual(w.result.panes.map((/** @type {any} */ p) => p.source), ['/tools/blob.json']);
  });

  // --- A bad config costs the panes, never the panel ---

  reg.define(/^a configuration file that is not parseable JSON$/, (w) => {
    withConfig(w, '{ panes: [ this is not json ');
  });
  reg.define(/^no panes are configured$/, (w) => {
    assert.deepStrictEqual(w.result.panes, []);
  });
  reg.define(/^the configuration error is named as "([^"]+)"$/, (w, named) => {
    assert.strictEqual(w.result.error, named, `expected the loader to name "${named}"`);
  });
  reg.define(/^no configuration error is reported$/, (w) => {
    assert.strictEqual(w.result.error, null, `unexpected config error: ${w.result.error}`);
  });
  reg.define(/^a configuration file whose top level has no pane list$/, (w) => {
    withConfig(w, JSON.stringify({ paens: [{ path: '/typo.json' }] }));
  });

  // --- The panel says so, rather than looking unconfigured ---

  reg.define(/^the sidecar renders its panel$/, (w) => {
    const { composeFrame } = require('../../src/sidecar');
    const d = tmp(w);
    fs.writeFileSync(path.join(d, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 4.8' }, rate_limits: {}, cost: { total_cost_usd: 1 },
    }));
    // composeFrame reads the config through the real loader, so the override has
    // to be on the process env rather than a passed-in one. Restored either way.
    const prior = process.env.CCR_CONFIG;
    process.env.CCR_CONFIG = w.configFile;
    w.defer(() => {
      if (prior === undefined) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prior;
    });
    w.panel = composeFrame(d, { now: Date.now() });
  });
  reg.define(/^the panel names the configuration as the problem$/, (w) => {
    assert.match(w.panel, /config: not valid JSON/, `no config marker in panel:\n${w.panel}`);
  });
  reg.define(/^the panel still shows the economy view$/, (w) => {
    assert.match(w.panel, /economy/, 'the panel must survive a broken config');
  });

  reg.define(/^loading the configuration raises nothing$/, (w) => {
    // Already proven by reaching here, but assert the contract explicitly: the
    // loader is total, because an exception would reach the draw loop.
    assert.doesNotThrow(() => loadPaneConfig({ env: w.env || {}, home: w.home || os.homedir() }));
  });

  reg.define(/^a configuration whose pane list mixes valid entries with junk$/, (w) => {
    withConfig(w, JSON.stringify({
      panes: [{ path: '/good/one.json' }, 'a bare string', 42, null, { nopath: true }, { path: '' }, { path: '/good/two.json' }],
    }));
  });
  reg.define(/^only the valid entries become panes$/, (w) => {
    assert.deepStrictEqual(w.result.panes.map((/** @type {any} */ p) => p.source), ['/good/one.json', '/good/two.json']);
  });

  reg.define(/^a configuration whose pane entry also carries a "__proto__" key$/, (w) => {
    // Written as raw text: JSON.stringify of an object literal cannot express a
    // __proto__ KEY, and the whole point is that the parser produces one.
    withConfig(w, '{"panes":[{"path":"/ok.json","__proto__":{"polluted":"yes"}}]}');
  });
  reg.define(/^the pane is configured from its path alone$/, (w) => {
    assert.strictEqual(w.result.panes.length, 1);
    assert.strictEqual(w.result.panes[0].source, '/ok.json');
  });
  reg.define(/^no property of any shared prototype has been altered$/, () => {
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined, 'Object.prototype was polluted');
    assert.strictEqual(/** @type {any} */ (Object.prototype).polluted, undefined);
  });

  reg.define(/^no configuration file exists$/, (w) => {
    const d = tmp(w);
    w.env = { CCR_CONFIG: path.join(d, 'absent.json') };
  });
  reg.define(/^the sidecar still renders its own economy view$/, () => {
    // The economy view is unconditional: panes are additive views, never a
    // replacement, so "no config" is indistinguishable from before this feature.
    const { composeFrame } = require('../../src/sidecar');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-econ-'));
    try {
      fs.writeFileSync(path.join(d, 'last-status.json'), JSON.stringify({
        model: { display_name: 'Opus 4.8' }, rate_limits: {}, cost: { total_cost_usd: 1 },
      }));
      assert.match(composeFrame(d, { now: Date.now(), panes: [] }), /economy/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  reg.define(/^the configuration path is a pipe that never yields bytes$/, (w) => {
    const d = tmp(w);
    const p = path.join(d, 'config.json');
    // Same guard as pane-blobs.steps.js: MSYS mkfifo on Windows exits 0 without
    // creating a FIFO, so the command succeeding proves nothing.
    try {
      execFileSync('mkfifo', [p]);
      if (!fs.lstatSync(p).isFIFO()) w.skipFifo = true;
    } catch { w.skipFifo = true; }
    w.env = { CCR_CONFIG: p };
  });
  reg.define(/^loading completes without blocking$/, (w) => {
    if (w.skipFifo) return;                 // no mkfifo on this platform
    // A blocking read here would hang the scenario rather than fail it, which is
    // itself the signal; the assertion documents the intent.
    const started = Date.now();
    load(w);
    assert.ok(Date.now() - started < 2000, 'reading a fifo must not block the loop');
  });
};
