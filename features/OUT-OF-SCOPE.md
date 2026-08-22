# The git pane — what it is not

The fence for the five `git-*.feature` files, confirmed by the visionary on
2026-08-04. Scope that was **declined** is as load-bearing as scope that was
accepted: everything here came up during the interview and was deliberately
left out, so a later reader can tell a decision from an oversight.

## Excluded by decision

| Excluded | Why, in the visionary's terms |
|---|---|
| Every git *operation* — stage, commit, branch, checkout, stash, push | View only. "Since the agent is so good at git cli operations, a view only is fine." |
| Stash contents, remotes, tags, submodules, blame, diffs | Never raised. The pane is identity, working tree, and recent history — nothing more. |
| Any notion of intent — what you are "headed towards" | Confined to strictly git. Git records what happened, not what was meant; the pane does not guess. |
| Colour and glyph choices | Presentation detail below the contract. |

## Deferred to implementation

Raised during the interview, steered out of behavior space, and left for the
build to decide. None of these change what the pane shows.

| Deferred | Note |
|---|---|
| Built-in `.git` reader vs. an external producer writing a pane blob | A real fork — the second reuses `docs/PANE-CONTRACT.md` and its hostile-renderer threat model, the first needs no second thing installed. Decide at build; the contract is written to be satisfied by either. |
| Whether a `git` binary is ever invoked | The contract states the pane never writes and holds no capability to run a command. How the data is *read* is a build decision inside that fence. |
| Refresh cadence and the cost of a redraw | Implementation, unless a stated staleness rule is wanted later. The safety feature pins only that a redraw must not wedge the sidebar. |
| Exact truncation arithmetic | The contract pins the observable — one row, within the pane width, file name preserved — not the column maths. |

## Roads not taken

Declined scope fences the outside; **rejected options pin the inside**. Each
ruling below was put to the visionary as 2–4 genuinely different options, and
the ones not chosen are recorded here with why — so a later agent finds a
decision where it would otherwise find an open question and re-open it.

Reconstructed 2026-08-05 from the event-time session journal (session
`2c73ac52`, 2026-08-04), which holds every option as it was offered and every
answer as it was given. Quoted reasons are the visionary's own words; where no
reason was stated aloud, the entry says so rather than inventing one.

### The commit view — *multi-lane ASCII graph*

> "matching the many IDE out there and their git graph views (or a semblance
> since this is ascii art) would make it more comfortable for devs that are used
> to having that at their fingertips."

Ruled against a rendered mockup at true sidebar width, not against prose.

| Rejected | Why not |
|---|---|
| Flat commit list | No topology at all. Cheapest to read and least to go wrong at 35–45 columns — and it is precisely the IDE habit the visionary was matching that it fails to serve. |
| Single-lane spine | Merges get a marker but never a second lane: topology acknowledged, never drawn. Half the habit, none of the picture. |
| List plus a state header | Counted topology (branch, ahead/behind, branch count) instead of drawn topology. Trades the thing that was asked for to buy density. |

**This choice is why `git-commit-graph.feature` has a lane-overflow scenario at
all** — the multi-lane graph is the only one of the four that can run out of
horizontal room, and a graph that silently dropped branches would be worse than
the list it replaced.

### Which repo a tab's pane shows — *follows the session, launch repo pinned*

No reason was stated aloud; the choice is the only one of the four that keeps
both properties the vision named — a tab whose identity is stable, and a pane
that never describes somewhere the session has left.

| Rejected | Why not |
|---|---|
| Fixed at launch | Never changes for the pane's life. Always matches the tab you opened, and quietly describes the wrong repo the moment the session moves. |
| Fixed, but flags straying | Keeps the tab guarantee and admits the move, but still refuses to tell you where the work actually is. |
| Follows the session | Always describes what is being edited, and the tab loses the stable identity that was the whole complaint. |

### How much of the working tree — *counts plus a flat file list*

> "i also can't remember what i have finished and what i'm headed towards."

Also ruled against a rendered mockup.

| Rejected | Why not |
|---|---|
| Counts only | One row, leaving the graph nearly the whole pane — tells you there IS uncommitted work, never what. |
| Grouped by state | The IDE source-control shape, and the most informative. Costs the most vertical space, and it competes with the graph the visionary had just chosen. |
| Clean/dirty only | A single indicator beside the branch. Answers "is anything uncommitted" and nothing else. |

**This choice is why the long-list case has a stated cap** rather than being
left to run: a flat list and the graph compete for the same rows.

### The three coverage axes — nothing was declined

At Phase 3 the visionary was offered four cross-surface behaviours, four
quantity extremes, and four odd repo states, and **took all twelve**. There are
no rejected options at these axes, which is recorded because it explains the
shape of the corpus: five feature files rather than three, and a safety feature
that exists because "never wedging the sidebar" and "untrusted repo text" were
both accepted rather than traded away.

