// @ts-check
'use strict';
// test/launch-tmux-portability.test.js — the launcher's tmux dialect must run on
// the tmux people actually have, not the newest one.
//
// THE BUG THIS PINS. scripts/launch.sh sized the sidebar with `split-window -p 34`.
// That is the deprecated spelling: tmux 3.4 — which is what Ubuntu 24.04 LTS ships,
// so every stock Ubuntu Server — rejects it outright with `size missing`, while 3.6
// accepts it. Developing on 3.6 and deploying to 3.4 is the common direction, so the
// break only ever showed up on the server.
//
// WHY IT WAS WORTH A TEST rather than a one-line fix and move on: the failure is
// SILENT. `-p` fails at the split, which happens AFTER new-session has already
// created the session and started Claude. So the session exists, Claude runs, and
// only the sidebar is missing — and launch.sh's stderr goes to the terminal that
// spawned it, which by then is gone. You get a working-looking ccr with no economy
// panel and nothing to read. Nothing else in the suite touches the split's spelling.
//
// `-l <n>%` is accepted by tmux 3.1 through 3.6+ and produces an identical split,
// so the fix needs no version guard — which is exactly why a regression here would
// be easy to reintroduce by "tidying" it back to the shorter flag.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/** launch.sh with comment lines stripped, so prose can discuss `-p` freely. */
function launcherCode() {
  const p = path.join(__dirname, '..', 'scripts', 'launch.sh');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('the sidebar split sizes with -l <pct>%, the spelling tmux 3.4 accepts', () => {
  const code = launcherCode();
  const split = code.split('\n').find((l) => l.includes('split-window'));
  assert.ok(split, 'launch.sh still splits a window');
  assert.match(
    split,
    /-l\s+"?\$\{CCR_SIDEBAR_PCT:-34\}%"?/,
    'the sidebar width is given as a percentage via -l, honouring CCR_SIDEBAR_PCT',
  );
});

test('no split-window uses the deprecated -p form that tmux 3.4 rejects', () => {
  for (const line of launcherCode().split('\n')) {
    if (!line.includes('split-window')) continue;
    assert.doesNotMatch(
      line,
      /\s-p\s/,
      `split-window must not size with -p (tmux 3.4 answers "size missing"): ${line.trim()}`,
    );
  }
});

test('the percentage stays configurable through CCR_SIDEBAR_PCT', () => {
  // The `%` belongs INSIDE the expansion's quotes, not appended to a bare number
  // elsewhere — a split that hardcodes 34 would pass the flag check above while
  // quietly dropping the documented env override.
  assert.match(
    launcherCode(),
    /CCR_SIDEBAR_PCT:-34/,
    'the documented default of 34 is still the fallback, not a hardcoded literal',
  );
});
