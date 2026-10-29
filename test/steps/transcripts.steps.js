// @ts-check
'use strict';
// Step definitions for features/transcripts.feature — drives src/transcripts.js.
// Builds JSONL lines in-memory (no filesystem) and runs the real parser.
//
// MUTATION LOG — recorded because a binding no world can make red is hollow.
//
//   "One message split across several records is counted once" (added for the
//     owner's token-inflation ruling, 2026-09-02) — reverted the dedupe in
//     `parseEvents` (dropped the `mid === lastMsgId` back-out, so every record
//     adds its usage again) and the step went red on the input total: 300
//     where the message reports 100. Re-mutated the other way, keying the
//     back-out on the RECORD's `uuid` instead of `message.id` — every record
//     has its own uuid, so nothing ever matches and the same assertion fails
//     identically. The neighbouring "Assistant token usage is rolled up"
//     scenario stayed green through both, which is the guard that the dedupe
//     did not start swallowing genuinely separate turns: its two turns carry
//     no `message.id` at all, the case the ruling leaves counting per record.

const assert = require('node:assert');
const path = require('node:path');
const { parseEvents, currentTranscriptPath } = require('../../src/transcripts');

const CTRL = /[\x00-\x1f\x7f-\x9f]/;

let TS = 0;
const nextTs = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++TS)).toISOString();

/** push a raw JSONL line (object → stringified) onto the world's transcript */
function push(/** @type {Record<string, any>} */ w, /** @type {any} */ obj) {
  w.tlines = w.tlines || [];
  w.tlines.push(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function assistantToolUse(/** @type {Record<string, any>} */ w, /** @type {string} */ name, /** @type {any} */ input) {
  push(w, { type: 'assistant', timestamp: nextTs(), cwd: w.tcwd, gitBranch: w.tbranch, message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] } });
}

