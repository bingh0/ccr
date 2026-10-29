# DESIGN.md — the subagent observability views

Drafted 2026-08-23 by the scope interviewer for the agent that builds. The
human is the secondary reader; the feature files bind, this doc explains and
bounds. Edit doctrine: nobody edits this file outside a discussion — human
and agent iterate, the agent holds the pen, and every change appends one
changelog line naming the ruling that sanctioned it.

## What this feature is

Three surfaces, one producer: a fourth built-in sidecar view (the S2 roster),
a read-only CLI door (`ccr subagents`), and the fail-open derivation layer
underneath both. Everything derives from Claude Code's own emission records —
transcripts first among them — at read time. **Nothing is persisted, ever**
[N9]: a restarted panel or a fresh CLI call recomputes identical facts from
the same records.

## Principles the build must not cross

1. **Stateless derivation** [ruled: N9]. No cache files, no retirement state,
   no seen-agents ledgers. Retirement keys to upstream completion timestamps,
   never observation time; a completion without a timestamp never retires
   until session end (fence constraint from adversarial ruling R37).
2. **The suite cannot be quiet** (house doctrine, docs/BDD.md). Every new
   file enters `test/wip-register.js` as declared whole-feature debt and
   leaves only as steps bind; release-gate refuses publication while
   whole-feature entries stand.
3. **Fail-open upstream parsing** [ruled: N14]. Unrecognized record shapes
   are skipped by design. The Task→Agent rename (v2.1.63) must yield one
   roster. Total drift degrades to the empty truth.
4. **Negative space is contract** [ruled: N7/N12/R13]. No key beyond F3. No
   detail zone, no navigation, no auto-advance of any kind. No doctor
   section. No config fields. No persistence to sweep. The fence and
   `subagent-channels.feature` pin these absences.
5. **Verbatim words, inert rendering** [ruled: N11 + house law]. Agent words
   pass through unmasked; the hostile-renderer discipline (pane-blobs threat
   model) applies unchanged — escape sequences render inert, never execute,
   never wedge the redraw tick.

## Shape

- **Derivation layer** [chosen]: one module reads Claude Code's records and
  emits an in-memory roster model (type, task, state, age, tokens, latest
  words + word age, lineage, failure info, staleness). Both consumers render
  from it; parity scenarios in `subagent-mirror.feature` hold them together.
  Placement of the module is the builder's call.
- **The S2 view** [ruled: pane-shape election]: blocks in the shared draw
  loop's cycle at position four (economy → git → feed → subagents), built-ins
  fixed relative, optional views (treecontext/gherkin-trace) always after.
  Cap = what fits; live-first slot ownership; overflow line names live work;
  activity line = words with age marker, tool-call fallback when wordless.
- **CLI door** [ruled: R12/R40]: `ccr subagents [-i n] [--all] [--debug]`,
  JSON out, read-only, `-i` resolution semantics inherited from the command
  family (output heads with resolved name; loud refusal otherwise).
- **Stale banner**: whole-transcript silence while the session lives;
  composes with `src/liveness.js` (which owns alive-vs-dead) rather than
  duplicating it. Threshold constant builder-tunable, observable binds.
- **Channel catalogue** [ruled: N14/R13]: build documentation naming exactly
  which records are parsed and from where — not a runtime surface.

## Toolchain constraints

- Lint/dialect authority: gherkin-node-test **0.11.0** — and no longer an
  authority separate from the runner, because the vendored mirror caught up.
  `test/gherkin.js` is 0.11.0 at upstream commit e0d1ec1, so the same file
  lints and runs and a dialect obligation cannot differ between the two. The
  three files here are strict-clean under it [verified 2026-08-30].
- Elective E1 (0.10.0 dev checkout as lint authority, mirror held at 0.9.0) is
  **spent**: the build did elect to bump, twice, and the divergence E1 existed
  to manage is gone.
