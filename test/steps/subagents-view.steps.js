// @ts-check
'use strict';
// Step definitions for features/subagents-view.feature.
//
// This feature's subject is a PANE, so every step draws one: a sandbox HOME
// holding a real `~/.claude/projects` tree in Claude Code's own record shapes
// (test/steps/_subagent-fixture.js), a state dir holding the snapshot
// `ccr statusline` writes, and `composeFrame(stateDir, { view: SUBAGENTS_VIEW })`
// — the same call the draw loop makes. Nothing is stubbed. The transcript path
// travels the production route (snapshot → `currentTranscriptPath`, which is
// what confines it to the projects tree), the roster comes from
// `updateRoster`/`rosterView` in src/subagents.js, and the rotation scenarios
// cycle through the REAL request file the host's key writes plus the real tick
// that consumes it (src/cycle-view.js + sidecar.frame), which is the pair an
// adversarial review once found disconnected with the suite green.
//
// THREE THINGS ABOUT THE WORLD ARE PINNED, all because the scenarios say
// nothing about them and the developer's own machine otherwise would:
//
//   - HOME/USERPROFILE, because `projectsDir()` resolves under the home and
//     these scenarios must never read (or be affected by) the real ~/.claude.
//   - the external-pane list, pinned empty through CCR_CONFIG so a pane
//     configured in ~/.config/ccr/config.json cannot lengthen the cycle the
//     rotation scenarios count presses against. Pinned through the production
//     config reader rather than the `panes` option, so the reader stays in the
//     path being exercised — and the one scenario that WANTS an optional view
//     configures it the same way.
//   - the pane width and height, passed explicitly. `frame` normally takes both
//     from process.stdout, which is the terminal running the suite; a narrow
//     one would clamp rows and fail these scenarios for a reason that has
//     nothing to do with the roster. The height matters twice over: it IS the
//     slot count (src/render/subagents.js `slotsForRows`), so the scenarios
//     that say "4 roster slots" pin the height that yields four and check it
//     against the production rule rather than restating the number.
//
// TIME IS INJECTED EVERYWHERE. Ages, retirement and staleness are all `now`
// minus an upstream timestamp, so a "redraw" here is a compose with a later
// `now` and nothing in this file waits on a clock.
//
// MUTATION LOG — 44 mutants, each applied to the PRODUCTION source, run, and
// reverted. Recorded because a binding no world can make red is hollow. The
// scenario each one turned red is named after the arrow; the two that stayed
// GREEN are at the bottom, and both were findings about this file.
//
//   src/render/subagents.js
//     token column removed from the head row      -> A glance at a working fan-out
//     age removed from the head row               -> A glance at a working fan-out
//     words branch skipped (tool call always)     -> the glance, all three outline
//                                                    rows, freeze, recovery, and
//                                                    both @security scenarios
//     words age marker dropped                    -> all three outline rows
//     words age formatted in seconds (fmtSilence) -> outline row 0m ("0s")
//     a block drawn under the "no subagents" line -> the empty view (and
//                                                    subagent-channels' drift
//                                                    scenario, now rebound here)
//     the "no subagents" line emptied             -> the empty view, the resumed
//                                                    session, the drift scenario
//     task column cut to 12 columns               -> the glance, the task column
//     task column reversed (tail, not head)       -> the task column, the huge prompt
//     task column wrapped onto a second row       -> the huge prompt
//     tool fallback drops its argument            -> the wordless agent
//     quiet placeholder replaced by the task      -> the quiet agent
//     overflow line removed                       -> the burst, the overflow names
//     overflow names only the first type          -> the overflow names
//     overflow drops its `×N` repeat counts       -> the overflow names
//     stale marker stops stating a duration       -> the stale view
//     stale words blanked instead of frozen       -> the freeze (and four more)
//     failure text replaced by a bare "failed"    -> the crashed agent
//     the failed glyph made equal to the done one -> the crashed agent
//     lineage prefix never applied (depth forced) -> the nested block's prefix
//     words masked when they look like a key      -> verbatim secrets
//     `text()` throws on an OSC-looking word      -> escape sequences (both Thens:
//                                                    the inert text AND the redraw)
//
//   src/subagents.js
//     task taken from the dispatch `description`  -> the glance, the task column,
//                                                    the huge prompt, the empty one
//     empty prompt falls back to `description`    -> the empty dispatch
//     a `thinking` block counted as words         -> the wordless agent
//     slots filled finished-first                 -> the burst, the leftover slots
//     finishes sorted oldest-first                -> the leftover slots
//     RETIRE_MS raised to an hour                 -> the retirement
//     RETIRE_MS raised to ten days                -> the retirement, the resumed session
//     retirement keyed to observation time        -> the retirement, the resumed session
//     a null completedAt retired on ccr's clock   -> the finish with no timestamp
//     an unknown <status> read as done            -> the crashed agent
//     STALE_MS raised to five minutes             -> the stale view, freeze, recovery
//     the silence clock frozen at first reading   -> the stale view, the recovery
//     nested agents collapsed into their parent   -> the nested block
//     the agents dir found by scanning, not
//       derived from the confined transcript path -> one tab, another tab's agents
//     the tail never advanced after the first tick-> the new spawn (and every
//                                                    scenario that redraws)
//
//   src/sanitize.js
//     stripControl made the identity function     -> escape sequences (and the git
//                                                    pane's and pane-blob's own
//                                                    hostile-text scenarios)
//
//   src/sidecar.js
//     the exit sentinel checked after the roster  -> the dead session
//     the feed moved after the subagent roster    -> the fourth position, the
//                                                    optional view's placement
//     external panes indexed from 2 again         -> the optional view
//     BUILTIN_VIEWS put back to 2                 -> the optional view (and every
//                                                    pane-blobs position scenario)
//     the roster view bumps the cycle counter
//       as it draws                               -> "nothing was pressed to
//                                                    remove it"
//
// TWO MUTANTS SURVIVED FIRST TIME, and both were findings about this file:
//
//   - "the task column is Claude's description, not its prompt" stayed GREEN on
//     the glance scenario, because that fixture's `description` QUOTED the
//     prompt ("dispatch note for map auth flow"), so reading the wrong field
//     still satisfied `body.includes(task)`. The description now says something
//     else entirely, and the mutant fails on all four task scenarios.
//   - "the roster tail is not reset on a session switch" stayed GREEN on "One
//     tab never shows another tab's agents", because the step rendered the
//     SUBJECT first: the leak can only reach a pane drawn after another tab's,
//     and the subject was the first thing drawn since the state was cleared.
//     The siblings now render first and the tab under test renders last; the
//     mutant then fails on the subject's own blocks.
//
// Two more were caught while the fixtures were being written rather than by a
// deliberate mutant, and are recorded because they are the same class of
// finding: the burst scenario originally had NO finished agents, so nothing
// could displace anything and a finished-first slotting rule passed; and the
// no-timestamp scenario originally redrew only sixty seconds out, which a
// retirement mutant survived. The burst now competes against three finishes,
// and that scenario redraws a day out.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeFrame, frame, __resetViewState } = require('../../src/sidecar');
const { cycleView, readViewRequests } = require('../../src/cycle-view');
const { allocateSlot } = require('../../src/instance-slot');
const { recordLaunchDir } = require('../../src/state-dir');
const { __resetRosterState } = require('../../src/subagents');
const { slotsForRows } = require('../../src/render/subagents');
const { buildSession } = require('./_subagent-fixture');
const { refuteWithControl } = require('./_absence');

const ROOT = path.join(__dirname, '..', '..');

/** Visible text: SGR colour runs are ccr's own and never the subject of a claim. */
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The view index the subagent roster occupies (economy 0, git 1, feed 2). */
const SUBAGENTS_VIEW = 3;

/**
 * A fixed instant. Every age, retirement clock and staleness window below is
 * measured from it, so nothing in this file depends on when the suite runs.
 */
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

/** Wide enough that no fixture string is ever shortened by accident. */
const COLS = 72;

/**
 * A tall pane, for the scenarios that say nothing about slots. Its slot count
 * is far above any of their rosters, so nothing is silently cut.
 */
const ROWS = 40;

