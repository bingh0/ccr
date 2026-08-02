# External pane blobs — the sidecar integration contract (v1)

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
│   sidecar.json  ──────┼──────────────────►│ sanitize · render    │
│ (written atomically   │                   │ (style cycle, chrome)│
│  by the tool itself)  │                   └──────────────────────┘
└───────────────────────┘
```

**Discovery is user configuration, not convention.** Producers never know ccr
exists; ccr never guesses paths. The human wires the join, exactly like Claude
Code's `statusLine` wiring. Neither side takes a dependency on the other.

## Trust model

**Every blob string field is untrusted display data.** The blob is a
filesystem object writable by anything running as the user, in a directory a
repository's contents can influence, carrying text that may derive from
attacker-influenceable sources (feature files, journals, fetched content).
ccr renders blob strings as **inert text, never as terminal control**:

- **Control fields** — `v` (number), `status`, row `status`, `spark`
  (numbers) — are parsed and validated against this contract.
- **Display fields** — `tool`, `title`, `basis.label`, `basis.at`,
  `message`, row `label`, `value`, `detail` — are stripped of all C0/C1
  control bytes, DEL, and escape sequences before rendering (the
  `src/sanitize.js` invariant already pinned for transcripts), then rendered
  into width-clamped single-line cells. No blob byte may reach the terminal
  uninterpreted — this closes output spoofing, OSC 52 clipboard writes,
  title-report keystroke escalation, and chrome forgery in one rule.
- Error states (unreadable, oversized, cannot-read) name the **path only** —
  never file bytes, never parser messages that quote content.

## Stability promise

- **`v`** starts at `1`. It bumps **only** on a breaking change — a
  renamed/removed field or changed semantics.
- New **optional** fields may be added without bumping `v`. ccr MUST ignore
  unknown fields (a v1 blob carrying unrecognized fields renders exactly as
  if they were absent); producers MUST NOT require them.
- A blob whose `v` ccr does not recognise renders as a named
  "unsupported blob version" pane state — never a misrender, never a skip.

## Shape (v1)

The canonical example is checked in as **`docs/pane-blob.golden.json`** — a
valid v1 blob both sides test against: ccr's suite renders it; producer
suites assert their output matches its shape.

```jsonc
{
  "v": 1,                              // contract version — required, JSON number
  "tool": "gherkin-trace",             // producer identity — required; shown in chrome
  "title": "trace",                    // short pane title — required
  "status": "ok",                      // "ok" | "broken" — required
  "basis": {                           // what this blob stands on — required
    "label": "refresh",                //   the producer's natural moment
    "at": "2026-08-01 14:10"           //   OPAQUE display string; ccr never parses it
  },
  "message": null,                     // REQUIRED non-empty string when status
                                       //   is "broken"; null or absent when ok
  "rows": [                            // the pane body — required (may be [])
    {
      "label": "attention",            // required; need not be unique
      "value": "3",                    // required, preformatted JSON STRING
      "status": "alert",               // required — closed enum below
      "detail": "1 breach, 2 orphans", // optional, small print
      "spark": [2, 5, 3, 8]            // optional; see spark rules
    }
  ]
}
```

Field rules:

- `value` is always a JSON **string**, preformatted by the producer. ccr
  does not compute, convert, or localize. Values are functions of the
  producer's data, **never of the current wall clock** — a value like
  "2d ago" would silently break producer determinism.
- `rows` render **in blob order** (the producer owns glanceability).
  Duplicate labels are legal and all render. `rows: []` renders a named
  "no rows" body with the chrome intact.
- `message` on a broken blob renders with the chrome; a broken blob's
  `rows` are **ignored** — broken renders message + chrome only.
- `spark`: at most 32 finite JSON numbers, normalized per-row to the row's
  own min–max. Non-conforming spark → the row renders without it. A spark
  must derive from the producer's current data (e.g. a density
  distribution), never from cross-run history — history accumulation
  breaks producer determinism over unchanged sources.
- Size caps: a blob over **256 KB**, over 256 rows, or with any display
  field over 512 chars renders the named "oversized" state (path only).

### The row status enum — closed, five values

| status  | meaning                                   | render                  |
| ------- | ----------------------------------------- | ----------------------- |
| `ok`    | healthy, nothing to do                    | green light             |
| `warn`  | worth a glance                            | yellow light            |
| `alert` | needs eyes                                | red light               |
| `dark`  | **cannot tell** — the producer could not  | distinct dark marker —  |
|         | compute this (source absent, withheld)    | never green, never      |
|         |                                           | blank, and visibly      |
|         |                                           | different from `off`    |
| `off`   | intentionally disabled by the producer    | dim row, still rendered |

`dark` is load-bearing: an honesty-first producer must be able to say
"cannot tell" and have it survive into the pane, visibly distinct from both
health and intentional absence. **An unrecognized row status renders as
`dark`** — never green, never dropped. A top-level `status` that is neither
`ok` nor `broken` renders the unsupported-blob state.

## Producer obligations

1. **Write atomically, always** — write-aside then rename, for the first
   write and every rewrite, with the temp file in the **same directory** as
   the target. A reader only ever sees no file, the old blob, or the new
   blob — whole.
2. **Own your location and its permissions** — the blob lives beside your
   own artifacts (e.g. `.gherkin-trace/sidecar.json`); create the directory
   owner-only. Never write into ccr's state dir.
3. **Confess failure** — a file cannot refuse a read the way a query surface
   can. If your producing step FAILS, rewrite the blob with
   `status: "broken"`, a non-empty `message`, and `basis` set to the failed
   attempt's moment. A REFUSED step (precondition unmet, already running —
   your data still stands) leaves the blob untouched. Before your first
   producing run, write **no blob at all** — the consumer's waiting state is
   the honest display; a placeholder "ok" blob manufactures health.
4. **State your basis** — `basis` is the moment your data stands on, in your
   own vocabulary, as an opaque display string. Currency comes from the
   consumer's file-age chrome; your basis is the anchor, not the age.
5. **Write your main artifacts first, blob last** — a crash mid-step must
   leave the blob describing a state that existed, never one that half-
   exists.
6. **Sanitize at the source too** — strip control bytes from any text that
   flows into blob fields from your inputs (titles, error messages, mined
   excerpts). The consumer strips anyway (it cannot trust you); stripping
   twice is the point.

## ccr (consumer) obligations

1. **Read bytes, nothing else** — no subprocess, no database, no producer
   internals. The blob path from user config is the entire interface. Re-read
   on the sidecar tick (roughly once a second, the same cadence as the
   tool feed).
2. **Safe reads** — `lstat` first: only a regular, non-symlinked file is
   read (a FIFO must not block the loop; a symlink is refused). Reads are
   size-capped. Permission errors, directories, symlinks, and over-cap files
   each render a named **cannot-read** state (with the reason class),
   distinct from the waiting state — a chmod mistake must not look like
   "the producer hasn't run yet".
3. **Required chrome** — every pane shows `tool`, `basis.label`, `basis.at`
   verbatim (sanitized), and the blob **file's age from mtime**, labeled as
   write age ("blob written 3m ago"), with the unit ladder `Xs / Xm / Xh /
   Xd`. ccr never parses `basis.at`. A pane without age chrome manufactures
   currency.
4. **Absence is a named state** — no file yet (waiting), unreadable JSON,
   unsupported `v`, cannot-read, oversized: each its own labelled pane
   state, each naming the configured path (only). A configured pane never
   silently disappears from the cycle.
5. **Recovery is immediate** — a pane in any error/waiting state renders the
   healthy view on the next tick after the blob becomes valid. Error states
   are never sticky.
6. **`broken` renders as failure** — the sanitized `message`, prominently,
   with the chrome; rows ignored; never the previous healthy render.
7. **Full-height views, cycled** — external panes join the sidecar's style
   cycle as whole-pane views in **config order**, with a position indicator
   in the chrome ("2/4"). Two config entries with the same path are two
   panes. Config paths are absolute or `~`-expanded; a relative path
   resolves against the config file's directory.
8. **In-pane overflow never silently truncates** — rows beyond the pane
   height collapse to a final "+N more" line that inherits the **worst**
   status among the hidden rows (worst = alert > dark > warn > ok > off).
   A hidden `dark` row must still be visible as darkness.

## Action keys (F2/F3-style)

The wrapper's hotkeys — F2 sending `/clear`, F3 typing an orientation prompt
into the Claude pane — return as a **host capability**, configured beside the
pane paths. The trust rule: **the text a key injects, and the label a key
displays, come from user-authored configuration only.**

- ccr config maps a key to either a literal string or a **prompt file
  path**. Prompt files are resolved and validated at config load: they must
  be regular files, owner-writable only (group/world-writable or symlinked
  files are rejected), and must NOT live under any configured blob's
  directory or inside a repository working tree — a repo-local prompt file
  would let anyone who can merge a PR type into the agent session.
- Injection semantics are pinned: the text is typed **literally** (never
  interpreted as key names), newlines flattened to spaces, exactly one
  submit keypress at the end — the `inject-orient.sh` discipline, now
  normative.
- The target is the Claude pane's **pane id captured at launch** (`%N`),
  never a relative index like `.0` (which retargets after any split or
  swap). If that pane is gone, the key refuses with a visible notice
  instead of typing into whatever took its place.
- **Destructive actions are confirm-gated.** A key whose text is `/clear`
  (or any text the user marks destructive in config) requires a
  confirmation keypress; a stray F2 must not be the most expensive
  keystroke in the system.
- **Blobs never carry injectable content.** The blob is display-only: any
  action-like field in a blob is ignored, never bound, never displayed as
  an action label.

## Non-goals (v1)

- Whole-pane bespoke layouts (the wrapper's `tree-art`) cannot be expressed
  in rows. If field use demands them, the path is renderer modules shipped by
  producers (the wrapper's plugin model) *behind this same blob* — additive,
  no v-bump.
- ccr never triggers the producer. A stale blob is displayed as stale; the
  human or their agent decides to re-run the producing step. (For
  gherkin-trace this is contractual: reads must never acquire side effects.)
- The blob is **ephemeral state, not a committed artifact** — determinism
  over unchanged sources is still required of producers (it is what makes
  the blob trustworthy evidence), but the blob is not diffed in git; the
  producer's report is the committed surface.

## Known consumers and producers

- Producer: `gherkin-trace` — `.gherkin-trace/sidecar.json`, written by
  `gt refresh`; `basis.label` is `refresh`. Row floor: every signal family
  gt can name as dark/withheld/absent appears as a row (binding, fence,
  heat incl. withheld, exceptions/degradation); further rows are producer
  discretion. Conformance is pinned in its `features/design/` tier.
- Producer (planned): `treecontext` — blob beside its store; basis moment to
  be ruled by its own contract (hook-drain time is the candidate).
