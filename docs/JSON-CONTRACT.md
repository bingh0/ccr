# `ccr economy --json` — the integration contract

`ccr economy --json` emits the **computed economy model** as a single JSON
object on stdout. This is the stable, machine-readable surface other tools build
on (menu-bar widgets, status bars, alerting, dashboards). The text panel and
this JSON read from the *same* model (`src/economy-model.js`), so they can never
disagree about which window binds.

```sh
ccr economy --json            # from the latest captured snapshot
cat status.json | ccr economy --json   # or pipe a CC status-line JSON in
```

## Stability promise

- **`schemaVersion`** starts at `1`. It bumps **only** on a breaking change — a
  renamed/removed field or changed semantics.
- **New fields may be added without bumping** `schemaVersion`. Consumers MUST
  ignore unknown fields rather than fail on them.
- Pin behaviour to `schemaVersion`; treat any field you don't recognise as
  optional.

## Shape

```jsonc
{
  "schemaVersion": 1,
  "model": "Opus 4.8",            // CC display name, or null (API session)

  "context": {
    "tokens": 262000,             // live context tokens, or null
    "windowSize": 1000000,        // model context window
    "pct": 26.2,                  // tokens / windowSize * 100, raw; null if unknown
    "cachedPct": null             // share of context served from cache, or null
  },

  // One entry per rate-limit bucket the plan exposes (5h, weekly, model-scoped,
  // monthly, …). Empty [] on an API session with no subscription limits.
  "windows": [
    {
      "key": "five_hour",         // stable bucket id from the status JSON
      "label": "5h",              // human label
      "usedPct": 80,              // percent of the window consumed
      "rate": 0.5,                // burn rate in %/min, or null (not enough samples)
      "minutesLeft": 40,          // minutes to exhaust at `rate`, or null
      "minutesToReset": 200,      // minutes until the window resets, or null
      "band": "warn",             // "ok" | "warn" (<=120m) | "imminent" (<=30m)
      "binding": true,            // is this the window you'll hit first?
      "resetsBeforeHit": false    // true = it resets before you'd exhaust it
    }
  ],

  // The window you'll hit first (smallest minutesLeft that exhausts before
  // reset), or null if every window resets before you reach it / API session.
  "binding": {
    "key": "five_hour",
    "label": "5h",
    "minutesLeft": 40,
    "band": "warn"
  },

  // ROI of clearing context now, framed against the binding wall.
  "clear": {
    "worthwhile": true,           // false when context is near baseline / no pressure
    "boughtMinutes": 35,          // extra minutes before the wall if you clear now
    "contextTokens": 262000,
    "baselineTokens": 14000       // assumed post-clear floor
  },

  "session": {
    "costUsd": 4.2,               // or null
    "durationMin": 30,            // or null
    "branch": "main"             // or null
  }
}
```

## Units & conventions

- **Numbers are raw (unrounded)** — the panel rounds for display; consumers
  format as they like. `pct`/`usedPct` are percent, `rate` is `%/min`,
  `minutes*` are minutes, `tokens` are counts, `costUsd` is US dollars.
- **`null` means "not known"**, not zero. An API session has `windows: []` and
  `binding: null`; a fresh session may have `rate: null` until it has ≥2 samples.
- The object is **always fully JSON-serialisable** — no `undefined`/`NaN` holes.

## For widget authors

A menu-bar / status-bar widget is **pure presentation**: poll
`ccr economy --json` on a timer and render. Do **not** reimplement the burn math
— `binding.band` gives you the colour, `binding.minutesLeft` the headline, and
`clear.worthwhile` / `clear.boughtMinutes` the clear hint. Keeping the single
tested source of truth in JS is the whole point of the contract.
