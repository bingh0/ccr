// @ts-check
'use strict';
// src/render/feed.js — the live tool/skills feed shown under the economy panel in
// the sidecar. Pure function of an accumulated feed object (events + rolling
// stats); the sidecar does the incremental transcript tail and hands it here.

const { dim, bold, cyan, tok } = require('./shared');

/** @param {string} s @param {number} n */
function trunc(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * @typedef {{ ts: number|null, kind: 'tool'|'cmd', tool: string, arg: string }} FeedEvent
 * @typedef {{ events: FeedEvent[], tools: Record<string, number>, commands: number,
 *             tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *             files: string[] }} Feed
 */

/**
 * Render the feed block: a tool-count header, an optional rolling-stats line, and
 * the last N events. Returns '' when there's nothing to show (so the sidecar can
 * omit it cleanly).
 * @param {Feed} feed
 * @param {{ max?: number, width?: number }} [opts]
 * @returns {string}
 */
function renderFeed(feed, opts = {}) {
  if (!feed) return '';
  const max = opts.max || 5;
  const width = opts.width || 48;
  const events = Array.isArray(feed.events) ? feed.events : [];
  const tools = feed.tools || {};
  const counts = Object.keys(tools).sort((a, b) => tools[b] - tools[a]);
  // Rolling per-session stats: files touched + work generated (output tokens).
  const nFiles = Array.isArray(feed.files) ? feed.files.length : 0;
  const out = feed.tokens && feed.tokens.output;
  // Nothing to show only when there are neither tool/command/event rows NOR any
  // rolling stats — stats alone are still worth rendering.
  if (!counts.length && !feed.commands && !events.length && !nFiles && !out) return '';

  const parts = counts.map((k) => `${k} ${tools[k]}`);
  if (feed.commands) parts.push(`cmd ${feed.commands}`);
  const lines = ['  ' + bold('feed') + dim(parts.length ? '  ·  ' + trunc(parts.join(' · '), width - 8) : '  ·  (no tool calls yet)')];

  const stat = [];
  if (nFiles) stat.push(`${nFiles} file${nFiles === 1 ? '' : 's'}`);
  if (out) stat.push(`${tok(out)} generated`);
  if (stat.length) lines.push('  ' + dim('       ' + stat.join(' · ')));

  for (const e of events.slice(-max)) {
    if (e.kind === 'cmd') {
      lines.push('    ' + cyan('⌘ ' + trunc(e.tool, width - 4)));
    } else {
      const arg = e.arg ? '  ' + dim(trunc(e.arg, width - 12)) : '';
      lines.push('    ' + dim('↳ ') + e.tool.padEnd(8) + arg);
    }
  }
  return lines.join('\n');
}

module.exports = { renderFeed, trunc };
