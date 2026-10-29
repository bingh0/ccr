// @ts-check
'use strict';
// test/instance-commands.test.js — the four commands that honour the
// resolution chain must actually consult it.
//
// features/instance-resolution.feature rules that `-i` "is honored by exactly
// four commands: economy, sidecar, cycle-view, subagents" (the fourth joined
// on 2026-09-02, the sanctioned reword), and that the chain runs
// CCR_STATE_DIR → the live instance whose launch directory contains the cwd →
// the single live one → else refuse. `ccr sidecar` obeyed only the first link:
// it consulted the chain when -i was typed and fell through to the CONTAINER
// (~/.ccr) otherwise, so a bare `ccr sidecar` beside a running instance opened
// an empty pane and looked like it needed the instance named exactly right.
//
// Structural rather than behavioural because the failure is a MISSING call:
// there is no output to assert on a chain that was never consulted, and the
// commands are not exported from bin/ccr.js.
//
// THE SAME LAW, ONE COMMAND OVER: `--all` is declared globally by parseArgs and
// read by `ccr subagents` alone, so on any other command it must be refused
// LOUDLY rather than swallowed — a widener that widens nothing is worse than
// an error. `ccr resume` is where that bites, because it really does have a
// widened scope and it spells it as a POSITIONAL: `ccr resume all`. Owner
// ruling 2026-09-02, "be as correct as possible, and update documentation,
// rather than supporting the old behavior": the refusal stays, `cmdResume`'s
// dead `--all` branch is gone, and the two tests at the bottom run the REAL
// command to pin both halves — the refusal and the spelling that works.
//
// MUTATION LOG for those two, since a test no world can make red is hollow:
//   let `resume` through the stray-flag refusal in main()  -> the refusal test
//     went red on the exit code (0, not 2)
//   `cmdResume` reads the scope off `--all` instead of the positional `all`
//     (the dead branch, restored as the ONLY branch)       -> the acceptance
//     test went red on the advisor's heading, which said "this project"
// Restoring the dead branch ALONGSIDE the positional is deliberately absent
// from this log: it is undetectable, because parseArgs consumes `--all` as an
// option and it can never arrive as `positionals[1]`. That is the evidence the
// branch was dead, and the reason the ruling removes it rather than testing it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ccr.js'), 'utf8');

/** The body of a named function declaration in bin/ccr.js. */
function bodyOf(/** @type {string} */ name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in bin/ccr.js`);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

test('economy, sidecar, cycle-view and subagents all consult the resolution chain', () => {
  for (const [fn, command] of [
    ['cmdEconomy', 'economy'],
    ['cmdSidecar', 'sidecar'],
    ['cmdCycleView', 'cycle-view'],
    ['cmdSubagents', 'subagents'],
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
  for (const fn of ['cmdEconomy', 'cmdSidecar', 'cmdCycleView', 'cmdSubagents']) {
    const body = bodyOf(fn);
    assert.ok(
      !/target\s*!=\s*null[^)]*\)\s*\{[\s\S]{0,200}?resolveInstance/.test(body),
      `${fn} must not gate the chain on -i being present`,
    );
  }
});

const CCR_JS = path.join(__dirname, '..', 'bin', 'ccr.js');

/** A sandbox HOME with an empty `~/.claude/projects`, so the advisor has a real but empty world to read. */
function sandboxHome(/** @type {import('node:test').TestContext} */ t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

/** Run the real CLI with the sandbox home, so nothing reads the developer's ~/.claude. */
function runCcr(/** @type {string} */ home, /** @type {string[]} */ args) {
  return spawnSync(process.execPath, [CCR_JS, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, CCR_STATE_DIR: path.join(home, '.ccr') },
  });
}

test('`ccr resume --all` is refused loudly, naming the flag and the command that owns it', (t) => {
  const home = sandboxHome(t);
  const r = runCcr(home, ['resume', '--all']);
  assert.strictEqual(r.status, 2, `expected exit 2; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--all'), `the refusal must name the flag: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stderr.includes('subagents'), `the refusal must name the command that reads it: ${JSON.stringify(r.stderr)}`);
  assert.strictEqual(r.stdout, '', 'a refused command prints no advisor listing');
});

test('`ccr resume all` — the positional widener — is accepted', (t) => {
  const home = sandboxHome(t);
  const r = runCcr(home, ['resume', 'all']);
  assert.strictEqual(r.status, 0, `expected exit 0; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.strictEqual(r.stderr, '', `nothing to complain about: ${JSON.stringify(r.stderr)}`);
  // The control arm: `all` is a SPELLING the CLI takes, not merely an argument
  // it ignores — the refusal above proves the flag form is rejected, and the
  // widened scope in the output proves the positional reached the advisor
  // rather than being dropped on the floor the way `--all` once was.
  const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /all projects/, `the widened scope should show in the advisor's own heading: ${JSON.stringify(plain)}`);
  const bare = runCcr(home, ['resume']);
  assert.doesNotMatch(bare.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /all projects/,
    'and a bare `ccr resume` stays scoped to this project — otherwise the positional proves nothing');
});
