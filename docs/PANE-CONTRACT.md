# External pane blobs — the sidecar integration contract

The ccr sidecar can host **external tool panes**: full-height views rendered
from small JSON blobs that other tools write beside their own artifacts. ccr
reads the file and renders it — that is the entire acquisition path. No
subprocess, no database, no schema knowledge of the producing tool.

This is the durable seam recovered from the original wrapper sidecar: a pure
renderer over a normalized status blob. The part that did not survive — the
renderer shelling into the producer's SQLite from the draw loop — is replaced
by the producer computing its own blob at its own natural moment (a refresh, a
drain, a run) and dropping it as a file.

```
tool's own artifact dir                      ccr sidecar
┌───────────────────────┐   user config     ┌──────────────────────┐
│ .gherkin-trace/       │   lists paths     │ read file bytes      │
│   sidecar.json  ──────┼──────────────────►│ parse · render pane  │
│ (written atomically   │                   │ (style cycle, chrome)│
│  by the tool itself)  │                   └──────────────────────┘
└───────────────────────┘
```

**Discovery is user configuration, not convention.** Producers never know ccr
exists; ccr never guesses paths. The human wires the join, exactly like Claude
Code's `statusLine` wiring. Neither side takes a dependency on the other.

## Stability promise

- **`v`** starts at `1`. It bumps **only** on a breaking change — a
  renamed/removed field or changed semantics.
- New **optional** fields may be added without bumping `v`. ccr MUST ignore
  unknown fields; producers MUST NOT require them.
- A blob whose `v` ccr does not recognise renders as a named
  "unsupported blob version" pane state — never a misrender, never a skip.

## Shape (v1)

```jsonc
{
  "v": 1,                              // contract version — required
  "tool": "gherkin-trace",             // producer identity — required
  "title": "trace",                    // short pane title — required
  "status": "ok",                      // "ok" | "broken" — required
  "basis": {                           // what this blob stands on — required
    "label": "refresh",                //   the producer's natural moment
    "at": "2026-08-01 14:10"           //   its time, producer-formatted
  },
  "message": null,                     // required when status is "broken":
                                       //   what failed, in the producer's words
  "rows": [                            // the pane body — required (may be [])
    {
      "label": "attention",            // required
      "value": "3",                    // required, preformatted string
      "status": "alert",               // required — see the closed enum
      "detail": "1 breach, 2 orphans", // optional, small print
      "spark": [2, 5, 3, 8]            // optional, numbers for a sparkline
    }
  ]
}
```

### The row status enum — closed, five values

| status  | meaning                                   | render         |
| ------- | ----------------------------------------- | -------------- |
| `ok`    | healthy, nothing to do                    | green light    |
| `warn`  | worth a glance                            | yellow light   |
| `alert` | needs eyes                                | red light      |
| `dark`  | **cannot tell** — the producer could not  | distinct dark  |
|         | compute this (source absent, withheld)    | marker, never  |
|         |                                           | green or blank |
| `off`   | intentionally disabled by the producer    | dim/absent     |

`dark` is load-bearing: an honesty-first producer (gherkin-trace's dark
signal families, a withheld classification) must be able to say "cannot
tell" and have it survive into the pane. Rendering `dark` as green, or
dropping the row, converts an unknown into an all-clear — the exact failure
this contract exists to prevent.

## Producer obligations

1. **Write atomically** — write-aside then rename. A 1s-loop reader must only
   ever see the old blob or the new one, whole.
2. **Own your location** — the blob lives beside your own artifacts (e.g.
   `.gherkin-trace/sidecar.json`). Never write into ccr's state dir.
3. **Confess failure** — a file cannot refuse a read the way a query surface
   can. If your producing step fails, REWRITE the blob with
   `status: "broken"` and a `message`; never leave yesterday's healthy blob
   as the current one.
4. **State your basis** — `basis` is the moment your data stands on, in your
   own vocabulary. ccr adds the age; you supply the anchor.
5. **Preformat values** — `value` is a display string. ccr does not compute,
   convert, or localize.

## ccr (consumer) obligations

1. **Read bytes, nothing else** — no subprocess, no database, no producer
   internals. The blob path from user config is the entire interface.
2. **Required chrome** — every pane shows `basis.label`, `basis.at`, and the
   blob file's age ("as of refresh 2026-08-01 14:10 · 3m ago"). A pane
   without age chrome manufactures currency.
3. **Absence is a named state** — no file yet, unreadable JSON, or an
   unsupported `v` each render as their own labelled pane state. A configured
   pane never silently disappears.
4. **Tolerate torn reads** — a parse failure this tick renders the named
   unreadable state and retries next tick; it never crashes the loop.
5. **`broken` renders as failure** — the `message`, prominently, with the
   basis chrome. Never the previous healthy render.
6. **Full-height views, cycled** — external panes join the sidecar's style
   cycle as whole-pane views (the wrapper's pager model); they are not
   stacked into slivers.

## Action keys (F2/F3-style)

The wrapper's hotkeys — F2 sending `/clear`, F3 typing an orientation prompt
into the Claude pane — return as a **host capability**, configured beside the
pane paths:

- ccr config maps a key to either a literal string or a **prompt file path**
  (the wrapper's `inject-orient.sh` model); the key types that text into the
  Claude pane. Actions may be listed per-pane so the chrome can show
  "F3 reorient" beside the pane they relate to.
- **Blobs never carry injectable content.** The blob is display-only: any
  action-like field in a blob is ignored and never bound to a key. A data
  file written by another process must not be able to type into your
  session — the text a key injects is always user-authored configuration.

## Non-goals (v1)

- Whole-pane bespoke layouts (the wrapper's `tree-art`) cannot be expressed
  in rows. If field use demands them, the path is renderer modules shipped by
  producers (the wrapper's plugin model) *behind this same blob* — additive,
  no v-bump.
- ccr never triggers the producer. A stale blob is displayed as stale; the
  human or their agent decides to re-run the producing step. (For
  gherkin-trace this is contractual: reads must never acquire side effects.)

## Known consumers and producers

- Producer: `gherkin-trace` — `.gherkin-trace/sidecar.json`, written by
  `gt refresh`; `basis.label` is `refresh`.
- Producer (planned): `treecontext` — blob beside its store; basis moment to
  be ruled by its own contract (hook-drain time is the candidate).
