// @ts-check
'use strict';
// src/git-ignore.js — enough of gitignore matching for the untracked walk.
//
// The untracked list is the one part of the working-tree section that reads
// the WORLD rather than `.git`, and without ignore rules it would lead with
// node_modules — a thousand-line lie of omission about what the user actually
// created. So the walk honors the two per-repo sources: `.git/info/exclude`
// and every `.gitignore` on the path down.
//
// WHAT IS DELIBERATELY OUT: the user's global excludesFile (a config lookup
// away, but its patterns describe the USER's machine, and the far-side oracle
// pins this reader against `git status` run with that config disabled), and
// the escape subtleties (`\#`, trailing backslash-space). Both are recorded in
// features/design/git-untracked-walk.feature rather than silently absent.
//
// Precedence is git's: within one file the LAST matching pattern wins; a
// deeper .gitignore beats a shallower one; exclude is the weakest. A directory
// that is ignored is never descended into, which also reproduces git's "cannot
// re-include below an excluded directory" rule for free.

/**
 * @typedef {object} IgnoreRule
 * @property {boolean} neg      `!pattern` — re-includes.
 * @property {boolean} dirOnly  Trailing slash — matches directories only.
 * @property {RegExp} re        Compiled against the path RELATIVE TO the rule's base.
 */

/**
 * Compile one gitignore pattern line, or null for blanks and comments.
 * @param {string} line
 * @returns {IgnoreRule|null}
 */
function compilePattern(line) {
  let p = line.replace(/\r$/, '');
  if (!p || p.startsWith('#')) return null;
  let neg = false;
  if (p.startsWith('!')) { neg = true; p = p.slice(1); }
  p = p.replace(/(?<!\\)\s+$/, ''); // unescaped trailing spaces are trimmed
  if (!p) return null;
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  // A slash anywhere (now that a trailing one is gone) anchors the pattern to
  // the rule's own directory; without one it matches at any depth.
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);

  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` spans directories: leading `**/` any prefix, trailing `/**`
        // everything below, `a**b` collapses to any run.
        i += 1;
        if (p[i + 1] === '/') { i += 1; re += '(?:[^/]+/)*'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = p.indexOf(']', i + 2);
      if (close === -1) { re += '\\['; continue; }
      let cls = p.slice(i + 1, close);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = close;
    } else if (c === '\\' && i + 1 < p.length) {
      i += 1;
      re += p[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const body = anchored ? re : '(?:[^/]+/)*' + re;
  let compiled;
  try {
    compiled = new RegExp('^' + body + '$');
  } catch {
    return null; // a pattern this reader cannot compile ignores nothing
  }
  return { neg, dirOnly, re: compiled };
}

/**
 * Parse a whole ignore file's text into rules, in order.
 * @param {string|null} text
 * @returns {IgnoreRule[]}
 */
function parseIgnore(text) {
  if (!text) return [];
  /** @type {IgnoreRule[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const rule = compilePattern(line);
    if (rule) out.push(rule);
  }
  return out;
}

/**
 * Is `rel` (POSIX path relative to the rules' base) ignored by these rules?
 * Returns the last matching rule's verdict, or null when nothing matched.
 * @param {IgnoreRule[]} rules
 * @param {string} rel
 * @param {boolean} isDir
 * @returns {boolean|null}
 */
function matchRules(rules, rel, isDir) {
  /** @type {boolean|null} */
  let verdict = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) verdict = !r.neg;
  }
  return verdict;
}

module.exports = { compilePattern, parseIgnore, matchRules };