/** @param {import('../gherkin').StepRegistry} reg */
module.exports = function defineTranscriptSteps(reg) {
  // --- Given: build a transcript ---
  reg.define(/^a transcript$/, (w) => { w.tlines = []; });
  reg.define(/^a transcript on branch "([^"]+)" in cwd "([^"]+)"$/, (w, branch, cwd) => {
    w.tlines = []; w.tbranch = branch; w.tcwd = cwd;
  });
  reg.define(/^an assistant runs Bash described "([^"]+)"$/, (w, desc) => assistantToolUse(w, 'Bash', { description: desc, command: 'x' }));
  reg.define(/^an assistant edits file "([^"]+)"$/, (w, fp) => assistantToolUse(w, 'Edit', { file_path: fp }));
  reg.define(/^the user runs the slash command "([^"]+)"$/, (w, cmd) => {
    push(w, { type: 'user', timestamp: nextTs(), message: { role: 'user', content: `<command-name>${cmd}</command-name>\n<command-message>x</command-message>` } });
  });
  reg.define(/^an assistant invokes the Skill "([^"]+)"$/, (w, skill) => assistantToolUse(w, 'Skill', { skill }));
  reg.define(/^an ai-title carrying an escape sequence$/, (w) => push(w, { type: 'ai-title', timestamp: nextTs(), aiTitle: 'Fix \x1b[31moverlay\x1b]0;pwn\x07' }));
  reg.define(/^an assistant edits a file whose name carries an escape sequence$/, (w) => assistantToolUse(w, 'Edit', { file_path: '/p/ev\x1bil.js' }));
  reg.define(/^an assistant runs a tool whose name carries an escape sequence$/, (w) => assistantToolUse(w, 'Ba\x1b[31msh', { description: 'x' }));
  reg.define(/^an ai-title "([^"]+)"$/, (w, t) => push(w, { type: 'ai-title', timestamp: nextTs(), aiTitle: t }));
  reg.define(/^a last-prompt "([^"]+)"$/, (w, p) => push(w, { type: 'last-prompt', timestamp: nextTs(), lastPrompt: p }));
  reg.define(/^an assistant turn using (\d+) input and (\d+) output tokens$/, (w, inp, out) => {
    push(w, { type: 'assistant', timestamp: nextTs(), message: { model: 'claude-opus-4-8', usage: { input_tokens: Number(inp), output_tokens: Number(out) }, content: [{ type: 'text', text: 'ok' }] } });
  });
  // The real record shape, not a paraphrase: upstream splits one assistant
  // message across one record PER CONTENT BLOCK, each carrying the same
  // `message.id` and repeating the same `usage` object, with the envelope
  // fields (parentUuid/uuid/timestamp) that test/steps/_subagent-fixture.js
  // copied off a 2.1.252 transcript. Summed per record that is the inflation
  // the owner ruled out on 2026-09-02; the blocks differ so the records are
  // the genuinely different lines upstream writes rather than one line thrice.
  reg.define(/^an assistant message split across (\d+) records each repeating (\d+) input and (\d+) output tokens$/, (w, n, inp, out) => {
    const id = 'msg_01SplitAcrossRecords';
    const usage = { input_tokens: Number(inp), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Number(out), service_tier: 'standard' };
    for (let i = 0; i < Number(n); i += 1) {
      push(w, {
        parentUuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        uuid: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        version: '2.1.252',
        type: 'assistant',
        timestamp: nextTs(),
        message: {
          id, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
          content: [i === 0 ? { type: 'thinking', thinking: 'planning' } : { type: 'text', text: `block ${i}` }],
          usage,
        },
        requestId: 'req_011CReq',
      });
    }
  });

  reg.define(/^a malformed line$/, (w) => push(w, '{not valid json'));
  reg.define(/^a captured snapshot with transcript_path "([^"]+)"$/, (w, p) => { w.snapshot = { transcript_path: p }; });
  reg.define(/^a projects dir "([^"]+)"$/, (w, base) => { w.tbase = base; });

  // --- When ---
  reg.define(/^the transcript is parsed$/, (w) => {
    w.parsed = parseEvents(w.tlines || []);
  });

  // --- Then: feed events ---
  reg.define(/^the feed lists a "([^"]+)" event with arg "([^"]+)"$/, (w, tool, arg) => {
    const hit = w.parsed.events.find((/** @type {any} */ e) => e.kind === 'tool' && e.tool === tool && e.arg === arg);
    assert.ok(hit, `expected a ${tool} event with arg "${arg}"; got ${JSON.stringify(w.parsed.events)}`);
  });
  reg.define(/^the tool counts show "([^"]+)" once and "([^"]+)" once$/, (w, a, b) => {
    assert.strictEqual(w.parsed.stats.tools[String(a)], 1, `${a} once`);
    assert.strictEqual(w.parsed.stats.tools[String(b)], 1, `${b} once`);
  });
  reg.define(/^the feed includes a command "([^"]+)"$/, (w, cmd) => {
    const hit = w.parsed.events.find((/** @type {any} */ e) => e.kind === 'cmd' && e.tool === cmd);
    assert.ok(hit, `expected a command "${cmd}"; got ${JSON.stringify(w.parsed.events)}`);
  });
  reg.define(/^the command count is (\d+)$/, (w, n) => assert.strictEqual(w.parsed.stats.commands, Number(n)));

  // --- Then: identity + title ---
  reg.define(/^the session title is "([^"]+)"$/, (w, t) => assert.strictEqual(w.parsed.title, t));
  reg.define(/^the last prompt is "([^"]+)"$/, (w, p) => assert.strictEqual(w.parsed.lastPrompt, p));
  reg.define(/^the git branch is "([^"]+)"$/, (w, b) => assert.strictEqual(w.parsed.meta.gitBranch, b));
  reg.define(/^the cwd is "([^"]+)"$/, (w, c) => assert.strictEqual(w.parsed.meta.cwd, c));

  // --- Then: tokens ---
  reg.define(/^the input token total is (\d+)$/, (w, n) => assert.strictEqual(w.parsed.stats.tokens.input, Number(n)));
  reg.define(/^the output token total is (\d+)$/, (w, n) => assert.strictEqual(w.parsed.stats.tokens.output, Number(n)));

  // --- Then: sanitization ---
  reg.define(/^the title has no control characters$/, (w) => {
    assert.ok(w.parsed.title && !CTRL.test(w.parsed.title), `title has control chars: ${JSON.stringify(w.parsed.title)}`);
  });
  reg.define(/^no event argument has control characters$/, (w) => {
    const bad = w.parsed.events.find((/** @type {any} */ e) => CTRL.test(e.tool) || CTRL.test(e.arg));
    assert.ok(!bad, `event has control chars: ${JSON.stringify(bad)}`);
  });
  reg.define(/^no tool-count label has control characters$/, (w) => {
    const bad = Object.keys(w.parsed.stats.tools).find((k) => CTRL.test(k));
    assert.ok(!bad, `tool-count label has control chars: ${JSON.stringify(bad)}`);
  });

  // --- Then: robustness + snapshot path confinement ---
  reg.define(/^parsing does not throw$/, (w) => assert.ok(w.parsed && Array.isArray(w.parsed.events)));
  reg.define(/^the resolved transcript path is "([^"]+)"$/, (w, p) =>
    assert.strictEqual(currentTranscriptPath(w.snapshot, w.tbase), path.resolve(String(p))));
  reg.define(/^the transcript path is rejected$/, (w) =>
    assert.strictEqual(currentTranscriptPath(w.snapshot, w.tbase), null));
};
