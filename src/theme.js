// @ts-check
'use strict';
// src/theme.js — UI lexicon and theme gating.
//
// Default ("plain") is accessible: "the wall" works as the everyday "hit the
// wall" idiom for hitting your limit. The "mary" theme (Proud Mary — CCR) swaps
// in the full classic-rock vocabulary. It auto-enables on the CCR debut-album
// anniversary, and can be forced any day via the innocuous env switch
// CCR_ENABLE_MARY_INTERFACE (a "subtle startup switch" that gives nothing away).

const THEMES = {
  plain: { wall: 'the wall', within: 'within limits', imminent: 'limit imminent', looming: 'next limit', clearKey: 'F2·clear' },
  mary:  { wall: 'the wall', within: 'comfortably numb', imminent: 'bad moon rising', looming: 'up around the bend', clearKey: 'F2·wipe out' },
};

// Creedence Clearwater Revival — self-titled debut LP, released July 5, 1968.
const CCR_DEBUT = { month: 7, day: 5 };

/**
 * @param {Date} [now]
 * @param {Record<string,string|undefined>} [env]
 * @returns {'plain'|'mary'}
 */
function resolveTheme(now, env) {
  const e = env || process.env;
  if (e.CCR_ENABLE_MARY_INTERFACE) return 'mary';
  const d = now || new Date();
  if (d.getMonth() + 1 === CCR_DEBUT.month && d.getDate() === CCR_DEBUT.day) return 'mary';
  return 'plain';
}

/** @param {string} [name] */
function lexicon(name) {
  return THEMES[name === 'mary' ? 'mary' : 'plain'];
}

module.exports = { THEMES, CCR_DEBUT, resolveTheme, lexicon };
