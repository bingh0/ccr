// @ts-check
'use strict';
// test/instance-commands.test.js — the three commands that honour the
// resolution chain must actually consult it.
//
// features/instance-resolution.feature rules that `-i` "is honored by exactly
// three commands: economy, sidecar, cycle-view", and that the chain runs
// CCR_STATE_DIR → the live instance whose launch directory contains the cwd →
// the single live one → else refuse. `ccr sidecar` obeyed only the first link:
// it consulted the chain when -i was typed and fell through to the CONTAINER
// (~/.ccr) otherwise, so a bare `ccr sidecar` beside a running instance opened
// an empty pane and looked like it needed the instance named exactly right.
//
// Structural rather than behavioural because the failure is a MISSING call:
// there is no output to assert on a chain that was never consulted, and the
// commands are not exported from bin/ccr.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ccr.js'), 'utf8');

/** The body of a named function declaration in bin/ccr.js. */
function bodyOf(/** @type {string} */ name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in bin/ccr.js`);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

test('economy, sidecar and cycle-view all consult the resolution chain', () => {
  for (const [fn, command] of [
    ['cmdEconomy', 'economy'],
    ['cmdSidecar', 'sidecar'],
    ['cmdCycleView', 'cycle-view'],
  ]) {
    const body = bodyOf(fn);
    assert.ok(body.includes('resolveInstance('), `${fn} must consult the chain`);
    assert.ok(body.includes(`command: '${command}'`), `${fn} must name itself to the chain`);
  }
});

test('none of them consults the chain only when -i was typed', () => {
  // The exact shape of the bug: `if (!stateDir && target != null)` guards the
  // call behind the ONE link the chain does not need help with. A resolution
  // that runs only when you already named the instance is not a resolution.
  for (const fn of ['cmdEconomy', 'cmdSidecar', 'cmdCycleView']) {
    const body = bodyOf(fn);
    assert.ok(
      !/target\s*!=\s*null[^)]*\)\s*\{[\s\S]{0,200}?resolveInstance/.test(body),
      `${fn} must not gate the chain on -i being present`,
    );
  }
});
