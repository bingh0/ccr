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

// The stripped set, as code-point ranges. Spelled numerically and assembled at
// runtime rather than written as a literal character class: every character in
// here is invisible or display-altering, so a literal class would be unreadable
// in a diff — and could hide an added character in plain sight, in the very code
// meant to remove such characters.
const CONTROL_RANGES = [
  [0x0000, 0x001f], // C0 controls — ESC, newline, tab
  [0x007f, 0x009f], // DEL, then C1 controls: includes the 8-bit CSI (0x9b) and
                    //   OSC (0x9d) introducers, not just their ESC-prefixed forms
  [0x200b, 0x200f], // zero-width space/joiners + LRM/RLM — invisible, so two
                    //   different byte strings can render identically
  [0x2028, 0x2029], // line/paragraph separators — a line break by another name
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates — these two ranges reorder the glyphs a
                    //   reader sees relative to the bytes actually present:
                    //   "Trojan Source" (CVE-2021-42574) aimed at a status pane.
                    //   Legitimate RTL text needs neither; scripts carry their
                    //   own direction.
  [0xfeff, 0xfeff], // zero-width no-break space (BOM) — invisible when not leading
];

const CONTROL_RE = new RegExp(
  '[' + CONTROL_RANGES.map(([lo, hi]) =>
    (lo === hi ? String.fromCodePoint(lo) : String.fromCodePoint(lo) + '-' + String.fromCodePoint(hi))
  ).join('') + ']',
  'g',
);

/**
 * Strip control characters, COERCING any non-nullish input to a string first.
 *
 * The coercion is the security-relevant half. Every renderer downstream
 * concatenates or `String()`s whatever it is handed, so returning a non-string
 * unchanged does not keep it out of the terminal — it only skips the strip, and
 * the escape bytes land on screen anyway once something stringifies them. A
 * JSON file chooses its own value *types*, so "this field is a string" is never
 * a safe assumption: `{"display_name": ["…"]}` parses just as well as a bare
 * string, and an array of one string stringifies straight back to that string.
 * Coerce once, here, at the choke point, rather than trusting a dozen call
 * sites to remember.
 *
 * `null`/`undefined` still pass through, because callers use them as "absent"
 * (`x || null`, `x != null`) and "null"/"undefined" are not display text.
 *
 * @param {any} s
 * @returns {any} a control-char-free string, or null/undefined unchanged
 */
function stripControl(s) {
  if (s == null) return s;
  return String(s).replace(CONTROL_RE, '');
}

module.exports = { stripControl };