- 0.11.0 hands the build two obligations this feature inherits: every step
  definition must consume what its sentence parameterizes (args-consumption
  guard), and no definition may sit unconsumed by any scenario
  (unused-definition guard). Both count at registration across @skip'd,
  @todo'd and wip-held scenarios alike, so this feature's declared debt buys
  no exemption from either.
- Node floor for the linter is ≥22.17; host runs v24 [verified 2026-08-23].

## Changelog

- 2026-08-23 — initial draft (scope interview; elective E1).
- 2026-08-30 — toolchain constraints corrected. The vendored mirror went to
  0.11.0 (ccr 005937c, re-vendored at e0d1ec1 in 58a3b58), which spends
  elective E1 and retires the 0.9.0-vs-0.10.0 split this section described;
  the two new registration guards are recorded as obligations on the build.
  Sanctioned by the owner's ruling to complete the 0.11 port ahead of 0.6.
- 2026-09-01 — the stale marker appears only when the roster holds at least one
  LIVE agent. R22 defines staleness as whole-transcript silence while the
  session lives, and left open what it means over a roster that has finished:
  a fault marker on work that is simply done reports a fault that is not there.
  The clock itself is unchanged — the newest upstream timestamp across every
  channel. Sanctioned by R22 (staleness threshold and its presentation ruled
  builder-tunable, the observable binding) with the fence's deferral of the
  threshold constant.
- 2026-09-01 — the per-agent token figure is
  `input + output + cache_creation`, summed once per assistant MESSAGE rather
  than once per transcript record. Cache reads are excluded as the
  non-meter-draining component, following `DRAIN_WEIGHTS`' precedent in
  src/transcripts.js; the per-message deduplication answers a fact of the
  format rather than a preference — Claude Code splits one message across
  several records, each repeating the same `usage`, so a per-record sum
  inflates a three-block turn threefold (verified on 2.1.252). Sanctioned by
  N4 read together with the shape section's "the builder's call" on placement
  and mechanism; documented in docs/SUBAGENTS.md.
