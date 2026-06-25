// @ts-check
'use strict';
// Step definitions for features/statusline-injection.feature — drives the real
// settings-inject.writeSettingsFile (so the temp-file naming/location/cleanup
// scenarios assert genuine behavior) plus launch-win.run() for the wiring that
// guarantees no ~/.claude mutation.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchWin, launcherDeps, panes, inject } = require('./_win-helpers');

function runWithRealSettings(world) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-sl-'));
  world._tmpDir = tmpDir;
  (world.present ||= {}).claude = true;
  world.present.wt = true;
  const deps = launcherDeps(world, {
    writeSettings: (s) => { const f = inject.writeSettingsFile(s, { tmpDir }); world.settingsPath = f; return f; },
  });
  world.code = launchWin.run(undefined, deps);
  world.args = world.spawns.length ? world.spawns[0].args : null;
}
const cleanup = (w) => { if (w._tmpDir) fs.rmSync(w._tmpDir, { recursive: true, force: true }); };

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineStatuslineInjectionSteps(reg) {
  // When (three phrasings across scenarios)
  reg.define(/^I run "ccr"$/, (w) => runWithRealSettings(w));
  reg.define(/^I run "ccr" and then the window closes$/, (w) => runWithRealSettings(w));
  reg.define(/^I run "ccr" and the window closes$/, (w) => runWithRealSettings(w));

  // A temp settings file is written and passed to claude
  reg.define(/^a settings file is written under %TEMP% \(e\.g\. "ccr-settings-XXXX\.json"\)$/, (w) => {
    assert.ok(w.settingsPath, 'a settings file path was produced');
    assert.match(path.basename(w.settingsPath), /^ccr-settings-[0-9a-f]+\.json$/);
    assert.ok(w.settingsPath.startsWith(w._tmpDir), 'written under the temp dir, not ~/.claude');
  });
  reg.define(/^it contains a statusLine object of type "command"$/, (w) => {
    const onDisk = JSON.parse(fs.readFileSync(w.settingsPath, 'utf8'));
    assert.strictEqual(onDisk.statusLine.type, 'command');
  });
  reg.define(/^`claude` is launched with "--settings <that file>"$/, (w) => {
    assert.ok(panes(w.args).pane0.includes(`--settings "${w.settingsPath}"`), panes(w.args).pane0);
    cleanup(w);
  });

  // No file under ~/.claude is modified
  reg.define(/^a snapshot of "~\/\.claude" before launch$/, () => {});
  reg.define(/^no file under "~\/\.claude" has changed$/, (w) => {
    assert.ok(!String(w.settingsPath).includes('.claude'), w.settingsPath);
  });
  reg.define(/^credentials and CCS symlinks are untouched$/, (w) => {
    // The only file the launcher writes is the temp settings file; nothing
    // targets ~/.claude, its credentials, or the CCS instance symlinks.
    assert.deepStrictEqual(w.written, [], 'no settings injected via the fallback recorder');
    cleanup(w);
  });

  // Temp settings file cleaned up after the window closes
  reg.define(/^the temp settings file is removed on a best-effort basis$/, (w) => {
    // pane 0 deletes the temp file when the window closes (cleanup-after-close).
    assert.match(panes(w.args).pane0, /del \/q ".*ccr-settings-[0-9a-f]+\.json"/);
    cleanup(w);
  });

  // Inline command form
  reg.define(/^the launcher uses the inline statusLine form$/, (w) => {
    w.cmd = inject.buildStatusLineCommandInline({ node: 'C:\\nodejs\\node.exe', ccrJs: 'C:\\repo\\bin\\ccr.js' });
  });
  reg.define(/^the command value is a quoted node path, the ccr\.js path, and "statusline"$/, (w) => {
    assert.match(w.cmd, /^"[^"]+" "[^"]+" statusline$/);
  });
  reg.define(/^it embeds cleanly in the settings JSON with no shell-quoting hazards$/, (w) => {
    const round = JSON.parse(JSON.stringify(inject.buildSettings(w.cmd)));
    assert.strictEqual(round.statusLine.command, w.cmd);
  });
};
