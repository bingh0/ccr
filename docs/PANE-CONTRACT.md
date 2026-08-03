# External pane blobs — the sidecar integration contract (v1)

The ccr sidecar can host **external tool panes**: full-height views rendered
from small JSON blobs that other tools write beside their own artifacts. ccr
reads the file, validates it against this contract, and renders it — that is
the entire acquisition path. No subprocess, no database, no producer code, no
schema knowledge of the producing tool.

This is the durable seam recovered from the original wrapper sidecar: a pure
renderer over a normalized status blob. The part that did not survive — the
renderer shelling into the producer's SQLite from the draw loop — is replaced
by the producer computing its own blob at its own natural moment (a refresh, a
drain, a run) and dropping it as a file.

```
tool's own artifact dir                      ccr sidecar
┌───────────────────────┐   user config     ┌──────────────────────────┐
│ .gherkin-trace/       │   lists paths     │ read file bytes          │
│   sidecar.json  ──────┼──────────────────►│ verify · sanitize · draw │
│ (written atomically   │                   │ (style cycle, chrome)    │
│  by the tool itself)  │                   └──────────────────────────┘
└───────────────────────┘
```

**Discovery is user configuration, not convention.** Producers never know ccr
exists; ccr never guesses paths. The human wires the join, exactly like Claude
Code's `statusLine` wiring. Neither side takes a dependency on the other.

## Threat model

The pane subsystem sits in the same terminal as an agent session that can run
commands. Two threats follow, and only one of them is containable by rules
written inside the renderer.