/**
 * The height whose slot count is the FOUR the burst scenarios name. Checked
 * against the production rule at every use rather than trusted: if the block
 * layout ever changes, those scenarios must fail here rather than quietly
 * measuring a different cap than the one they describe.
 */
const ROWS_4 = 12;

/** A head row: two spaces, an optional lineage prefix, a state glyph. */
const HEAD_RE = /^ {2}(└ )?([●✓✗]) (.*?) {2,}(\S+) {2}(\S+)$/;

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineSubagentsViewSteps(reg) {
  // ── The world ─────────────────────────────────────────────────────────────

  /**
   * A sandbox home laid out the way a real one is: `~/.claude/projects` for the
   * transcripts and `~/.ccr` for the instances. HOME and USERPROFILE are both
   * set because `projectsDir()` goes through `os.homedir()`, which reads the
   * platform's own variable.
   *
   * The module-level roster tail and view index are process-global by design
   * (src/subagents.js and src/sidecar.js both say so at their declarations), so
   * both are reset on the way in AND on the way out.
   */
  const world = (/** @type {Record<string, any>} */ w) => {
    if (w.home) return w;
    w.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-sav-'));
    w.home = path.join(w.root, 'home');
    w.projects = path.join(w.home, '.claude', 'projects');
    fs.mkdirSync(w.projects, { recursive: true });
    w.defer(() => fs.rmSync(w.root, { recursive: true, force: true }));

    for (const key of ['HOME', 'USERPROFILE']) {
      const prev = process.env[key];
      process.env[key] = w.home;
      w.defer(() => { if (prev == null) delete process.env[key]; else process.env[key] = prev; });
    }

    w.configFile = path.join(w.root, 'config.json');
    fs.writeFileSync(w.configFile, JSON.stringify({ panes: [] }));
    const prevCfg = process.env.CCR_CONFIG;
    process.env.CCR_CONFIG = w.configFile;
    w.defer(() => { if (prevCfg == null) delete process.env.CCR_CONFIG; else process.env.CCR_CONFIG = prevCfg; });

    __resetRosterState();
    __resetViewState();
    w.defer(() => { __resetRosterState(); __resetViewState(); });

    w.sidCount = 0;
    w.now = T0;
    return w;
  };

  /** A fresh session tree plus the state dir whose snapshot points at it. */
  const newSession = (/** @type {Record<string, any>} */ w, /** @type {string} */ tag) => {
    world(w);
    w.sidCount += 1;
    const sid = `${String(w.sidCount).padStart(8, '0')}-0000-4000-8000-000000000001`;
    const s = buildSession(w.projects, { sid, slug: `-tmp-${tag}` });
    const stateDir = fs.mkdtempSync(path.join(w.root, `state-${tag}-`));
    writeStatus(stateDir, s.transcript);
    return { s, stateDir };
  };

  /**
   * The snapshot `ccr statusline` leaves behind. `transcript_path` is the field
   * this whole feature hangs on — `currentTranscriptPath` confines it to the
   * projects tree and src/subagents.js derives the agents directory from the
   * CONFINED path — and the rate-limit/context fields are there so the economy
   * panel has meters to draw, which is how the rotation scenarios tell the
   * economy view apart from an error line.
   */
  function writeStatus(/** @type {string} */ stateDir, /** @type {string} */ transcript, dir = ROOT) {
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(stateDir, 'last-status.json'), JSON.stringify({
      model: { display_name: 'Opus 5' },
      transcript_path: transcript,
      workspace: { current_dir: dir, project_dir: dir },
      cwd: dir,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: nowSec + 3 * 3600 },
        seven_day: { used_percentage: 18, resets_at: nowSec + 4 * 86400 },
      },
      context_window: { context_window_size: 1000000, total_input_tokens: 120000 },
      cost: { total_cost_usd: 3.25, total_duration_ms: 45 * 60 * 1000 },
    }));
  }

  /** One redraw of the roster, through the production compose call. */
  const draw = (/** @type {Record<string, any>} */ w, /** @type {{ now?: number, rows?: number, cols?: number, stateDir?: string }} */ o = {}) => {
    const out = plain(composeFrame(o.stateDir || w.stateDir, {
      now: o.now != null ? o.now : w.now,
      view: SUBAGENTS_VIEW,
      cols: o.cols || w.cols || COLS,
      rows: o.rows || w.rows || ROWS,
    }));
    w.frame = out;
    return out;
  };

  /** The frame's block rows, as `{ head, activity }` pairs of plain lines. */
  const blocks = (/** @type {string} */ f) => {
    const lines = f.split('\n');
    /** @type {{ head: string, activity: string, parts: RegExpExecArray|null }[]} */
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const parts = HEAD_RE.exec(lines[i]);
      if (parts) out.push({ head: lines[i], activity: lines[i + 1] || '', parts });
    }
    return out;
  };

  /** The block whose head row names `needle`, for a per-agent assertion. */
  const blockNaming = (/** @type {string} */ f, /** @type {string} */ needle) =>
    blocks(f).find((b) => b.head.includes(needle));

  /** The overflow line, which is the only line beginning with a `+`. */
  const overflowLine = (/** @type {string} */ f) =>
    f.split('\n').map((l) => l.trim()).find((l) => /^\+\d+ more\b/.test(l)) || '';

  /**
   * A usage block worth exactly `n` tokens under the derivation's formula
   * (`input + output + cache_creation`, documented in docs/SUBAGENTS.md). All of
   * it goes in `output_tokens` so the fixture states one number rather than an
   * arithmetic puzzle, and the cache READ figure is non-zero on purpose: it must
   * stay out of the total.
   */
  const usage = (/** @type {number} */ n) => ({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40000,
    output_tokens: n,
  });

  // Two INDEPENDENT counters. A single one looked fine and was not: argument
  // order meant `spawn({ toolUseId: toolUseId(), agentId: agentId() })` read the
  // counter before bumping it, so a dispatch id could repeat the previous
  // agent's — which merges two agents into one row and made the nested and
  // leftover-slot scenarios quietly measure the wrong roster.
  let agentSeq = 0;
  let dispatchSeq = 0;
  const agentId = () => `a${String(++agentSeq).padStart(16, '0')}`;
  const toolUseId = () => `toolu_01${String(++dispatchSeq).padStart(14, '0')}`;

  /** "3m12s", "31s", "4m" — the vocabulary the scenarios use for an age. */
  const parseAge = (/** @type {string} */ s) => {
    const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
    assert.ok(m && (m[1] || m[2]), `this file cannot read the age "${s}"`);
    return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
  };

  // ── Givens: worlds made of Claude Code's own records ──────────────────────

  reg.define(
    /^an? ([\w-]+) agent spawned (\S+) ago with task "([^"]+)" holding (\d+) tokens whose latest words were "([^"]+)"$/,
    (w, type, ago, task, tokens, words) => {
      if (!w.s) { const made = newSession(w, 'glance'); w.s = made.s; w.stateDir = made.stateDir; }
      w.now = T0;
      const id = agentId();
      const at = w.now - parseAge(String(ago));
      // The description says something ELSE on purpose: R10 puts Claude's own
      // dispatch PROMPT in the task column, and a description that quoted the
      // prompt would let a build reading the wrong field pass (it did, until
      // mutation-testing swapped the two fields and this stayed green).
      w.s.spawn({ toolUseId: toolUseId(), agentId: id, at, subagentType: String(type), prompt: String(task), description: 'a one-line summary nobody asked for' });
      // Two seconds after the spawn: late enough to be the agent's own words,
      // early enough that the newest of these fixtures leaves the transcript
      // less than STALE_MS quiet — a stale banner here would be correct and
      // would say nothing about the facts this scenario is checking.
      w.s.agentTurn({ agentId: id, at: at + 2000, blocks: [{ type: 'text', text: String(words) }], usage: usage(Number(tokens)) });
      (w.expected = w.expected || []).push({ type: String(type), task: String(task), tokens: Number(tokens), words: String(words), ageMs: parseAge(String(ago)) });
    },
  );

  reg.define(/^the session has spawned no subagents$/, (w) => {
    const made = newSession(w, 'empty');
    w.s = made.s; w.stateDir = made.stateDir;
    // A REAL transcript with real turns in it, so "no subagents" is a statement
    // about a session ccr can read rather than about an empty file.
    w.s.raw([
      JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'fix the tests' } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }),
    ]);
    w.now = T0 + 5000;
  });

  reg.define(/^the subagents view is showing (\d+) live agents?$/, (w, n) => {
    const made = newSession(w, 'live');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 10_000;
    for (let i = 0; i < Number(n); i += 1) {
      const id = agentId();
      w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0 + i * 100, subagentType: 'explore', prompt: `task-${i}`, description: `d${i}` });
      w.s.agentTurn({ agentId: id, at: T0 + 2000 + i * 100, blocks: [{ type: 'text', text: `working on ${i}` }] });
    }
    // The premise, checked rather than assumed: a Given that merely built files
    // would leave the When measuring from an unknown place.
    assert.strictEqual(blocks(draw(w)).length, Number(n),
      `the view should open showing ${n} live agent(s); got:\n${w.frame}`);
  });

  reg.define(/^Claude dispatched an agent with the prompt "([^"]+)"$/, (w, prompt) => {
    const made = newSession(w, 'prompt');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 5000;
    w.agentType = 'general-purpose';
    // The `description` differs from the prompt deliberately: R10 says the task
    // column is Claude's own DISPATCH WORDS, and a build that reached for
    // `description` instead is the exact confusion this scenario rules out.
    w.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0, subagentType: w.agentType, prompt: String(prompt), description: 'short summary nobody asked for' });
    w.expectedTask = String(prompt);
  });

  reg.define(/^Claude dispatched an agent with a prompt (\d+) characters long beginning "([^"]+)"$/, (w, chars, head) => {
    const made = newSession(w, 'huge');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 5000;
    // Non-repeating filler, so the prompt's TAIL is a string that can be looked
    // for and cannot appear by coincidence in a head-first truncation.
    let prompt = `${head} `;
    for (let i = 0; prompt.length < Number(chars); i += 1) prompt += `token-${i} `;
    w.prompt = prompt.slice(0, Number(chars));
    w.promptHead = String(head);
    w.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0, subagentType: 'explore', prompt: w.prompt, description: 'audit' });
  });

  reg.define(/^Claude dispatched an agent with no prompt text$/, (w) => {
    const made = newSession(w, 'noprompt');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 5000;
    w.agentType = 'general-purpose';
    w.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0, subagentType: w.agentType, prompt: '', description: 'a description that must not stand in for a prompt' });
  });

  reg.define(/^an explore agent whose latest words arrived (\S+) ago$/, (w, ago) => {
    const made = newSession(w, 'aged');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 3_600_000;
    const at = w.now - parseAge(String(ago));
    const id = agentId();
    w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: at - 60_000, subagentType: 'explore', prompt: 'map auth flow', description: 'map' });
    w.words = 'grepping src/auth';
    w.s.agentTurn({ agentId: id, at, blocks: [{ type: 'text', text: w.words }] });
  });

  reg.define(/^an agent (\d+) seconds old that has made a (\w+) call but written no words$/, (w, secs, tool) => {
    const made = newSession(w, 'wordless');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 60_000;
    const id = agentId();
    const at = w.now - Number(secs) * 1000;
    w.s.spawn({ toolUseId: toolUseId(), agentId: id, at, subagentType: 'general-purpose', prompt: 'fix failing tests', description: 'fix' });
    w.toolName = String(tool);
    w.toolArg = 'npm test';
    // A THINKING block beside the tool call, because the catalogue rules that
    // thinking is not words (docs/SUBAGENTS.md). It is the witness for the
    // refusal below: a ladder that mistook thinking for words would spill this
    // sentence onto the activity line.
    w.thinking = 'I should probably grep the auth module before anything else';
    w.s.agentTurn({
      agentId: id,
      at: at + 1000,
      blocks: [
        { type: 'thinking', thinking: w.thinking },
        { type: 'tool_use', id: 'toolu_bash01', name: w.toolName, input: { command: w.toolArg } },
      ],
    });
    // The agent's own transcript, as the witness for "no words are invented":
    // the thinking really is in the channel ccr read, so a ladder that promoted
    // it would have had it to promote.
    w.agentFileText = fs.readFileSync(path.join(w.s.subagents, `agent-${id}.jsonl`), 'utf8');
  });

  reg.define(/^an agent (\d+) seconds old that has produced nothing observable yet$/, (w, secs) => {
    const made = newSession(w, 'quiet');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 60_000;
    const at = w.now - Number(secs) * 1000;
    // Dispatch and launch only: the agent exists and has said nothing at all.
    w.s.dispatch({ toolUseId: 'toolu_quiet0000000', at, subagentType: 'explore', prompt: 'map auth flow', description: 'map' });
    w.s.asyncLaunch({ toolUseId: 'toolu_quiet0000000', agentId: agentId(), at: at + 100 });
  });

  reg.define(/^the roster is filled to its slot count with live agents$/, (w) => {
    const made = newSession(w, 'burst');
    w.s = made.s; w.stateDir = made.stateDir;
    w.rows = ROWS_4;
    w.now = T0 + 600_000;
    w.slots = slotsForRows(ROWS_4);
    // Finished agents in the same session, so "never evicts a live worker" has
    // something that COULD do the evicting. Without them the scenario is true
    // of any slotting rule at all (mutation-testing caught exactly that).
    w.finishedTasks = [];
    for (let i = 0; i < 3; i += 1) {
      const id = agentId(); const tuid = toolUseId();
      const task = `finished-${i}`;
      w.finishedTasks.push(task);
      w.s.spawn({ toolUseId: tuid, agentId: id, at: T0 + i, subagentType: 'review', prompt: task, description: task });
      w.s.notify({ toolUseId: tuid, taskId: id, at: w.now - 5_000 - i });
    }
    w.live = 0;
    const addLive = () => {
      const id = agentId();
      w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0 + 1000 + w.live * 10, subagentType: 'explore', prompt: `live-${w.live}`, description: 'live' });
      w.live += 1;
    };
    for (let i = 0; i < w.slots; i += 1) addLive();
    w.addLive = addLive;
    assert.strictEqual(blocks(draw(w)).length, w.slots,
      `the roster should open full at ${w.slots} slots; got:\n${w.frame}`);
  });

  reg.define(/^the session holds (\d+) live subagents and the roster shows (\d+) of them$/, (w, total, shown) => {
    const made = newSession(w, 'overflow');
    w.s = made.s; w.stateDir = made.stateDir;
    w.rows = ROWS_4;
    w.cols = 44;
    w.now = T0 + 600_000;
    // The scenario names four slots; the pane's height is what produces them.
    // Tied to the production rule so a changed block layout fails here rather
    // than leaving this scenario quietly measuring a different cap.
    assert.strictEqual(slotsForRows(ROWS_4), Number(shown),
      `a ${ROWS_4}-row pane must fit the ${shown} slots this scenario names`);
    w.slots = Number(shown);
    w.total = Number(total);
    w.spawnLive = (/** @type {string} */ type, /** @type {number} */ i) => {
      w.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0 + 1000 + i * 10, subagentType: type, prompt: `${type}-${i}`, description: type });
    };
    for (let i = 0; i < w.slots; i += 1) w.spawnLive('general-purpose', i);
  });

  reg.define(/^the agents just beyond the slots are named ([\w, ]+) and (\w+)$/, (w, names, last) => {
    const beyond = String(names).split(',').map((s) => s.trim()).filter(Boolean).concat(String(last));
    w.beyond = beyond;
    beyond.forEach((type, i) => w.spawnLive(type, w.slots + i));
    // The rest of the hundred, so the count the overflow line reports is the
    // session's and not this list's.
    for (let i = w.slots + beyond.length; i < w.total; i += 1) w.spawnLive('general-purpose', i);
  });

  reg.define(/^(\d+) live agents and (\d+) finished agents compete for (\d+) roster slots$/, (w, live, finished, slots) => {
    const made = newSession(w, 'leftover');
    w.s = made.s; w.stateDir = made.stateDir;
    w.rows = ROWS_4;
    w.now = T0 + 600_000;
    assert.strictEqual(slotsForRows(ROWS_4), Number(slots),
      `a ${ROWS_4}-row pane must fit the ${slots} slots this scenario names`);
    w.slots = Number(slots);
    w.liveTasks = [];
    for (let i = 0; i < Number(live); i += 1) {
      const task = `live-${i}`;
      w.liveTasks.push(task);
      w.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0 + i, subagentType: 'explore', prompt: task, description: task });
    }
    // Finished, newest LAST, each stamped inside the retirement window so the
    // ordering rule is what decides which two show and not the clock.
    w.finishedTasks = [];
    for (let i = 0; i < Number(finished); i += 1) {
      const id = agentId(); const tuid = toolUseId();
      const task = `done-${i}`;
      w.finishedTasks.push(task);
      w.s.spawn({ toolUseId: tuid, agentId: id, at: T0 + 100 + i, subagentType: 'review', prompt: task, description: task });
      w.s.notify({ toolUseId: tuid, taskId: id, at: w.now - 50_000 + i * 1000 });
    }
  });

  reg.define(/^a finished agent showing in the roster whose completion Claude stamped (\d+) seconds ago$/, (w, secs) => {
    const made = newSession(w, 'retire');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 600_000;
    const id = agentId(); const tuid = toolUseId();
    w.retiringTask = 'audit the installer';
    w.completedAt = w.now - Number(secs) * 1000;
    w.s.spawn({ toolUseId: tuid, agentId: id, at: w.completedAt - 120_000, subagentType: 'review', prompt: w.retiringTask, description: 'audit' });
    w.s.notify({ toolUseId: tuid, taskId: id, at: w.completedAt });
    // "Showing in the roster" is a fact to establish, not to assume: rendered a
    // little before the retirement clock expires, the block is really there.
    const before = draw(w, { now: w.completedAt + 50_000 });
    assert.ok(blockNaming(before, w.retiringTask),
      `the finished block must be showing before the retirement clock expires:\n${before}`);
    w.pressesBefore = readViewRequests(w.stateDir);
    w.dirBefore = fs.readdirSync(w.stateDir).sort().join(',');
  });

  reg.define(/^a finished agent showing in the roster whose completion carries no timestamp$/, (w) => {
    const made = newSession(w, 'nostamp');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 600_000;
    const id = agentId(); const tuid = toolUseId();
    w.stayingTask = 'migrate the settings file';
    w.s.spawn({ toolUseId: tuid, agentId: id, at: T0, subagentType: 'general-purpose', prompt: w.stayingTask, description: 'migrate' });
    // R37: a completion Claude stamped with nothing never retires — ccr has no
    // clock of its own to retire it on without inventing one.
    w.s.notify({ toolUseId: tuid, taskId: id, at: null });
    assert.ok(blockNaming(draw(w), w.stayingTask),
      `the finished block must be showing to begin with:\n${w.frame}`);
  });

  reg.define(/^a resumed session whose transcript holds completions stamped days ago$/, (w) => {
    const made = newSession(w, 'resumed');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0;
    w.ancientTasks = [];
    for (let i = 0; i < 3; i += 1) {
      const id = agentId(); const tuid = toolUseId();
      const task = `ancient-${i}`;
      w.ancientTasks.push(task);
      const at = T0 - (3 + i) * 86_400_000;
      w.s.spawn({ toolUseId: tuid, agentId: id, at, subagentType: 'explore', prompt: task, description: task });
      w.s.notify({ toolUseId: tuid, taskId: id, at: at + 60_000 });
    }
    w.transcriptText = fs.readFileSync(w.s.transcript, 'utf8');
  });

  reg.define(/^an agent whose death Claude recorded as a rate-limit failure saying "([^"]+)"$/, (w, why) => {
    const made = newSession(w, 'failed');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 60_000;
    w.failureText = String(why);
    const id = agentId(); const tuid = toolUseId();
    w.failedTask = 'summarise the release notes';
    w.s.spawn({ toolUseId: tuid, agentId: id, at: T0, subagentType: 'general-purpose', prompt: w.failedTask, description: 'summarise' });
    w.s.notify({ toolUseId: tuid, taskId: id, at: w.now - 5_000, status: 'error', summary: w.failureText });
    // A SUCCESSFUL finish beside it, so the done glyph really is rendered
    // somewhere in this frame — that block is the witness for the refusal that
    // the failed one does not carry it.
    const okId = agentId(); const okTuid = toolUseId();
    w.doneTask = 'tidy the changelog';
    w.s.spawn({ toolUseId: okTuid, agentId: okId, at: T0 + 10, subagentType: 'general-purpose', prompt: w.doneTask, description: 'tidy' });
    w.s.notify({ toolUseId: okTuid, taskId: okId, at: w.now - 4_000 });
  });

  reg.define(/^(\d+) live agents showing and the session alive$/, (w, n) => {
    const made = newSession(w, 'stale');
    w.s = made.s; w.stateDir = made.stateDir;
    w.lastEventAt = T0 + 100_000;
    w.wordsShown = [];
    for (let i = 0; i < Number(n); i += 1) {
      const id = agentId();
      const words = `walking module ${i}`;
      w.wordsShown.push(words);
      w.liveIds = (w.liveIds || []).concat(id);
      w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0 + i * 10, subagentType: 'explore', prompt: `sweep-${i}`, description: 'sweep' });
      w.s.agentTurn({ agentId: id, at: w.lastEventAt - i * 10, blocks: [{ type: 'text', text: words }] });
    }
    // A second into the silence: the roster is full and NOT stale, so the mark
    // the When produces is the mark the silence produced and not one that was
    // there all along. Earned rather than asserted flat — the witness is the
    // SAME world drawn past the threshold, which really does carry the mark, so
    // a renamed marker fails the control instead of making this precondition
    // vacuously true.
    const fresh = draw(w, { now: w.lastEventAt + 1000 });
    assert.strictEqual(blocks(fresh).length, Number(n), `the roster should show ${n} live agents:\n${fresh}`);
    const marked = draw(w, { now: w.lastEventAt + 60_000 });
    refuteWithControl(/stale/, fresh, marked,
      'the roster was already stale a second into the silence, so the When proves nothing');
    w.frame = fresh;
  });

  reg.define(/^the view went stale (\d+) seconds into silence$/, (w, secs) => {
    const made = newSession(w, 'frozen');
    w.s = made.s; w.stateDir = made.stateDir;
    w.lastEventAt = T0 + 100_000;
    w.liveIds = [];
    w.wordsShown = [];
    for (let i = 0; i < 2; i += 1) {
      const id = agentId();
      const words = `walking module ${i}`;
      w.liveIds.push(id);
      w.wordsShown.push(words);
      w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0 + i * 10, subagentType: 'explore', prompt: `sweep-${i}`, description: 'sweep' });
      w.s.agentTurn({ agentId: id, at: w.lastEventAt - i * 10, blocks: [{ type: 'text', text: words }] });
    }
    w.staleAt = w.lastEventAt + Number(secs) * 1000;
    w.staleFrame = draw(w, { now: w.staleAt });
    assert.match(w.staleFrame, /stale/, `the view should be stale ${secs}s into the silence:\n${w.staleFrame}`);
    for (const words of w.wordsShown) {
      assert.ok(w.staleFrame.includes(words), `the stale view should still hold "${words}":\n${w.staleFrame}`);
    }
  });

  reg.define(/^an explore agent spawned by another explore agent rather than by the main session$/, (w) => {
    const made = newSession(w, 'nested');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 20_000;
    w.parentId = agentId();
    w.parentTask = 'audit the whole corpus';
    w.s.spawn({ toolUseId: toolUseId(), agentId: w.parentId, at: T0, subagentType: 'explore', prompt: w.parentTask, description: 'audit' });
    w.childTask = 'audit the removed behaviour';
    // `into` puts the child's dispatch inside the PARENT AGENT's own jsonl,
    // which is where a nested dispatch really lives (docs/SUBAGENTS.md).
    w.s.spawn({
      toolUseId: toolUseId(), agentId: agentId(), at: T0 + 5_000,
      subagentType: 'explore', prompt: w.childTask, description: 'audit b',
      parentAgentId: w.parentId, spawnDepth: 2,
    });
  });

  reg.define(/^an agent whose latest words contain terminal escape sequences$/, (w) => {
    const made = newSession(w, 'hostile');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 60_000;
    // Real bytes, not their names: an OSC title-set with its BEL terminator, a
    // CSI colour run, a CSI clear-screen, and a bare DEL. Nothing here is
    // escaped for the fixture's benefit — the transcript would carry exactly
    // these bytes if a fetched page did.
    w.hostile = '\x1b]0;PWNED\x07 \x1b[31mRED\x1b[0m \x1b[2Jcleared \x7f end';
    const id = agentId();
    w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0, subagentType: 'explore', prompt: 'read the page', description: 'read' });
    w.s.agentTurn({ agentId: id, at: w.now - 5_000, blocks: [{ type: 'text', text: w.hostile }] });
  });

  reg.define(/^an agent whose latest words contain "([^"]+)"$/, (w, secret) => {
    const made = newSession(w, 'secret');
    w.s = made.s; w.stateDir = made.stateDir;
    w.now = T0 + 60_000;
    w.secret = String(secret);
    const id = agentId();
    w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0, subagentType: 'explore', prompt: 'read the config', description: 'read' });
    w.s.agentTurn({ agentId: id, at: w.now - 5_000, blocks: [{ type: 'text', text: `found ${w.secret} in the env` }] });
  });

  reg.define(/^(\d+) live ccr instances each with its own fan-out$/, (w, n) => {
    world(w);
    w.now = T0 + 60_000;
    w.instances = [];
    for (let i = 1; i <= Number(n); i += 1) {
      // Namespaces ccr's OWN allocator chose, not directories this file
      // invented and then asserted were different.
      const slot = allocateSlot({ env: {}, home: w.home });
      assert.ok(slot && !('exhausted' in slot), `ccr found no free slot for instance ${i}`);
      w.sidCount += 1;
      const s = buildSession(w.projects, {
        sid: `${String(w.sidCount).padStart(8, '0')}-0000-4000-8000-000000000001`,
        slug: `-tmp-tab${i}`,
      });
      const task = `tab${i}-secret-work`;
      s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0, subagentType: `worker${i}`, prompt: task, description: task });
      writeStatus(slot.stateDir, s.transcript);
      w.instances.push({ n: i, s, task, type: `worker${i}`, stateDir: slot.stateDir });
    }
    const dirs = new Set(w.instances.map((/** @type {any} */ x) => fs.realpathSync(x.stateDir)));
    assert.strictEqual(dirs.size, Number(n),
      `ccr assigned ${dirs.size} distinct directories to ${n} bare launches`);
  });

  /**
   * An instance whose four built-in views can each be told apart POSITIVELY.
   * The repository is real (git's own on-disk format, the same fixture
   * features/git-pane-placement.feature's steps build) and its name and branch
   * are known here, so the git pane is identified by the identity row it draws
   * rather than by being whatever the economy panel is not.
   */
  const cyclingInstance = (/** @type {Record<string, any>} */ w, /** @type {string} */ tag) => {
    world(w);
    const slot = allocateSlot({ env: {}, home: w.home });
    assert.ok(slot && !('exhausted' in slot), 'ccr found no free slot for the instance');
    w.repoName = 'atlas';
    w.repoBranch = 'main';
    const repo = path.join(w.root, 'trees', w.repoName);
    const git = path.join(repo, '.git', 'refs', 'heads');
    fs.mkdirSync(git, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${w.repoBranch}\n`);
    fs.writeFileSync(path.join(git, w.repoBranch), '9749285e1c0a4b2d3f5e6a7b8c9d0e1f2a3b4c5d\n');
    recordLaunchDir(slot.stateDir, repo);
    w.sidCount += 1;
    const s = buildSession(w.projects, { sid: `${String(w.sidCount).padStart(8, '0')}-0000-4000-8000-000000000001`, slug: `-tmp-${tag}` });
    // One agent and one tool call, so the roster and the feed both have
    // something of their own to show and neither is identified by an empty
    // state that any broken view could imitate.
    const id = agentId();
    s.spawn({ toolUseId: toolUseId(), agentId: id, at: T0, subagentType: 'explore', prompt: 'map auth flow', description: 'map' });
    s.raw([JSON.stringify({
      type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(),
      message: { id: 'msg_feed', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_feed01', name: 'Read', input: { file_path: '/tmp/work/auth.js' } }] },
    })]);
    writeStatus(slot.stateDir, s.transcript, repo);
    w.stateDir = slot.stateDir;
    return slot.stateDir;
  };

  reg.define(/^an instance with no external panes configured$/, (w) => {
    cyclingInstance(w, 'cycle');
  });

  reg.define(/^treecontext contributes an optional sidecar view$/, (w) => {
    cyclingInstance(w, 'optional');
    // Configured through the PRODUCTION config reader, with the contract's own
    // golden blob as the pane's payload — an optional view here is exactly what
    // a tool contributes through docs/PANE-CONTRACT.md, and nothing else.
    const blob = path.join(w.root, 'treecontext.json');
    fs.copyFileSync(path.join(ROOT, 'docs', 'pane-blob.golden.json'), blob);
    fs.writeFileSync(w.configFile, JSON.stringify({ panes: [{ path: blob, source: 'treecontext' }] }));
  });

  // ── Whens ─────────────────────────────────────────────────────────────────

  reg.define(/^the sidecar renders the subagents view$/, (w) => { draw(w); });
  reg.define(/^the block renders$/, (w) => { draw(w); });
  reg.define(/^the roster renders$/, (w) => { draw(w); });
  reg.define(/^the view renders$/, (w) => { draw(w); });
  reg.define(/^the view renders the overflow line$/, (w) => { draw(w); });

  reg.define(/^Claude spawns another agent$/, (w) => {
    const id = agentId();
    w.s.spawn({ toolUseId: toolUseId(), agentId: id, at: w.now - 500, subagentType: 'general-purpose', prompt: 'the newcomer', description: 'new' });
    w.newcomerTask = 'the newcomer';
  });

  reg.define(/^the session's live agent count reaches (\d+)$/, (w, total) => {
    while (w.live < Number(total)) w.addLive();
    w.total = Number(total) + w.finishedTasks.length;
    draw(w);
  });

  reg.define(/^the next redraw happens$/, (w) => { draw(w, { now: w.now }); });

  reg.define(/^redraws happen for the remainder of the session$/, (w) => {
    // A day out, not a minute: the retirement clock this scenario denies is
    // measured in tens of seconds, so a short hop proves nothing (the first
    // draft's mutant survived exactly that).
    w.longRun = [1_000, 60_000, 3_600_000, 86_400_000].map((dt) => draw(w, { now: w.now + dt }));
  });

  reg.define(/^the roster derives for the first time$/, (w) => {
    // "For the first time" literally: the module-level tail is dropped so this
    // compose reads the resumed transcript from byte zero, the way a panel that
    // has just started does.
    __resetRosterState();
    draw(w);
  });

  reg.define(/^the transcript produces nothing new for (\d+) seconds$/, (w, secs) => {
    draw(w, { now: w.lastEventAt + Number(secs) * 1000 });
  });

  reg.define(/^further redraws come and go with the feed still quiet$/, (w) => {
    w.laterFrames = [15_000, 60_000, 300_000].map((dt) => draw(w, { now: w.staleAt + dt }));
  });

  reg.define(/^the transcript produces a new event$/, (w) => {
    w.freshWords = [];
    w.liveIds.forEach((/** @type {string} */ id, /** @type {number} */ i) => {
      const words = `resumed on module ${i}`;
      w.freshWords.push(words);
      w.s.agentTurn({ agentId: id, at: w.staleAt + 10_000, blocks: [{ type: 'text', text: words }] });
    });
    // Exactly ONE redraw tick after the event, which is what the Then measures.
    w.recovered = draw(w, { now: w.staleAt + 11_000 });
  });

  reg.define(/^the session exits and drops its sentinel$/, (w) => {
    fs.writeFileSync(path.join(w.stateDir, 'exited'), '');
    w.endedFrame = draw(w);
    w.economyEnded = plain(composeFrame(w.stateDir, { now: w.now, view: 0, cols: COLS, rows: ROWS }));
  });

  reg.define(/^the sidecar of instance (\d+) renders the subagents view$/, (w, n) => {
    w.subject = w.instances.find((/** @type {any} */ x) => x.n === Number(n));
    assert.ok(w.subject, `no instance ${n} is running`);
    // The SIBLINGS RENDER FIRST, and the tab under test renders last. Order is
    // the whole of this binding's teeth: mutation-testing found that rendering
    // the subject first hid a tail that carried one tab's agents into the next
    // pane it drew — the leak the scenario exists to deny — because the subject
    // had been the first thing drawn since the state was cleared. Their frames
    // are also the witness for the refusal below, and proof that each
    // instance's own work really is visible somewhere.
    w.siblings = w.instances.filter((/** @type {any} */ x) => x !== w.subject)
      .map((/** @type {any} */ x) => plain(composeFrame(x.stateDir, { now: w.now, view: SUBAGENTS_VIEW, cols: COLS, rows: ROWS })));
    w.frame = draw(w, { stateDir: w.subject.stateDir });
  });

  reg.define(/^F3 cycles the views starting from the economy panel$/, (w) => { w.cycle = walkCycle(w, 4); });
  reg.define(/^the rotation is assembled$/, (w) => { w.cycle = walkCycle(w, 5); });

  /**
   * The cycle, walked through the production wiring: `cycleView` writes the
   * request file the host's key writes, `frame` reads it, advances its own view
   * index and hands it to composeFrame. The wrapper pins the pane geometry and
   * records the index that actually reached the frame, so a tick that painted
   * the right thing for the wrong reason is still visible in the failure.
   * @param {Record<string, any>} w
   * @param {number} steps
   */
  function walkCycle(w, steps) {
    /** @type {{ view: string, index: number }[]} */
    const seen = [];
    const tick = () => {
      let painted = '';
      /** @type {number} */ let index = -1;
      frame({
        stateDir: w.stateDir,
        compose: (/** @type {string} */ dir, /** @type {any} */ o) => {
          index = o.view;
          return composeFrame(dir, { ...o, cols: COLS, rows: ROWS });
        },
        paint: (/** @type {string} */ s) => { painted = s; },
      });
      seen.push({ view: classify(w, plain(painted)), index });
    };
    tick();
    for (let i = 1; i < steps; i += 1) {
      const res = cycleView(w.stateDir);
      assert.ok(res.ok, `the cycle key could not record a request: ${res.reason}`);
      tick();
    }
    return seen;
  }

  /**
   * Which view is on screen, identified POSITIVELY. A classifier that returned
   * "the feed" for anything that was not the economy panel would call an error
   * line, a blank frame or a stale pane a success — which is precisely how a
   * rotation test passes while the rotation is broken.
   * @param {Record<string, any>} w
   * @param {string} p
   * @returns {string}
   */
  function classify(w, p) {
    const first = (p.split('\n')[0] || '').trim();
    if (/^economy\b/.test(first) && /[▓░]/.test(p)) return 'economy';
    if (/^subagents\b/.test(first)) return 'subagents';
    if (/^feed\b/.test(first)) return 'feed';
    // The git pane's identity row, named: this instance's own repository and
    // its own branch. Anything looser would let an error line, a blank frame or
    // a stale pane pass for the git pane.
    // The cycle marker joins the identity row as soon as a pane is configured,
    // so it is taken off before the row is read — otherwise the one scenario
    // that configures a pane could never recognise the git view.
    const bare = first.replace(/\s+\d+\/\d+$/, '');
    const id = /^(\S(?:.*\S)?)\s{2,}(\S(?:.*\S)?)\s*$/.exec(bare);
    if (id && id[1] === w.repoName && id[2] === w.repoBranch) return 'git';
    // The optional view, named by the blob it was given: the golden fixture's
    // own tool id and one of its own rows.
    if (/gherkin-trace/.test(p) && /attention/.test(p)) return 'pane';
    return 'other';
  }

  // ── Thens ─────────────────────────────────────────────────────────────────

  reg.define(/^each block shows its type, its task, its age, and its token count$/, (w) => {
    assert.strictEqual(blocks(w.frame).length, w.expected.length,
      `expected ${w.expected.length} blocks; got:\n${w.frame}`);
    for (const e of w.expected) {
      const b = blockNaming(w.frame, e.task);
      assert.ok(b, `no block names the task "${e.task}":\n${w.frame}`);
      const [, , , body, age, tokens] = /** @type {RegExpExecArray} */ (b.parts);
      assert.ok(body.startsWith(e.type), `the block for "${e.task}" leads with "${body}" rather than its type "${e.type}"`);
      assert.ok(body.includes(e.task), `the block for "${e.task}" lost its task column: "${body}"`);
      assert.strictEqual(age, fmtMinutes(e.ageMs), `the block for "${e.task}" shows the age "${age}"`);
      assert.strictEqual(tokens, abbreviate(e.tokens), `the block for "${e.task}" shows the token count "${tokens}"`);
    }
  });

  /** Minutes/hours/days — src/liveness.js's wording, restated so this file compares against a constant rather than against the renderer. */
  const fmtMinutes = (/** @type {number} */ ms) => {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) { const r = m % 60; return r ? `${h}h${String(r).padStart(2, '0')}m` : `${h}h`; }
    const d = Math.floor(h / 24); const rh = h % 24;
    return rh ? `${d}d${rh}h` : `${d}d`;
  };

  /** The token abbreviation the panel uses (src/render/shared.js `tok`), restated for the same reason. */
  const abbreviate = (/** @type {number} */ n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

  reg.define(/^each block's activity line quotes that agent's latest words$/, (w) => {
    for (const e of w.expected) {
      const b = blockNaming(w.frame, e.task);
      assert.ok(b, `no block names the task "${e.task}":\n${w.frame}`);
      assert.ok(b.activity.includes(e.words),
        `the activity line under "${e.task}" reads ${JSON.stringify(b.activity)} rather than quoting "${e.words}"`);
    }
  });

  reg.define(/^the view shows a "no subagents" line$/, (w) => {
    assert.match(w.frame, /no subagents/, `the view should say so plainly:\n${w.frame}`);
  });

  reg.define(/^no agent blocks are drawn$/, (w) => {
    assert.deepStrictEqual(blocks(w.frame), [], `the empty view drew blocks:\n${w.frame}`);
    // Earned absence: the state glyphs are ccr's OWN vocabulary and can be
    // renamed, so the witness is a real roster rendered through the same call —
    // if the glyphs change, the control fails instead of this refusal quietly
    // becoming true of every frame forever.
    const witness = plain(composeFrame(w.witnessStateDir || makeWitness(w), {
      now: T0 + 5000, view: SUBAGENTS_VIEW, cols: COLS, rows: ROWS,
    }));
    refuteWithControl(/[●✓✗]/, w.frame, witness, 'a block was drawn for a session with no subagents');
  });

  /** A one-agent session, rendered only to witness what a block looks like. */
  function makeWitness(/** @type {Record<string, any>} */ w) {
    const made = newSession(w, 'witness');
    made.s.spawn({ toolUseId: toolUseId(), agentId: agentId(), at: T0, subagentType: 'explore', prompt: 'a real block', description: 'real' });
    w.witnessStateDir = made.stateDir;
    return made.stateDir;
  }

  reg.define(/^within one redraw tick the roster shows (\d+) live agents$/, (w, n) => {
    // Exactly ONE compose after the spawn — the whole claim is that a redraw is
    // all it takes, so a loop that retried would be measuring something else.
    const after = draw(w);
    assert.strictEqual(blocks(after).length, Number(n), `expected ${n} blocks one tick after the spawn:\n${after}`);
    assert.ok(blockNaming(after, w.newcomerTask), `the new agent is missing from the roster:\n${after}`);
  });

  reg.define(/^the task column reads "([^"]+)"$/, (w, task) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    const body = /** @type {RegExpExecArray} */ (b.parts)[3];
    assert.strictEqual(body, `${w.agentType}  ${task}`,
      `the head row's body is ${JSON.stringify(body)} rather than the type and Claude's own dispatch words`);
  });

  reg.define(/^the task column occupies exactly (\d+) row inside the pane width$/, (w, rows) => {
    const bs = blocks(w.frame);
    assert.strictEqual(bs.length, 1, `expected one block:\n${w.frame}`);
    assert.strictEqual(w.frame.split('\n').filter((/** @type {string} */ l) => l.includes(w.promptHead)).length, Number(rows),
      `the prompt should occupy ${rows} row:\n${w.frame}`);
    for (const line of w.frame.split('\n')) {
      assert.ok(line.length <= COLS, `a row ran past the pane width (${line.length} > ${COLS}): ${JSON.stringify(line)}`);
    }
    // Earned absence: a run of the prompt taken a hundred characters past its
    // head — well inside what the derivation stores, and far past what one row
    // of this pane can hold — so a task that wrapped instead of being cut
    // head-first would put it on screen. The witness is the prompt itself,
    // which is where that run really lives. (Deliberately NOT the prompt's
    // tail: src/subagents.js caps a stored task at 512 characters, so a needle
    // from the far end could never appear and the refusal would prove nothing
    // about the RENDERER, which is what this scenario is about.)
    refuteWithControl(w.prompt.slice(100, 130), w.frame, w.prompt,
      'the task column wrapped instead of keeping its head on one row');
  });

  reg.define(/^the task column starts with the head of that prompt$/, (w) => {
    const body = /** @type {RegExpExecArray} */ (blocks(w.frame)[0].parts)[3];
    assert.ok(body.includes(w.promptHead),
      `the task column is ${JSON.stringify(body)} and does not begin with ${JSON.stringify(w.promptHead)}`);
  });

  reg.define(/^the block shows the agent type alone where a task would stand$/, (w) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    assert.strictEqual(/** @type {RegExpExecArray} */ (b.parts)[3], w.agentType,
      'an empty dispatch must leave the type carrying the row, with nothing standing in for the prompt');
  });

  reg.define(/^the activity line shows those words marked (\S+) old$/, (w, ago) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    assert.ok(b.activity.includes(w.words), `the activity line lost the words: ${JSON.stringify(b.activity)}`);
    assert.match(b.activity, new RegExp(`${ago}\\s*$`),
      `the activity line should end with the age marker "${ago}": ${JSON.stringify(b.activity)}`);
  });

  reg.define(/^the activity line names that (\w+) call$/, (w, tool) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    assert.ok(b.activity.includes(String(tool)), `the activity line does not name the ${tool} call: ${JSON.stringify(b.activity)}`);
    assert.ok(b.activity.includes(w.toolArg), `the activity line names ${tool} without its argument: ${JSON.stringify(b.activity)}`);
  });

  reg.define(/^no words are invented$/, (w) => {
    // Earned absence: this agent wrote a THINKING block and no text block, and
    // thinking is not words (docs/SUBAGENTS.md). The witness is the thinking
    // text as the fixture wrote it into the transcript, so a ladder that
    // promoted thinking to words fails here rather than reading as progress.
    refuteWithControl(w.thinking, w.frame, w.agentFileText,
      'a thinking block was rendered as the agent\'s words');
  });

  reg.define(/^the activity line is the quiet placeholder$/, (w) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    assert.strictEqual(b.activity.trim(), '…',
      `an agent with nothing to show should stay quiet, not say ${JSON.stringify(b.activity)}`);
  });

  reg.define(/^every roster slot still holds a live agent$/, (w) => {
    const bs = blocks(w.frame);
    assert.strictEqual(bs.length, w.slots, `expected ${w.slots} slots to be full:\n${w.frame}`);
    for (const b of bs) {
      assert.strictEqual(/** @type {RegExpExecArray} */ (b.parts)[2], '●',
        `a finished agent took a slot from a live one: ${JSON.stringify(b.head)}`);
    }
  });

  reg.define(/^the overflow line counts the agents beyond the slots$/, (w) => {
    assert.match(overflowLine(w.frame), new RegExp(`^\\+${w.total - w.slots} more\\b`),
      `the overflow line should count the ${w.total - w.slots} agents past the ${w.slots} slots; it reads ${JSON.stringify(overflowLine(w.frame))}`);
  });

  reg.define(/^the overflow line counts the (\d+) agents beyond the slots$/, (w, n) => {
    assert.strictEqual(w.total - w.slots, Number(n), `the fixture must really leave ${n} agents beyond the slots`);
    assert.match(overflowLine(w.frame), new RegExp(`^\\+${n} more\\b`),
      `the overflow line reads ${JSON.stringify(overflowLine(w.frame))}`);
  });

  reg.define(/^the overflow line names ([\w, ]+) and the (\w+)s among them$/, (w, names, repeated) => {
    const line = overflowLine(w.frame);
    for (const name of String(names).split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(line.includes(name), `the overflow line does not name "${name}": ${JSON.stringify(line)}`);
    }
    const n = w.beyond.filter((/** @type {string} */ t) => t === String(repeated)).length;
    assert.ok(line.includes(`${repeated} ×${n}`),
      `the overflow line should say the ${n} ${repeated}s beyond the cap: ${JSON.stringify(line)}`);
  });

  reg.define(/^the roster holds the (\d+) live agents and the (\d+) newest finishes$/, (w, live, finished) => {
    const shown = blocks(w.frame).map((b) => /** @type {RegExpExecArray} */ (b.parts)[3]);
    const newest = w.finishedTasks.slice(-Number(finished)).reverse();
    assert.strictEqual(shown.length, Number(live) + Number(finished), `expected ${w.slots} filled slots:\n${w.frame}`);
    for (const task of w.liveTasks) {
      assert.ok(shown.some((/** @type {string} */ b) => b.includes(task)), `the live agent "${task}" lost its slot:\n${w.frame}`);
    }
    for (const task of newest) {
      assert.ok(shown.some((/** @type {string} */ b) => b.includes(task)), `the recent finish "${task}" is missing:\n${w.frame}`);
    }
  });

  reg.define(/^no finished agent displaces a live one$/, (w) => {
    const older = w.finishedTasks.slice(0, w.finishedTasks.length - 2);
    const subject = w.frame;
    // Earned absence: the same world drawn on a pane tall enough for every
    // agent DOES show these finishes, so the witness is production output and
    // the refusal cannot become true by a renaming of the fixture.
    const tall = draw(w, { rows: ROWS });
    w.frame = subject;
    refuteWithControl(new RegExp(older.join('|')), subject, tall,
      'a finished agent took a slot the roster owed to a live one or to a newer finish');
  });

  reg.define(/^that block is gone from the roster$/, (w) => {
    assert.ok(!blockNaming(w.frame, w.retiringTask),
      `the finished block outlived its retirement clock:\n${w.frame}`);
    // Earned absence: the block really renders when the clock has not expired,
    // and that earlier frame — production output from this very world — is the
    // witness, so a renamed task cannot make this refusal vacuous.
    const still = draw(w, { now: w.completedAt + 50_000 });
    refuteWithControl(w.retiringTask, draw(w, { now: w.now }), still,
      'the retired agent is still on the roster');
  });

  reg.define(/^nothing was pressed to remove it$/, (w) => {
    // "Nothing was pressed" is a claim about the cycle-request counter, so it is
    // checked against a CONTROL: the counter really does move when something is
    // pressed, proved on a scratch state dir this scenario does not read.
    const scratch = fs.mkdtempSync(path.join(w.root, 'scratch-'));
    const before = readViewRequests(scratch);
    assert.ok(cycleView(scratch).ok, 'the control press could not be recorded');
    assert.ok(readViewRequests(scratch) > before, 'a press must be observable for its absence to mean anything');

    assert.strictEqual(readViewRequests(w.stateDir), w.pressesBefore,
      'the roster retired a block only after a key was pressed');
    // And reading really did not disturb the instance (DESIGN principle 1):
    // whatever else changed, the state dir gained and lost nothing.
    assert.strictEqual(fs.readdirSync(w.stateDir).sort().join(','), w.dirBefore,
      'rendering the roster wrote into the instance\'s state dir');
  });

  reg.define(/^that block stays until the session ends$/, (w) => {
    for (const [i, f] of w.longRun.entries()) {
      assert.ok(f.includes(w.stayingTask), `redraw ${i + 1} dropped a finish that carries no timestamp:\n${f}`);
    }
    // "Until the session ends": the sentinel is what ends it, and then the pane
    // yields to the ended screen rather than to an empty roster.
    fs.writeFileSync(path.join(w.stateDir, 'exited'), '');
    assert.match(draw(w, { now: w.now + 86_400_000 }), /session ended/,
      `the session's end is what removes the block:\n${w.frame}`);
  });

  reg.define(/^none of the ancient finishes appear$/, (w) => {
    assert.deepStrictEqual(blocks(w.frame), [], `a resumed session resurrected finished work:\n${w.frame}`);
    assert.match(w.frame, /no subagents/, `the view should say the roster is empty:\n${w.frame}`);
    // Earned absence: the transcript still holds every ancient task, verbatim,
    // so a retirement clock keyed to observation time would put them on screen.
    // The witness is that transcript.
    refuteWithControl(new RegExp(w.ancientTasks.join('|')), w.frame, w.transcriptText,
      'a completion stamped days ago came back when the session resumed');
  });

  reg.define(/^the block shows a failure state carrying "([^"]+)"$/, (w, why) => {
    const b = blockNaming(w.frame, w.failedTask);
    assert.ok(b, `no block names the failed agent's task:\n${w.frame}`);
    assert.strictEqual(/** @type {RegExpExecArray} */ (b.parts)[2], '✗',
      `the failed agent's block reads ${JSON.stringify(b.head)}`);
    assert.ok(b.activity.includes(String(why)),
      `the block should carry what Claude Code surfaced: ${JSON.stringify(b.activity)}`);
  });

  reg.define(/^the block does not carry the done glyph$/, (w) => {
    const failed = blockNaming(w.frame, w.failedTask);
    const done = blockNaming(w.frame, w.doneTask);
    assert.ok(failed && done, `both the failed and the finished block must be on screen:\n${w.frame}`);
    // Earned absence: the done glyph is ccr's own vocabulary and could be
    // changed at any time, so the witness is the successful agent's block in
    // this very frame — where the glyph really is.
    refuteWithControl(/✓/, failed.head + '\n' + failed.activity, done.head,
      'a failed agent is carrying the glyph that means it finished cleanly');
  });

  reg.define(/^the view marks its facts stale and states how stale they are$/, (w) => {
    assert.match(w.frame, /stale/, `the view should mark itself stale:\n${w.frame}`);
    assert.match(w.frame, /\b30s\b/, `the view should state HOW stale it is:\n${w.frame}`);
  });

  reg.define(/^each block keeps the words it held when the feed went quiet$/, (w) => {
    for (const f of w.laterFrames) {
      for (const words of w.wordsShown) {
        assert.ok(f.includes(words), `a later redraw erased "${words}" instead of freezing it:\n${f}`);
      }
    }
  });

  reg.define(/^within one redraw tick the staleness mark is gone$/, (w) => {
    // Earned absence: the stale mark really was on screen one tick ago, and
    // that frame — production output from this world — is the witness.
    refuteWithControl(/stale/, w.recovered, w.staleFrame,
      'the staleness mark outlived the event that should have cleared it');
  });

  reg.define(/^each block resumes live words$/, (w) => {
    for (const words of w.freshWords) {
      assert.ok(w.recovered.includes(words), `the recovered view is missing "${words}":\n${w.recovered}`);
    }
  });

  reg.define(/^the panel shows the session-ended screen like any other view$/, (w) => {
    assert.match(w.endedFrame, /session ended/, `the subagents view should yield to the ended screen:\n${w.endedFrame}`);
    assert.strictEqual(w.endedFrame, w.economyEnded,
      'the ended screen must be the same on this view as on any other');
  });

  reg.define(/^the nested agent holds its own block$/, (w) => {
    assert.strictEqual(blocks(w.frame).length, 2, `the roster stays flat: parent and child both hold blocks:\n${w.frame}`);
    assert.ok(blockNaming(w.frame, w.childTask), `the nested agent has no block of its own:\n${w.frame}`);
  });

  reg.define(/^that block carries a prefix tying it to its parent$/, (w) => {
    const child = blockNaming(w.frame, w.childTask);
    const parent = blockNaming(w.frame, w.parentTask);
    assert.ok(child && parent, `both blocks must be on screen:\n${w.frame}`);
    assert.strictEqual(/** @type {RegExpExecArray} */ (child.parts)[1], '└ ',
      `the nested block should carry the lineage prefix: ${JSON.stringify(child.head)}`);
    // Earned absence: the prefix is ccr's own glyph, so the witness is the
    // child's row — where it really is — rather than a spelled-out literal.
    refuteWithControl(/└/, parent.head, child.head,
      'a session-dispatched agent is wearing the lineage prefix that means it was nested');
  });

  reg.define(/^those words appear as plain inert text$/, (w) => {
    // The visible remnants really are on screen, as ordinary characters: the
    // ESC and the BEL are gone and the letters they were steering survive.
    assert.match(w.frame, /PWNED/, `the hostile words should render as text:\n${JSON.stringify(w.frame)}`);
    // Earned absence: no control byte survives to the frame. `plain` has
    // already removed ccr's OWN SGR runs, and the newline that separates rows is
    // excluded from the class; everything else in 0x00–0x1f and 0x7f is a byte
    // a terminal would obey. The witness is the raw fixture text, which really
    // does contain ESC, BEL and DEL.
    refuteWithControl(/[\x00-\x09\x0b-\x1f\x7f]/, w.frame, w.hostile,
      'a control byte from an agent\'s words reached the terminal');
  });

  reg.define(/^the panel redraws normally afterwards$/, (w) => {
    // "Afterwards" is another tick of the real draw loop: the pane that met the
    // hostile words must still be drawing its roster, not an error line and not
    // a frozen frame.
    const after = draw(w, { now: w.now + 1000 });
    assert.match(after, /^ *subagents\b/m, `the panel stopped drawing its roster after the hostile words:\n${JSON.stringify(after)}`);
    assert.strictEqual(blocks(after).length, 1, `the roster should still be there:\n${after}`);
    refuteWithControl(/[\x00-\x09\x0b-\x1f\x7f]/, after, w.hostile,
      'the redraw after hostile words carried a control byte');
  });

  reg.define(/^those exact characters appear in the block, unmasked and whole$/, (w) => {
    const b = blocks(w.frame)[0];
    assert.ok(b, `no block was drawn:\n${w.frame}`);
    assert.ok(b.activity.includes(w.secret),
      `the words must render character for character (the fence ratified verbatim with eyes open): ${JSON.stringify(b.activity)}`);
  });

  reg.define(/^every block on that pane belongs to instance (\d+)'s session$/, (w, n) => {
    const bs = blocks(w.frame);
    assert.strictEqual(bs.length, 1, `instance ${n}'s pane should show its own single agent:\n${w.frame}`);
    assert.ok(bs[0].head.includes(w.subject.task), `instance ${n}'s pane does not show its own work:\n${w.frame}`);
    const others = w.instances.filter((/** @type {any} */ x) => x !== w.subject);
    // Earned absence: each sibling's work really renders on its OWN pane, so the
    // witness is those panes — production output — and a renamed fixture makes
    // the control fail rather than making this refusal vacuous.
    refuteWithControl(
      new RegExp(others.map((/** @type {any} */ x) => x.task).join('|')),
      w.frame,
      w.siblings.join('\n'),
      `instance ${n}'s pane is showing another tab's agents`,
    );
  });

  reg.define(/^the order visits the git pane, then the feed, then subagents$/, (w) => {
    assert.deepStrictEqual(w.cycle.map((/** @type {any} */ c) => c.view),
      ['economy', 'git', 'feed', 'subagents'],
      `the built-in rotation is wrong (view indices ${JSON.stringify(w.cycle.map((/** @type {any} */ c) => c.index))})`);
  });

  reg.define(/^the optional view follows subagents$/, (w) => {
    const order = w.cycle.map((/** @type {any} */ c) => c.view);
    assert.strictEqual(order[order.indexOf('subagents') + 1], 'pane',
      `the configured pane should come straight after the roster; the cycle went ${JSON.stringify(order)}`);
  });

  reg.define(/^economy, git pane, feed and subagents keep their relative order$/, (w) => {
    assert.deepStrictEqual(w.cycle.map((/** @type {any} */ c) => c.view).slice(0, 4),
      ['economy', 'git', 'feed', 'subagents'],
      'an optional view must never land between the built-ins');
  });
};
