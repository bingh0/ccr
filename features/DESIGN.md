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