### Settled before the interview began

- The pane is an **extra view cycled alongside the economy panel**, never a
  replacement for it.
- It is **git only**: "This is for git view only… i have several ccr going at
  one time and the tabs on my terminal app only show the instance name, not the
  repo so i can't tell where i'm at when i have up to 6 tabs going."

## Debt this contract deliberately carries

**`git-pane-safety.feature` has no `@security` tags yet, and four of its
scenarios must gain them when their steps are bound.** `test/security-tags.test.js`
refuses to let a `@security` scenario sit unbound — it ignores `wip` entirely,
because a gate `wip` can switch off is not a gate. Tagging them now would have
claimed a guarantee the pane cannot make while it does not exist. The gate's own
message names the only honest options: bind the step, or drop the tag
deliberately. This is the deliberate drop, recorded so it is a debt rather than
an omission.

The four that earn the tag: both escape-sequence scenarios, the unreadable-repo
scenario, and the never-writes scenario.

**Five link-fixture tests, and one ratified `@security` scenario, do not run on
a Windows machine without Developer Mode.** `fs.symlinkSync` needs a privilege
ordinary Windows users do not hold, and a symlink pointing at a FILE has no
unprivileged equivalent there: a junction cannot target a file, and a hardlink
inverts the property under test, since writing through one *does* reach the
target. Substituting either would turn a real guard into a green test proving
its own negation, so those tests are skipped by name, with a reason the reader
can act on, and they run normally wherever the privilege exists — an elevated
shell, Developer Mode, or a CI runner. Directory targets are unaffected: a
junction realizes them faithfully and they run everywhere.

The scenario carrying the debt is `pane-blobs.feature`'s "A symlink at the blob
path is refused, never followed". It is recorded here rather than silently
degraded, because a scenario whose steps quietly no-op still reports as
passing — which is what had already happened, unnoticed, to the sibling FIFO
scenario in the same file. Both now announce that they declined and why.
Specified by `features/design/test-link-fixtures.feature`.

## Deferred to the design tier

Anything platform-specific the build needs goes to `features/design/`, run by
its own `runFeatures` call with its own `wip` register, and **outside this
review contract**. The visionary reviews `features/` and only `features/`.

Candidates already visible: git index format parsing, packed-refs handling,
graph lane assignment, and per-terminal escape handling for the ASCII drawing.

## Separate work, not part of this feature

| Item | Note |
|---|---|
| Three proposed `/scope` skill changes | A cross-surface forcing axis in Phase 3, a handoff paragraph on green-but-vacuous bindings, and a positive falsifiability test to sit under `vague-then`'s six-word blocklist. Proposed during this run; **actioned 2026-08-04** — all three landed in the skill (Phase-3 surface axis; `layers.md` + a second visionary role in the handoff; the per-Then "name the failing world" test). Vocabulary ruled: `cino:<layer>` addresses for the hollow family, `blind:surface` for the absence family. |
| Read-only commands targeting slot 1 | `ccr economy`, `doctor`, `resume`, `cycle-view` and `sidecar --hint` all hard-target the first instance. Surfaced by the instance-slot review, needs its own ruling, and touches this pane only if it ever grows a CLI surface. **Ruled 2026-08-06** by the instance-layout interview below: the resolution chain plus the three-command `-i`. |

---

# The instance layout — what it is not

The fence for the six `instance-*.feature` files, confirmed by the visionary
on 2026-08-06. The vision: a second `ccr` must never destroy the first's
session; slots and the container layout ship together as 0.4.0 because
shipping slots alone would make a numeric dir under `~/.ccr` permanently
ambiguous between an instance and a CCS profile.

## Excluded by decision

| Excluded | Why, in the visionary's terms |
|---|---|
| The global config file's contents | Theoretical — it has no fields today, and a config with no contents cannot produce a non-vacuous scenario. Inherited ruling for whoever scopes it later: its canonical example carries `"//"` notes, and any note stating a behavior must be asserted by something that fails when the behavior changes. |
| A CCS profile literally named `profiles` or `instances` | "No other users will have this problem." The general safety property (migration stops and changes nothing on an unexpected source) makes it fail loudly for free. |
| What MCP servers share between instances | Outside ccr's contract — ccr launches Claude Code and cannot specify what other tools share. The adjacent guarantee stays in scope: launching modifies no configuration file. |
| Migration's removal at 1.0.0 | A future release's work, marked here so it is a plan rather than a leak. |
| Animation anywhere | Nothing ratified needs it. The sidecar owns a 1-second redraw tick if a future scoping ever wants it; the status line does not and cannot. |
| `-i` on doctor | Doctor's value is looking at everything — narrowing it invites "doctor said fine" while the sick instance was the unnamed one. |

## Deferred to implementation

