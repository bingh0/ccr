// @ts-check
'use strict';
// test/sidecar-keys.test.js — the key path against a REAL terminal.
//
// features/sidecar-hotkeys.feature drives runWithKeys with an injected stdin and
// an injected spawn, which is right for the ordering rules it states (raw mode
// handed back on every path, the child killed on interrupt) — none of that is
// observable through a real tty. But every one of those assertions is measured
// against stand-ins this repository wrote, and a key path that works perfectly
// against a fake terminal and not at all against a real one would pass all of
// them. That is the failure this file exists to catch: the far side here is an
// actual pty, an actual child process, and the counter file on disk.
//
// Skips cleanly where a pty cannot be allocated — util-linux `script` is the
// only zero-dependency way to get one, and its flags differ on BSD/macOS. The
// same rule test/git-repo.test.js follows for `git`: cover it where it exists
// rather than not covering it anywhere.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CCR_JS = path.join(__dirname, '..', 'bin', 'ccr.js');

/** Is util-linux `script` here to give us a pty? */
const havePty = (() => {
  if (process.platform !== 'linux') return false;
  try {
    const r = spawnSync('script', ['--version'], { encoding: 'utf8' });
    return r.status === 0 && /util-linux/.test(String(r.stdout));
  } catch { return false; }
})();

/**
 * Run a command on a real pty, typing `keys` into it, and return the state dir.
 * @param {string[]} args ccr arguments after the script path
 * @param {string} keys bytes to type
 */
function onPty(args, keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-keys-'));
  fs.writeFileSync(path.join(dir, 'last-status.json'), JSON.stringify({
    model: { display_name: 'Opus 5' }, rate_limits: {}, cost: { total_cost_usd: 1 },
  }));
  const cmd = [process.execPath, CCR_JS, ...args, '--state-dir', dir]
    .map((a) => `'${a}'`).join(' ');
  // The typed bytes arrive spaced out, then Ctrl-C: a single burst would also
  // pass a reader that ignored everything after the first chunk.
  const feed = [...keys].map((k) => `printf '%s' '${k}'; sleep 0.6;`).join(' ');
  execFileSync('bash', ['-c', `( ${feed} printf '\\003'; sleep 0.5 ) | script -qec "${cmd}" /dev/null`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  return dir;
}

test('a real keypress on a real terminal reaches the request counter', { skip: !havePty }, (t) => {
  const dir = onPty(['sidecar', '--keys'], '  ');   // two spaces
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'view-request'), 'utf8').trim(), '2',
    'two presses on a real pty must leave a count of two — this is the whole path: '
    + 'raw mode, the key table, the counter file, in the processes that really run');
});

test('a key the reader does not own leaves no request at all', { skip: !havePty }, (t) => {
  const dir = onPty(['sidecar', '--keys'], 'xy');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(!fs.existsSync(path.join(dir, 'view-request')),
    'keys outside the closed set must not reach the counter');
});

test('interrupting a real key-reading sidecar leaves no child behind', { skip: !havePty }, (t) => {
  const dir = onPty(['sidecar', '--keys'], ' ');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The parent is gone (execFileSync returned). An orphaned panel would still be
  // drawing at a dead terminal and still beating this state dir's heartbeat.
  //
  // Read /proc directly rather than shelling out to pgrep: `pgrep -f` matches
  // full command lines, INCLUDING that of the shell it was invoked from, which
  // contains the pattern. That version reported two survivors for a state dir
  // that had never existed — a check that ran, failed, and measured nothing.
  const survivors = fs.readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .filter((pid) => {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
        return cmd.includes(CCR_JS) && cmd.includes(dir);
      } catch { return false; }              // exited between readdir and read
    });
  assert.deepStrictEqual(survivors, [],
    'Ctrl-C must take the panel down with the key reader; an orphan keeps beating '
    + 'this state dir\'s heartbeat and would make the next launch stand down');
});