- 2026-09-01 — ONE derivation path: the CLI's full parse is the pane's
  incremental tick run to exhaustion over the same accumulator, not a second
  implementation. The shape section left the module's placement and internals
  to the builder and required only that both consumers render from one model;
  parity by construction is the cheapest way to keep the mirror's parity
  scenarios honest, since two implementations that agree today are exactly what
  those scenarios would stop catching. Sanctioned by the shape section's
  derivation-layer ruling ("both consumers render from it; parity scenarios in
  subagent-mirror.feature hold them together").
- 2026-09-01 — the FEED becomes a view. R27 ratified the rotation economy →
  git → feed → subagents → optional panes, but the feed was never a view: it
  has always been rendered in a few lines UNDER the economy panel, and
  composeFrame counted two built-ins. A full-height feed view at index 2 is the
  smallest build that honours the ratified order — it reuses `renderFeed` and
  the incremental tail unchanged, and the economy panel's under-feed is left
  exactly as it was, because that is a shipped surface and nothing sanctioned
  changing it. Built-ins therefore become four, the position marker's rule
  becomes `viewCount > 4`, and external panes index from 4. Sanctioned by R27
  (the fourth-position rotation ruling, 2026-08-23) together with the fence's
  "Sanctioned changes" section, which anticipated exactly this renumbering.
- 2026-09-01 — SLOT ARITHMETIC: the pane's row budget yields
  `floor((rows − 4) / 2)` slots, because shape S2 is two rows per agent (the
  head row and its activity row) and four rows are chrome — the instance-name
  line every frame carries, the view's own header, the overflow line and the
  stale marker. The last two are conditional and are reserved unconditionally:
  that costs at most one block and buys a roster that can never grow a line
  past the pane's last row, which is the soft wrap that corrupts the sidecar's
  cursor-home redraw. The rule lives in one exported function
  (`slotsForRows`) so composeFrame and the acceptance steps cannot disagree
  about what "four roster slots" means. Sanctioned by R15's burst cap read with
  the fence's deferral of policy defaults to the builder.
- 2026-09-01 — the token figure is ABBREVIATED with `tok` from
  src/render/shared.js (`18K`, `1.2M`), the same unit the economy panel and the
  feed already use. The scenarios pin that a block shows its token count and
  leave the presentation open; a raw six-digit integer would cost the task
  column six columns on a 40-column pane for precision nobody reads at a
  glance, and a second spelling of the same quantity on one screen is exactly
  the drift the shared helper exists to prevent. Sanctioned by the shape
  section's "presentation below the contract" note in the fence's debt list.
- 2026-09-02 — the JSON door HEADS WITH THE RESOLVED NAME AS ITS FIRST
  PROPERTY, not as a line above the object. The -i family's law is that every
  instance-targeted command names what it resolved to — the safeguard against
  reading the right panel about the wrong instance — and every other door obeys
  it with a text heading. `ccr subagents` cannot: a heading line in front of an
  object is a parse error to `jq` and to every other consumer, and this door
  exists FOR consumers. So `"instance"` is emitted first, ahead of `"stale"` and
  the roster, and the acceptance step asserts both that it is the object's first
  key and that the raw bytes open with it. `--all` labels each entry the same
  way, using `slot N` where an instance has no name, because an aggregate whose
  entries cannot be told apart answers nothing. Sanctioned by
  subagent-mirror.feature's header ruling ("`-i` family semantics inherited:
  output heads with the resolved name") read with R12's door election, which
  chose a CLI emitting JSON and therefore owes `| jq` a parseable stream.
- 2026-09-02 — THE TASK COLUMN IS THE DISPATCH `description`, not the prompt.
  R10 said "Claude's own dispatch words" and the build read `input.prompt`;
  against real sessions that is the wrong half of the dispatch, because Claude
  opens every prompt the same way ("You are the builder for batch A…") and the
  column showed one identical string down the whole roster. The description
  ("Fix installer.ts review findings") is equally Claude's own and is written
  to be glanceable, which is the column's entire job. The ladder is
  description → the metadata description (a skill-driven agent's stand-in for
  the dispatch it never had) → the prompt head-first (R19 unchanged) → the
  agent's own opening prompt → nothing, leaving the type alone (R18 unchanged).
  Sanctioned by the owner's amendment of R10, 2026-09-02, recorded in the
  fence's "Sanctioned changes" with the three scenarios it rewords.
- 2026-09-02 — FEED TOKENS ARE COUNTED ONCE PER ASSISTANT MESSAGE. Claude Code
  writes one assistant message as one record PER CONTENT BLOCK, each repeating
  the same `usage`, so `parseEvents` summing per record inflated `stats.tokens`,
  `weighted` and every figure drawn from them on any multi-block turn (measured
  on a real 1285-record session: 87.0M token-equivalents before, 41.6M after).
  Records of a message are contiguous, so the last message id is remembered and
  its contribution REPLACED rather than added — the rule src/subagents.js
  already used for an agent's own tokens. The sidecar's incremental tail carries
  that message id across ticks in `feedState`, which makes the batch a DELTA
  that may be negative; a record with no `message.id` still counts on its own,
  since without an id there is nothing to say two records are one message.
  Sanctioned by the owner's ruling of 2026-09-02.
- 2026-09-02 — `ccr resume` WIDENS ON THE POSITIONAL `all`, and `--all` is
  refused. `cmdResume` accepted both spellings, but `--all` is a globally
  declared option that only `ccr subagents` reads, so it never arrived as a
  positional and is refused loudly in `main()` — the branch was dead code that
  advertised a spelling the CLI rejects. Removed rather than supported, with
  HELP and the README stating the positional instead. Sanctioned by the owner's
  ruling of 2026-09-02: "be as correct as possible, and update documentation,
  rather than supporting the old behavior."
