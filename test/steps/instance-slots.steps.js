// @ts-check
'use strict';
// Step definitions for features/instance-slots.feature.
//
// These drive the REAL predicates against a real temp home: occupancy is decided
// by an actual owner file, heartbeat and `exited` sentinel, and reservations by
// an actual exclusive create. Only the home directory is stubbed, so a bug in
// defaultInspect or defaultReserve fails these scenarios rather than hiding
// behind an injected stand-in.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const slots = require('../../src/instance-slot');
const { HEARTBEAT_FILE: HEARTBEAT } = require('../../src/sidecar');
const { freshenAccountLimits } = require('../../src/account-limits');

const T5 = 1_783_101_000; // shared 5h reset instant
const TW = 1_783_616_400; // shared weekly reset instant

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineInstanceSlotsSteps(reg) {
  /** A temp home, removed when the scenario ends — pass or fail. */
  const home = (/** @type {Record<string, any>} */ w) => {
    if (!w.home) {
      w.home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-slots-'));
      w.env = {};
      w.defer(() => fs.rmSync(w.home, { recursive: true, force: true }));
    }
    return w.home;
  };

  const dirOf = (/** @type {Record<string, any>} */ w, /** @type {number} */ n) =>
    slots.slotPaths(n, home(w)).stateDir;

  /** Age a file by rewriting its mtime — cheaper and steadier than sleeping. */
  const age = (/** @type {string} */ file, /** @type {number} */ ms) => {
    const t = (Date.now() - ms) / 1000;
    fs.utimesSync(file, t, t);
  };

  /** Write <dir>/<name>, creating the dir. Returns the path. */
  const put = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ body = '') => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  /** A live instance: this test process owns the slot, and its sidebar beats. */
  const makeLive = (/** @type {string} */ dir) => {
    put(dir, slots.OWNER_FILE, `${process.pid}:${Date.now()}`);
    put(dir, HEARTBEAT, `${process.pid}:${Date.now()}`);
  };

  // A pid that is certainly not running. Claimed by nothing, so a slot recorded
  // to it always reads free.
  const DEAD_PID = 0x7ffffff0;

  // --- Given: what is already running ---

  reg.define(/^no ccr instance is running$/, (w) => { home(w); });

  reg.define(/^a live session holds slot (\d+)$/, (w, n) => { makeLive(dirOf(w, Number(n))); });

  reg.define(/^every slot is held by a live session$/, (w) => {
    for (let n = 1; n <= slots.MAX_SLOTS; n++) makeLive(dirOf(w, n));
  });

  reg.define(/^a sidebar is attached to slot (\d+) but its session has ended$/, (w, n) => {
    // The session is over — its launcher is gone and it left the sentinel behind
    // (launch.sh writes that on exit; only the NEXT launch clears it). What is
    // still up is the sidebar, beating, waiting to be reused.
    const dir = dirOf(w, Number(n));
    put(dir, slots.OWNER_FILE, `${DEAD_PID}:1`);
    put(dir, HEARTBEAT, `4242:${Date.now()}`);
    put(dir, 'exited');
    w.beat = { dir, nonce: fs.readFileSync(path.join(dir, HEARTBEAT), 'utf8') };
  });

  reg.define(/^its sidebar has been closed$/, (w) => {
    // clearHeartbeat removes the file outright on a clean sidebar exit; a killed
    // pane leaves it to go stale. Either way the SESSION is still running.
    fs.rmSync(path.join(dirOf(w, 1), HEARTBEAT), { force: true });
  });

  reg.define(/^slot (\d+) has a beating sidebar and no launcher$/, (w, n) => {
    const dir = dirOf(w, Number(n));
    put(dir, HEARTBEAT, `${process.pid}:${Date.now()}`);
  });

  reg.define(/^slot (\d+) was left by an instance that is no longer running$/, (w, n) => {
    const dir = dirOf(w, Number(n));
    // Both records outlive their writer: a dead pid, and a heartbeat gone stale.
    put(dir, slots.OWNER_FILE, `${DEAD_PID}:1`);
    age(put(dir, HEARTBEAT, '1234:1'), 60_000);
  });

  reg.define(/^another launcher holds slot (\d+) and its sidebar has not started$/, (w, n) => {
    // Exactly what defaultReserve leaves behind — and nothing else.
    put(dirOf(w, Number(n)), slots.OWNER_FILE, `${process.pid}:${Date.now()}`);
  });

  reg.define(/^slot (\d+)'s directory has been replaced with a symlink$/, (w, n) => {
    const victim = path.join(home(w), 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.chmodSync(victim, 0o755);
    fs.mkdirSync(path.join(home(w), '.ccr'), { recursive: true });
    fs.symlinkSync(victim, dirOf(w, Number(n)));
    w.victim = victim;
  });

  reg.define(/^CCR_STATE_DIR names a directory of the user's choosing$/, (w) => {
    home(w);
    w.env.CCR_STATE_DIR = path.join(w.home, 'somewhere-else');
  });

  reg.define(/^CCR_SESSION names a session of the user's choosing$/, (w) => {
    home(w);
    w.env.CCR_SESSION = 'my-session';
  });

  // --- When: the allocation ---

  reg.define(/^a bare ccr picks its namespace$/, (w) => {
    w.slot = slots.allocateSlot({ env: w.env, home: home(w) });
  });

  reg.define(/^ccr picks its namespace for CCS profile "([^"]+)"$/, (w, profile) => {
    w.slot = slots.allocateSlot({ profile, env: w.env, home: home(w) });
  });

  reg.define(/^two launchers pick a namespace against the same free slot$/, (w) => {
    // Both launchers inspect BEFORE either reserves — the interleaving two
    // sequential allocateSlot calls cannot produce, and precisely the one that
    // used to put two instances on one state dir when an `exited` sentinel was
    // lying around. Only the exclusive create separates them now.
    /** @type {Record<number, {live: boolean, attached: boolean}>} */
    const verdict = {};
    for (let n = 1; n <= 3; n++) verdict[n] = slots.defaultInspect(dirOf(w, n));

    /** Finish one launcher's probe from the verdicts it already holds. */
    const finish = () => {
      for (let n = 1; n <= 3; n++) {
        if (verdict[n].live) continue;
        const dir = dirOf(w, n);
        fs.mkdirSync(dir, { recursive: true });
        if (!slots.defaultReserve(dir)) continue; // the other launcher got there first
        return { ...slots.slotPaths(n, home(w)), attached: verdict[n].attached };
      }
      return null;
    };
    w.first = finish();
    w.second = finish();
  });

  // --- Then: which namespace came back ---

  reg.define(/^it takes slot (\d+)$/, (w, n) => {
    assert.ok(w.slot, 'expected a slot to be assigned');
    assert.strictEqual(w.slot.slot, Number(n));
  });

  reg.define(/^no slot is assigned$/, (w) => {
    assert.strictEqual(w.slot, null, 'expected the caller to keep its own namespace');
  });

  reg.define(/^the launch is refused$/, (w) => {
    assert.deepStrictEqual(w.slot, { exhausted: true }, 'expected an explicit refusal, not a fallback');
  });

  reg.define(/^its state dir is the slot (\d+) directory$/, (w, n) => {
    assert.strictEqual(w.slot.stateDir, path.join(w.home, '.ccr', 'instances', String(n)));
  });

  reg.define(/^its session name is "([^"]+)"$/, (w, name) => {
    assert.strictEqual(w.slot.session, name);
  });

  reg.define(/^they take different slots$/, (w) => {
    assert.ok(w.first && w.second, 'both launchers should get a namespace');
    assert.notStrictEqual(w.first.slot, w.second.slot);
    assert.notStrictEqual(w.first.stateDir, w.second.stateDir);
  });

  reg.define(/^one of them takes slot (\d+)$/, (w, n) => {
    assert.ok([w.first.slot, w.second.slot].includes(Number(n)));
  });

  reg.define(/^the attached sidebar's heartbeat is untouched$/, (w) => {
    assert.strictEqual(
      fs.readFileSync(path.join(w.beat.dir, HEARTBEAT), 'utf8'), w.beat.nonce,
      'a newer nonce here would make the live sidebar stand down',
    );
  });

  reg.define(/^the caller is told a sidebar is already attached$/, (w) => {
    assert.strictEqual(w.slot.attached, true);
  });

  reg.define(/^the symlink's target is untouched$/, (w) => {
    assert.deepStrictEqual(fs.readdirSync(w.victim), [], 'nothing was written into the victim directory');
    // POSIX only: Windows has no mode bits — chmod there toggles read-only and
    // stat reads back a synthetic 0666, so the assertion would fail for a
    // filesystem reason, not a ccr one. The readdir above holds everywhere.
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(w.victim).mode & 0o777, 0o755, 'the victim was not chmodded to 0700');
    }
  });

  // --- The tmux launcher's existing seam ---

  reg.define(/^the tmux launcher script scripts\/launch\.sh$/, (w) => {
    w.launchSh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'launch.sh'), 'utf8');
  });
  reg.define(/^it resolves a bare launch$/, () => {});
  reg.define(/^it takes the session name from CCR_SESSION$/, (w) => {
    assert.match(w.launchSh, /SESSION="\$\{CCR_SESSION:-ccr\}"/, 'bare branch reads CCR_SESSION');
  });
  reg.define(/^it takes the state dir from CCR_STATE_DIR$/, (w) => {
    assert.match(w.launchSh, /STATE="\$\{CCR_STATE_DIR:-\$HOME\/\.ccr\/instances\/1\}"/, 'launcher reads CCR_STATE_DIR');
  });
  reg.define(/^the tmux socket name follows the session name$/, (w) => {
    assert.match(w.launchSh, /SOCKET="\$SESSION"/, 'socket derives from the session name');
  });

  // --- Account-wide meters across slots ---

  /** A same-account rate_limits snapshot on disk. */
  const snapshot = (/** @type {string} */ dir, /** @type {number} */ five) => {
    put(dir, 'last-status.json', JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: T5 },
        seven_day: { used_percentage: 18, resets_at: TW },
      },
    }));
  };

  reg.define(/^slot (\d+) last captured 5h at (\d+)%$/, (w, n, five) => {
    w.localDir = dirOf(w, Number(n));
    snapshot(w.localDir, Number(five));
    w.localRl = JSON.parse(fs.readFileSync(path.join(w.localDir, 'last-status.json'), 'utf8')).rate_limits;
  });

  reg.define(/^slot (\d+) on the same account shows 5h at (\d+)%$/, (w, n, five) => {
    snapshot(dirOf(w, Number(n)), Number(five));
  });

  reg.define(/^slot (\d+)'s meters are reconciled from disk$/, (w) => {
    w.merged = freshenAccountLimits(w.localRl, w.localDir, { home: home(w) });
  });

  reg.define(/^slot (\d+)'s 5h meter reads (\d+)%$/, (w, _n, pct) => {
    assert.strictEqual(w.merged.five_hour.used_percentage, Number(pct));
  });
};
