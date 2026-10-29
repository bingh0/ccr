// @ts-check
'use strict';
// test/steps/_subagent-fixture.js — a Claude Code projects tree, in Claude
// Code's own record shapes.
//
// Every template below was copied from a real 2.1.252 transcript on
// 2026-09-01 (see docs/SUBAGENTS.md for which fields the derivation reads and
// which of these shapes is VERIFIED versus reconstructed). Fixtures that
// paraphrase upstream are worth very little: they test the parser against the
// test author's memory rather than against the thing that will actually change
// underneath it. So the JSON here carries upstream's incidental fields —
// parentUuid, isSidechain, promptSource, service_tier, the long "internal
// metadata" preamble of an async launch — even though the derivation ignores
// them, because a shape that arrives with them must keep parsing.
//
// THREE SHAPES ARE RECONSTRUCTED, NOT OBSERVED, and are marked at their
// builders: the foreground (synchronous) completion, an agent failure, and the
// older `Task` tool name. 2.1.252 launches every Agent async and no failure
// occurred in the captured corpus.
//
// Writes go only where the caller points them — a temp directory it owns.
// Nothing here ever touches ~/.claude.

const fs = require('node:fs');
const path = require('node:path');

/** ISO from ms, because every upstream timestamp is an ISO string. */
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

/**
 * A session's projects tree: `<root>/<slug>/<sid>.jsonl` plus
 * `<root>/<slug>/<sid>/subagents/`.
 *
 * @param {string} projectsRoot   stands in for ~/.claude/projects
 * @param {{ slug?: string, sid?: string, cwd?: string }} [opts]
 */
