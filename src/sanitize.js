// @ts-check
'use strict';
// src/sanitize.js — strip terminal control characters from externally-sourced
// text before it is rendered.
//
// Transcript titles/prompts/tool-args and status-JSON fields (model name,
// rate-limit labels) can contain arbitrary bytes — web content the assistant
// fetched, pasted data, a planted snapshot. Emitting raw ANSI/control sequences
// to a terminal enables output spoofing (and worse on some terminals). These are
// all single-line display fields, so we drop every C0/C1 control + DEL
// (including ESC, newline, tab). Applied at the ingestion choke points
// (parseEvents, normalizeStatus, discoverWindows) so every renderer is covered.
//
// `ccr economy --json` needs no extra escaping layer: its string fields (model,
// rate-limit labels) come from the SAME sanitized ingestion (normalizeStatus /
// discoverWindows), so they are already control-char-free. (Note JSON.stringify
// alone is NOT sufficient — it escapes C0 but leaves DEL/C1 bytes raw — which is
// exactly why we sanitize at ingestion rather than rely on the serializer.)

// C0 controls (00-1F, incl. ESC/newline/tab), DEL (7F), and C1 controls (80-9F).
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * @param {any} s
 * @returns {any} the string with control chars removed; non-strings pass through
 */
function stripControl(s) {
  return typeof s === 'string' ? s.replace(CONTROL_RE, '') : s;
}

module.exports = { stripControl };
