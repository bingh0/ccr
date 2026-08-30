// @ts-check
'use strict';
// test/tmux-version-floor.test.js — `ccr doctor` must name a tmux that is too old.
//
// WHY THIS IS WORTH PINNING. ccr's tmux dialect acquired a floor without ever
// declaring one: `split-window -l 34%` (3.1, after `-p` was deprecated there and
// rejected outright by 3.4+), `terminal-features` for true colour over mosh
// (3.1), and pane-scoped hooks for the sidebar's copy-mode guard (3.2). On an
// older tmux the failures are SILENT and each looks like something else — no
// sidebar, colours quietly flattened to 256, copy-mode freezing the panel. A
// version line in `doctor` turns three confusing symptoms into one sentence.
//
// The version probe is injected, so this never shells out to a real tmux and
// can assert on versions the test machine does not have.

const test = require('node:test');
const assert = require('node:assert');
const doctor = require('../src/doctor');

/**
 * Run doctor with a stubbed tmux of the given version; return its output.
 * @param {{major:number,minor:number}|null} version
 * @returns {string}
 */
function runWith(version) {
  let buf = '';
  doctor.run({
    platform: 'linux',
    has: (cmd) => (cmd === 'tmux' ? '/usr/bin/tmux' : null),
    tmuxVersion: () => version,
    write: (s) => { buf += s; },
  });
  return buf;
}

test('a tmux below the floor is reported, with its version', () => {
  const out = runWith({ major: 3, minor: 0 });
  assert.match(out, /tmux 3\.0/, 'the actual version is named, not just "too old"');
  assert.match(out, /3\.2\+/, 'and the wanted version is stated');
});

test('tmux 2.x is likewise flagged', () => {
  assert.match(runWith({ major: 2, minor: 9 }), /tmux 2\.9/);
});

test('a tmux at or above the floor passes clean', () => {
  for (const v of [{ major: 3, minor: 2 }, { major: 3, minor: 7 }, { major: 4, minor: 0 }]) {
    const out = runWith(v);
    assert.doesNotMatch(out, /ccr wants/, `tmux ${v.major}.${v.minor} should not warn`);
    assert.match(out, new RegExp(`tmux ${v.major}\\.${v.minor}`));
  }
});

test('an unreadable version is not turned into a failure', () => {
  // A parse miss is absence of evidence, not evidence of an old tmux. Claiming
  // a problem here would send people chasing a version that is probably fine.
  const out = runWith(null);
  assert.doesNotMatch(out, /ccr wants/);
  assert.match(out, /tmux \(/, 'the binary is still reported');
});