function buildSession(projectsRoot, opts = {}) {
  const slug = opts.slug || '-tmp-work';
  const sid = opts.sid || '11111111-2222-4333-8444-555555555555';
  const cwd = opts.cwd || '/tmp/work';
  const dir = path.join(projectsRoot, slug);
  const subagents = path.join(dir, sid, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const transcript = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(transcript, '');

  /** Where a record goes: the session transcript, or an agent's own file. */
  const fileFor = (/** @type {string|null|undefined} */ agentId) =>
    (agentId ? path.join(subagents, `agent-${agentId}.jsonl`) : transcript);

  /**
   * @param {any} record
   * @param {string|null} [into]  agent id, or null for the session transcript
   */
  const write = (record, into = null) => {
    fs.appendFileSync(fileFor(into), JSON.stringify(record) + '\n');
    return record;
  };

  /** Raw lines, exactly as given — for malformed and unknown-shape feeds. */
  const writeRaw = (/** @type {string[]} */ lines, /** @type {string|null} */ into = null) => {
    // One append for the whole batch: the flood scenario writes tens of
    // thousands of lines, and a syscall per line makes the FIXTURE the slow
    // part of a test whose subject is how fast the TICK is.
    if (lines.length) fs.appendFileSync(fileFor(into), lines.join('\n') + '\n');
  };

  const envelope = (/** @type {number|null} */ at) => ({
    parentUuid: uuid(),
    uuid: uuid(),
    sessionId: sid,
    version: '2.1.252',
    cwd,
    gitBranch: 'main',
    ...(at == null ? {} : { timestamp: iso(at) }),
  });

  const api = {
    transcript,
    subagents,
    sid,
    slug,

    /**
     * DISPATCH — an `Agent` (or older `Task`) tool_use inside an assistant
     * record. `into` places it inside another agent's file, which is where a
     * NESTED dispatch really lives.
     *
     * `description` and `prompt` both DEFAULT rather than being required, and
     * both take an explicit `''` to mean "upstream wrote none" — the case the
     * owner's amended R10 (2026-09-02) needs, since the task column falls back
     * from the description to the prompt and then to the type alone. `== null`
     * rather than `||` is what makes an empty string reach the record.
     * @param {{ toolUseId: string, prompt?: string, description?: string,
     *   subagentType?: string|null, model?: string, at?: number|null,
     *   tool?: 'Agent'|'Task', into?: string|null }} o
     */
    dispatch(o) {
      /** @type {any} */
      const input = {
        description: o.description == null ? 'do the thing' : o.description,
        prompt: o.prompt == null ? 'Map the auth flow before touching tests' : o.prompt,
        run_in_background: true,
      };
      // `subagent_type` may legitimately be absent — upstream defaults it.
      if (o.subagentType !== null) input.subagent_type = o.subagentType || 'general-purpose';
      if (o.model) input.model = o.model;
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        isSidechain: !!o.into,
        type: 'assistant',
        message: {
          id: `msg_${o.toolUseId.slice(-8)}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-5-20260514',
          content: [{ type: 'tool_use', id: o.toolUseId, name: o.tool || 'Agent', input }],
          usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 90, service_tier: 'standard' },
        },
        requestId: 'req_011CReq',
      }, o.into || null);
    },

    /**
     * ASYNC LAUNCH RESULT — the dispatch-id → agentId link. NOT a completion:
     * the agent has only just started.
     * @param {{ toolUseId: string, agentId: string, at?: number|null,
     *   description?: string, into?: string|null }} o
     */
    asyncLaunch(o) {
      const outputFile = `/tmp/claude/tasks/${o.agentId}.output`;
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        isSidechain: !!o.into,
        type: 'user',
        message: {
          role: 'user',
          content: [{
            tool_use_id: o.toolUseId,
            type: 'tool_result',
            content: [{
              type: 'text',
              text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, '
                + `including the agentId below, into a user-facing reply.)\nagentId: ${o.agentId} (internal ID - do not mention to user.)\n`
                + `The agent is working in the background. You will be notified automatically when it completes.\noutput_file: ${outputFile}`,
            }],
          }],
        },
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: o.agentId,
          description: o.description == null ? 'do the thing' : o.description,
          resolvedModel: 'opus',
          prompt: 'Map the auth flow before touching tests',
          outputFile,
          canReadOutputFile: true,
        },
      }, o.into || null);
    },

    /**
     * COMPLETION — a task notification, the shape 2.1.252 actually emits. It
     * appears TWICE per task: the `queue-operation` that enqueues it and the
     * `user` record that dequeues it, both carrying the same block.
     *
     * A BACKGROUND BASH command notifies identically with a task-id that is no
     * agent's — pass `toolUseId` of a command to build that case. A SKILL-driven
     * agent notifies with its agentId as the task-id and NO tool-use-id line at
     * all (verified on 2.1.252) — omit `toolUseId` to build that case.
     *
     * @param {{ toolUseId?: string, taskId?: string, at?: number|null,
     *   status?: string, summary?: string, via?: 'queue'|'user', result?: string }} o
     */
    notify(o) {
      const block = '<task-notification>\n'
        + `<task-id>${o.taskId || 'aba6cd5608b3bab87'}</task-id>\n`
        + (o.toolUseId ? `<tool-use-id>${o.toolUseId}</tool-use-id>\n` : '')
        + `<output-file>/tmp/claude/tasks/${o.taskId || 'x'}.output</output-file>\n`
        + `<status>${o.status || 'completed'}</status>\n`
        + `<summary>${o.summary || 'Agent "do the thing" finished'}</summary>\n`
        + '<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n'
        + `<result>${o.result || 'Work complete.'}</result>\n`
        + '</task-notification>';
      const at = o.at === undefined ? Date.now() : o.at;
      if (o.via === 'user') {
        return write({
          ...envelope(at),
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: block },
          origin: { kind: 'task-notification' },
          promptSource: 'system',
          permissionMode: 'auto',
          userType: 'external',
          entrypoint: 'cli',
        });
      }
      return write({
        type: 'queue-operation',
        operation: 'enqueue',
        ...(at == null ? {} : { timestamp: iso(at) }),
        sessionId: sid,
        content: block,
      });
    },

    /**
     * COMPLETION (foreground) — RECONSTRUCTED, not observed: 2.1.252 launches
     * every Agent async, so this is the shape earlier versions returned, kept
     * because the derivation still has to survive meeting it (docs/SUBAGENTS.md
     * says so out loud).
     * @param {{ toolUseId: string, at?: number|null, isError?: boolean,
     *   text?: string, agentId?: string, into?: string|null }} o
     */
    foregroundResult(o) {
      /** @type {any} */
      const toolUseResult = { totalDurationMs: 4200, totalTokens: 1234, usage: { input_tokens: 10, output_tokens: 20 } };
      if (o.agentId) toolUseResult.agentId = o.agentId;
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        isSidechain: !!o.into,
        type: 'user',
        message: {
          role: 'user',
          content: [{
            tool_use_id: o.toolUseId,
            type: 'tool_result',
            content: [{ type: 'text', text: o.text || 'Done.' }],
            ...(o.isError ? { is_error: true } : {}),
          }],
        },
        toolUseResult,
      }, o.into || null);
    },

    /**
     * The first record of an agent's own file: the prompt it was dispatched
     * with, as a plain string, `isSidechain:true`.
     * @param {{ agentId: string, prompt?: string, at?: number|null }} o
     */
    agentPrompt(o) {
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        parentUuid: null,
        isSidechain: true,
        agentId: o.agentId,
        type: 'user',
        message: { role: 'user', content: o.prompt == null ? 'You are the builder for batch A.' : o.prompt },
      }, o.agentId);
    },

    /**
     * An assistant turn inside an agent's file. `blocks` are given as upstream
     * writes them, so a caller can mix `text`, `thinking` and `tool_use`.
     *
     * NOTE the `msgId` seam: upstream splits ONE message across several records
     * — one per block — each repeating the same `usage`. Passing the same
     * `msgId` twice reproduces that, which is the case the token formula has to
     * survive.
     * @param {{ agentId: string, at?: number|null, blocks: any[],
     *   usage?: any, msgId?: string }} o
     */
    agentTurn(o) {
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        isSidechain: true,
        agentId: o.agentId,
        type: 'assistant',
        message: {
          id: o.msgId || `msg_${uuid().slice(-8)}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-5-20260514',
          content: o.blocks,
          usage: o.usage || {
            input_tokens: 2,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 40000,
            output_tokens: 100,
            service_tier: 'standard',
          },
        },
        requestId: 'req_011CReq',
      }, o.agentId);
    },

    /** An `attachment` record — real, and ignored by the derivation. */
    attachment(/** @type {{ agentId: string, at?: number|null }} */ o) {
      return write({
        ...envelope(o.at === undefined ? Date.now() : o.at),
        type: 'attachment',
        agentId: o.agentId,
        attachment: { type: 'system_reminder', content: 'plan mode is off' },
      }, o.agentId);
    },

    /**
     * The metadata sidecar. A skill-driven agent carries `name` and NO
     * toolUseId; a nested one carries `parentAgentId` and `spawnDepth: 2`.
     * @param {{ agentId: string, agentType?: string, description?: string,
     *   toolUseId?: string|null, parentAgentId?: string|null,
     *   spawnDepth?: number|null, model?: string, name?: string }} o
     */
    meta(o) {
      /** @type {any} */
      const m = {
        agentType: o.agentType || 'general-purpose',
        description: o.description == null ? 'do the thing' : o.description,
      };
      if (o.toolUseId) m.toolUseId = o.toolUseId;
      if (o.name) m.name = o.name;
      if (o.parentAgentId) m.parentAgentId = o.parentAgentId;
      if (o.spawnDepth != null) m.spawnDepth = o.spawnDepth;
      if (o.model) m.model = o.model;
      fs.writeFileSync(path.join(subagents, `agent-${o.agentId}.meta.json`), JSON.stringify(m));
      return m;
    },

    /** Append raw text lines — malformed JSON, unknown shapes, anything. */
    raw(/** @type {string|string[]} */ lines, /** @type {string|null} */ into = null) {
      writeRaw(Array.isArray(lines) ? lines : [lines], into);
    },

    /**
     * A complete async agent: dispatch, launch link, metadata, its own file
     * with a first prompt — the four records that exist before it says a word.
     * @param {{ toolUseId: string, agentId: string, at: number, prompt?: string,
     *   subagentType?: string, description?: string, tool?: 'Agent'|'Task',
     *   parentAgentId?: string|null, spawnDepth?: number }} o
     */
    spawn(o) {
      api.dispatch({
        toolUseId: o.toolUseId, prompt: o.prompt, description: o.description,
        subagentType: o.subagentType, at: o.at, tool: o.tool,
        into: o.parentAgentId || null,
      });
      api.asyncLaunch({ toolUseId: o.toolUseId, agentId: o.agentId, at: o.at + 1000, description: o.description, into: o.parentAgentId || null });
      api.meta({
        agentId: o.agentId, agentType: o.subagentType, description: o.description,
        toolUseId: o.toolUseId, parentAgentId: o.parentAgentId,
        spawnDepth: o.spawnDepth == null ? (o.parentAgentId ? 2 : 1) : o.spawnDepth,
      });
      // The agent's own file opens a beat after the dispatch and BEFORE any
      // completion a test stamps a second later — a prompt written after a
      // finish would read as the agent resuming (src/subagents.js, RESUMED).
      api.agentPrompt({ agentId: o.agentId, prompt: o.prompt, at: o.at + 50 });
      return o.agentId;
    },
  };
  return api;
}

/** @typedef {ReturnType<typeof buildSession>} SessionFixture */

module.exports = { buildSession, iso };