| Deferred | Note |
|---|---|
| The session log's file shape (per-session files vs one shared file) | The visionary is explicitly indifferent: "whatever is easiest to work with." The observable contract is shape-independent (kept through day 30, gone at 31, counted from session end). Constraints the builder inherits: the join key must not live at the head of a size-capped file (burnlog capping drops the head); the log is account-scoped with several live writers, and Windows is supported; with per-session files, last-write mtime equals death time for free. |
| How the title is set (tmux set-titles vs direct OSC; the editor path differs) | Mechanism below the contract. |
| How the status line learns the current cwd per render | Claude's status JSON carries cwd; mechanism either way. |
| Migration's internal move order | The contract pins the observables: `.layout` written last, move-if-present, stop-and-change-nothing on surprise. |

## Roads not taken

### Identity and naming

| Rejected | Why not |
|---|---|
| Hash IDs | Ephemerality removed collisions between non-concurrent instances; identity is the slot number, the name a label on top. |
| Deriving `a-cc1`-style names from the profile | Does not survive contact: the title then reads `cc1 / a-cc1`. |
| Profile-scoped names with compound address (`-i cc2/a`) | The name is the address, and addresses are unique alone; the redundant suffix (`cc2 / a2`) is accepted instead. |
| Account-bounded name resolution | Names are globally unique among live instances, so an account bound makes some names unreachable and enables no reuse — cost, no benefit — and there is no clean way to name an account. The safeguard instead: every instance-targeted command heads its output with the name it resolved to. |
| Mapping an explicit `--name` like a derived one | A derived name is mapped (the user didn't choose it); an explicit one is rejected (they typed it, and a human is right there). Message matches the launcher's existing profile error. |

### The title

| Rejected | Why not |
|---|---|
| Three-part `cc1 / a / a-is-awesome` | Terminals truncate the end — the part the user chose. |
| Bare explicit name without the profile | Drops the account indicator, the half that disambiguated by accident today. |
| Title follows a mid-session `cd` | The address churns, title stops matching the name `-i` accepts, and two tabs can silently re-collide mid-session. |
| Composite `a → b` title on straying | Spends scarce title width on live state the pane and status line already show. |

### Orientation (the status line identity)

| Rejected | Why not |
|---|---|
| Passive marquee scrolling | Claude re-renders the status line per turn, not on a clock — a marquee advances erratically while busy and freezes at an arbitrary offset exactly when the user is idle and orienting. Frozen mid-scroll cuts both ends. |
| Alternate flashing (name ⇄ repo) | Same cadence problem backwards: flickers fastest while typing, stops when idle. The status line is plain text by design, so a "flash" could only be content swaps. |
| Ambient identity row in the sidecar (top or bottom) | Both rendered at true width and declined for the status line: "at the bottom makes the most sense, because that's where someone is typing and knowing which session they are in reduces errors." |
| `·` as the identity separator (`gitrepo2 · gitrepo`) | The status line already joins its segments with ` · `, so the identity pair read as two unrelated segments. Replaced by `@` — "so it's clear instance vs directory." |
| `/` as the identity separator (`gitrepo2 /gitrepo`) | The title already uses ` / ` to mean profile-then-name; reusing it as name-then-location flips the order semantics of the same glyph on adjacent surfaces, and the tight form reads as a rooted path. One meaning per glyph: ` / ` profile, ` @ ` at-location, ` · ` segment. |

### Lifecycle and retention

| Rejected | Why not |
|---|---|
| Heartbeat-staleness deletion, any threshold | Suspend, swap and Ctrl-Z all silence a live session's heartbeat; a threshold long enough to be safe across a weekend is still wrong. Deletion needs a dead process (signal-0 probe); the 5s window stays display-only. |
| Never auto-deleting | Breaks "literally deleted after exiting" exactly for the crashes where cleanup matters. |
| A 127 live-instance cap | The account meter merge caps at 32 siblings, so beyond 32 the shared meters silently under-report and which 32 win is readdir order. 32 keeps the shipped guarantee exactly true. |
| The 7-day retention floor (every form: enforced, test-only injectable, documented invariant) | The floor protected against a degradation that cannot occur: burn history is write-only in the shipped product — every meter and rate derives from the live status snapshot, and the only reader of burnlog files is the offline backtest script. The 30-day rule stands alone and falsifiable. |
| 90-day retention with honest degradation | Claude Code's own transcripts live ~30 days here; 90 would mean ~60 days of join keys pointing at deleted transcripts. |
| Reading Claude's `cleanupPeriodDays` | Couples ccr to someone else's setting name and location. |
| Writing the join key only at exit (sweep reconstructs, or clean-exits-only) | "Even partial information allows forensic reconstruction of what happened." Deaths are exactly when writes can't be trusted, so the key is written at first status capture and finalized by exit or sweep. |

### Survival and migration

| Rejected | Why not |
|---|---|
| Keeping a `profiles/` tree in the layout | Its only persistent content was misplaced burn history; the namespace job is subsumed by slots; and keeping it preserved the same-profile kill-session collision. "Remove the unnecessary directories." |
| Always showing the status line's location half | "notes @ notes" says nothing twice; the location appears only when it differs from the name (git pane precedent). |
| A blanket "all current behavior survives" ruling | Retired as redundant, not wrong: the feature corpus is the survival contract — layout-touching Givens get updated and a broken behavior turns its scenario red. The blanket added nothing where the corpus covers behavior, and saved nothing where it doesn't (doctor was the proof of both halves). |
| Enumerated survival scenarios per discovery surface | Two of the three container-scanning surfaces were already pinned by existing scenarios before the enumeration was proposed; the third (doctor) got the one new scenario instead. |
| Ghostty-style `key=value` config format | JSON, settled twice over: no new parser or attack surface ccr-side, and "any modern coding agent can parse json all day." (A prior claim that JSON forbids comments was wrong — `"//"` keys parse and load through ccr's real loader; that void reopening condition must not be resurrected.) |
| Adopting 0.3 leftovers as `instances/1` | Contradicts ephemerality and reinstates stale slot numbers; leftovers are swept, burn history merges for free. |
| Refuse-and-name / rename-aside / nest for a `profiles`-named profile | Declined with the case itself — the general stop-and-change-nothing property covers it. |

## Debt this contract deliberately carries

**No `@security` tags yet.** `test/security-tags.test.js` refuses an unbound
`@security` scenario and ignores `wip` — a gate `wip` can switch off is not a
gate. The scenarios that earn the tag when their steps bind: the
character-mapping outline and the illegal-`--name` rejection in
`instance-naming.feature` (the terminal-title injection guard — the mapping
constrains the character set, which the sanitizer's blocklist cannot), and
the container-refusal scenario in `instance-resolution.feature`. Recorded
here and in the files so it is a debt rather than an omission.

**Drafted-not-ruled, flagged for the review gate** (each follows from ruled
material but was never put as its own question):

- "An explicit name colliding with a live instance is refused"
  (`instance-naming.feature`) — from the ruled asymmetry and the uniqueness
  `-i` depends on.
- "Two instances launched from the same directory are listed, not guessed"
  (`instance-resolution.feature`) — the collision-suffix ruling creates this
  world; a containment tie falls through to the list-and-refuse branch.

**Open questions the adversarial pass surfaced — all three now ruled
(2026-08-06, same day):**

- **The 33rd launch refuses.** The pre-layout fallback (the shared `~/.ccr`)
  is a container now, and the old worst case was the reported bug.
- **The status line's location half appears only when it adds something** —
  repo name inside a repository, directory basename outside, live either
  way, dropped when it equals the instance name. The same rule the git pane
  ratified for launch names.
- **There is no profiles/ tree — every launch is a slotted ephemeral
  instance.** Verified before ruling: the only persistent content 0.3
  profile dirs ever held was account burn history, misplaced there because
  the logger writes to the state dir; everything else was a dead session's
  droppings. The profile survives as a launch parameter (selects the ccs
  account), the title prefix, and a join-key field. Bonus the removal buys:
  two same-profile launches collided on session `ccr-<profile>` and
  kill-sessioned each other — the reported bug, still shipping for the
  profile path; slots for every launch end it.

**Bound scenarios whose text changes at build, sanctioned here** (a
`cino:spec` temporal check should find this record, not a silent
weakening): `instance-slots.feature` — "The only instance keeps the
historical namespace" and "Slot 1 catches up to a busier slot on the same
account" (slot 1 is no longer `~/.ccr` itself); "With every slot busy the
launch still proceeds" (flips to refusal); "Naming a CCS profile assigns no
slot" (flips — profile launches now slot); "A slot number that is also a
CCS profile name is skipped" (moot — no profile dirs to collide with).
Profile session names change from `ccr-<profile>` to `ccr-<n>`; a
`tmux -L ccr-cq attach` habit breaks, accepted with the ruling.

**Two bound scenarios change text at build, sanctioned here:**
`instance-slots.feature`'s "The only instance keeps the historical namespace"
and "Slot 1 catches up to a busier slot on the same account" both state that
slot 1 IS `~/.ccr`. The container/member split abolishes exactly that — the
root cause ruling of this interview. Their text updates with the layout; this
paragraph is the ratification record a temporal comparison should find.

## Deferred to the design tier

Anything platform-specific goes to `features/design/`, run by its own
`runFeatures` call with its own `wip` register, outside this review contract.
Candidates already visible: the session-log file shape and its concurrency,
title-setting mechanics per terminal, statusline width arithmetic, migration's
rename/copy semantics across filesystems.