**T1 — hostile input.** The blob file and anything that flows into it. ccr's
own code is intact; the bytes are not. Fully containable — the rest of this
section, plus [the verifier](#the-verifier), is how.

**T2 — hostile renderer.** The rendering code itself is attacker-controlled: a
producer-shipped renderer module, a compromised dependency, a supply-chain
hit. **No rule inside the renderer survives T2** — the attacker rewrites the
rules, and nothing in Node stops that process reattaching to the multiplexer
socket at its predictable path. T2 is therefore contained *structurally*, by
ccr never executing code it did not ship. The blob is data, permanently (see
[Non-goals](#non-goals-v1)), and the renderer holds no capability it does not
need in order to draw.

### Structural invariants (T2)

The pane subsystem runs inside `src/sidecar.js`, whose entire module graph
imports exactly three Node builtins: `fs`, `path`, `os`. That is the security
property, and it is gate-enforced rather than merely observed:

- **No process capability.** Nothing reachable from `src/sidecar.js` imports
  `child_process` or any network builtin (`net`, `http`, `https`, `dgram`,
  `tls`). The renderer cannot exec and cannot connect.
- **No input channel.** The sidecar never reads stdin. Terminal-response
  channels and echoed keystrokes are structurally dead rather than filtered.
- **No foreign code.** No path from configuration, a blob, or a producer is
  ever `require`d. A pane is data all the way down.

These are asserted against the module graph itself, so they hold even if every
line of rendering logic beneath them is rewritten — which is exactly what a
behavioural test cannot promise.

### Untrusted strings (T1)

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
  `src/sanitize.js` invariant already pinned for transcripts), then truncated
  to 512 chars and clamped into width-limited single-line cells. No blob byte
  may reach the terminal uninterpreted — this closes output spoofing, OSC 52
  clipboard writes, title-report keystroke escalation, and chrome forgery in
  one rule.
- Error states (invalid, unreadable, unsupported version, oversized,
  cannot-read) name the **path only** — never file bytes, never parser
  messages that quote content.

**Sanitizing bytes does not make claims true.** A conforming blob still
authors its own text, and may render `fence · clean · ok` while lying. Nothing
here fixes that; the required chrome — `tool`, `basis`, and the file's write
age — is what bounds the lie by making it attributable and dateable. That is
why all three are mandatory rather than decorative.

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
- Size caps are **resource** limits: a blob file over **256 KB**, or one
  carrying over **256 rows**, renders the named "oversized" state (path
  only). An over-long *display field* is **not** an oversize condition — it
  is truncated to 512 chars and clamped to its cell (see Trust model).
  Letting one long string blank the whole pane would hand anyone who can
  influence a single label a denial-of-display primitive; clamping costs a
  cell, refusing costs the pane.

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
`ok` nor `broken` fails validation and renders the invalid state.

## The verifier

Between the file bytes and any renderer sits **one choke point** that turns a
byte string into either a validated v1 blob or a single named failure. No
renderer ever sees unvalidated input — the same discipline `src/sanitize.js`
already applies at ccr's other ingestion points.

The pipeline, in order:

1. **Size-capped read** (see [consumer obligations](#ccr-consumer-obligations))
   — `lstat`, regular file only, byte cap enforced before the read completes.
2. **`JSON.parse`** — any throw is the `unreadable` state.
3. **Shape validation** — this section.
4. **`stripControl`** on every display string — validation checks *shape*,
   never bytes, so sanitizing must come after it and must be unconditional.
5. **Truncate to 512 chars, then clamp to the cell.**

Validation rules:

- **Whitelist-construct, never mutate.** The validated blob is a *fresh*
  object built by reading only the fields v1 names. The parsed input is never
  spread, `Object.assign`ed, or otherwise merged into a result — that is the
  prototype-pollution path, and it is the one injection-style attack a JSON
  consumer in Node hands out for free.
- **Total function, never throws.** Validation returns a result; it does not
  raise into the draw loop. A blob that crashes the pane every tick takes the
  burn-rate display down with it, because the sidebar is one pane — a
  malformed file must cost a pane state, never the sidecar.
- **Types are checked, not coerced.** `v` an integer; `tool`, `title`,
  `status`, `basis.label`, `basis.at` strings; `rows` an array; each row's
  `label`, `value`, `status` present and of type. `spark` is the exception,
  because it is decoration: entries must be **finite** numbers (`1e400` has
  no JSON literal but still parses to `Infinity`) to *render*, but a
  non-conforming spark is a **local** failure — the row draws without its
  sparkline (the field rule above) rather than invalidating the blob. Like
  clamping an overlong field, a decoration never costs more than itself.
- **One named failure.** Every shape violation — a missing required field,
  `rows` not an array, a row without a `value`, a top-level `status` outside
  the enum, `status: "broken"` with no non-empty `message` — renders the
  single **`invalid`** pane state, naming the configured path and nothing
  else. This is deliberately one state rather than a taxonomy: a taxonomy
  invites error text that quotes the input.
- **Unknown fields are dropped, not rejected** — the forward-compatibility
  promise above. Dropping falls out of whitelist construction for free.

`invalid` is distinct from `unreadable` (JSON did not parse), from
`unsupported version` (`v` parsed, ccr does not know it), and from
`cannot-read` (the file could not be opened as a regular file). A reader
seeing `invalid` knows the producer wrote something well-formed and wrong.

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
   invalid shape, unsupported `v`, cannot-read, oversized: each its own
   labelled pane state, each naming the configured path (only). A configured
   pane never silently disappears from the cycle.
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

## Hotkeys are a host capability, never a pane capability

The wrapper's hotkeys — F2 sending `/clear` to the Claude pane — return, but
they live **in the launcher, outside the renderer**. Typing into the agent's
pane is the single most dangerous capability in this system, and rendering
does not require it. Keeping the two apart is what makes the structural
invariants above true: the moment the sidecar owns a hotkey it must read
stdin and exec `send-keys`, and it gains exactly the two capabilities it now
provably lacks.

**The trust rule: configuration chooses the key; ccr's own code chooses the
text.**

- **The text is a compile-time constant.** No prompt files, no configurable
  strings, no path resolution, no permission checks, no working-tree
  heuristics — that entire validation surface is never built, and so cannot
  be got wrong. The full set of hotkeys is readable in ccr's source.
- **Configuration may enable, disable, or rebind *which* key** — a selection
  from a closed set. It may never supply or alter *what is typed*.
- **The launcher binds; the renderer never participates.** For the tmux host
  the binding is appended to ccr's own per-session run conf at launch
  (`scripts/launch.sh`), and tmux performs the keystroke. `src/sidecar.js`
  reads no key and sends none.
- **Target the pane id captured at launch** (`%N`), never a relative index
  like `.0`, which silently retargets after any split or swap. If the
  captured pane is gone, the key does nothing rather than typing into
  whatever took its place.
- **Destructive keys are confirm-gated.** `/clear` discards context; a stray
  F2 must not be the most expensive keystroke in the system. On tmux this is
  `confirm-before`, so the gate costs no ccr code.
- **Injection semantics** (for any host that gains keys later): text typed
  literally, never interpreted as key names; newlines flattened to spaces;
  exactly one submit keypress.

**Host scope (v1): tmux only.** `src/launch-win.js` and `src/launch-vscode.js`
have no key path at all — Windows Terminal bindings would mean editing the
user's own `settings.json`, and VS Code's integrated terminal offers no
pane-injection mechanism. Those hosts render panes and bind nothing. A host
without a captured pane id has no hotkeys; it does not get an approximate one.

### Blobs can never propose, label, or bind a key

Not "blob-supplied actions are validated" — **there is no path from blob
content to a key binding at all.** A blob cannot bind a key, cannot suggest
one, cannot render a label claiming one exists. Any action-like field is
dropped by whitelist construction and displayed nowhere.

This is not an extra restriction; it is what makes the contract
self-consistent. [Non-goals](#non-goals-v1) already says ccr never triggers
the producer — a blob-proposed hotkey would have contradicted it. A producer
that wants a refresh gets the honest version: the pane shows its age, and the
human or their agent runs the producing command themselves.

## Non-goals (v1)

- **PERMANENT FENCE — producer code never runs in ccr's process.** Not in
  v1, not behind a flag, not as an opt-in later. No renderer modules, no
  plugins, no `require` of any producer-supplied path. This is the entire
  containment for T2: every other rule in this document is written by the
  renderer and therefore worthless the moment the renderer is not ours. The
  blob is data, and data is the whole interface.

  The cost is real and accepted: whole-pane bespoke layouts (the wrapper's
  `tree-art`) cannot be expressed in rows and are therefore out — for good,
  not for now. A producer wanting a richer view has one route, which is to
  propose an additive *data* shape here (new optional fields, ignorable by
  older ccr) that ccr's own renderer draws. Expressiveness is negotiated in
  this document; it is never delegated to the producer's code.
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

Other producers need no registration here: any tool that writes a conforming
blob and gets wired in by user config is a producer. ccr's obligations do not
change per producer, so this list is illustrative, not an interface.

## Ruling log

**2026-08-01** — confirm-gate stands; prompt files resolved from the user
config dir only, with a per-path repo-local opt-in deferred; gt's row
inventory as drafted.

**2026-08-02** — threat model tightened: *assume the renderer is hostile.*

- **Supersedes the prompt-file ruling above.** Configurable injected text is
  gone entirely rather than validated more carefully — no prompt files, no
  literal strings from config, and so no permission checks, path resolution,
  or working-tree heuristics to get wrong. Configuration chooses which key;
  ccr's code chooses the text. The deferred repo-local opt-in is moot.
- Hotkeys move out of the renderer into the launcher, keeping the sidecar's
  structural invariants (no exec, no network, no stdin) true. Host scope is
  tmux only in v1.
- Producer-shipped renderer modules become a **permanent fence** rather than
  a deferred v2 option — that fence is the whole containment for T2.
- A verifier is required between bytes and every renderer, collapsing all
  shape failures into one named `invalid` state.
- An over-long display field clamps; it no longer voids the pane as an
  oversize condition (that would have been a denial-of-display primitive).

**2026-08-02 (later)** — the config surface, open since session e2994e0d, is
ruled; the subsystem is implemented and its feature files bind.

- **Location: `$XDG_CONFIG_HOME/ccr/config.json`**, defaulting to
  `~/.config/ccr/config.json`, overridable by `CCR_CONFIG`. Not ccr's state
  dir (`~/.ccr`), which ccr rewrites every second — user-authored text kept
  there is one clobber from gone. **Never repo-local, and never discovered by
  walking up from the working directory**: a config a repository could carry
  would let anyone who lands a PR add a pane to a teammate's sidecar, which is
  the same reasoning that removed configurable prompt files. `src/pane-config.js`
  never consults `process.cwd()`, and a feature scenario asserts it.
- **Format: JSON**, shape `{ "panes": [ { "path": "…" } ] }`. JSON because ccr
  already parses JSON at every ingestion point, so this adds no parser and no
  new attack surface, and the verifier discipline applies unchanged. Entries
  are objects rather than bare strings so a later optional key is additive.
  Order is cycle order; identical paths are not de-duplicated.
- A malformed config yields **no panes**, never an exception — the economy
  panel must survive a typo in a config file.
- **Cycling is a signal, not a keystroke.** External panes are whole-pane
  views selected by an index the host advances via `SIGUSR1` (`ccr cycle-view`,
  bound to F3 by the launcher). The sidecar still reads no stdin, so the
  structural invariant holds; a signal carries no payload, so there is nothing
  to inject. The pid is taken from the heartbeat and guarded by freshness plus
  a signal-0 probe — see `src/cycle-view.js` for the residual risk it does
  *not* close, stated rather than hidden.
- **A broken blob's rows are not validated**, only required to be an array.
  Validating rows ccr has already promised to ignore would let a stray row turn
  a producer's honest failure report into `invalid`, burying the message the
  blob exists to deliver.

**2026-08-02 (post-review)** — two amendments.

- **Supersedes the cycling bullet above.** Cycling is a request file, not a
  signal. The SIGUSR1 design was reproduced as a kill primitive: the pid came
  from the heartbeat file, the heartbeat lives in a directory anything running
  as the user can write, and SIGUSR1's default disposition is terminate — so a
  planted "<victim_pid>:<now>" aimed the cosmetic hotkey at any process of the
  attacker's choosing. No guard fixes a pid whose value and freshness both
  come from the attacker's own file. Instead `ccr cycle-view` bumps a
  monotonic counter in `<stateDir>/view-request`; the sidecar reads the
  difference each tick and advances by that many views (≤1s latency).
  `src/cycle-view.js` contains no signalling code at all, and a feature
  scenario asserts that structurally. Forging the request file now buys an
  attacker exactly what the hotkey buys the user: a different pane on screen.
- **The producer list is illustrative, not an interface.** The "planned
  producer" entry is removed from "Known consumers and producers": ccr
  neither knows nor needs to know who produces blobs. Any tool that writes a
  conforming blob and gets wired in by user config is a producer; ccr's
  obligations never vary per producer, so nothing registers here.
