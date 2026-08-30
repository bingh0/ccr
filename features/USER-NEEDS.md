# USER-NEEDS.md — the needs ledger for the subagent observability views

Ratified 2026-08-23 from the scope 4.1.1 interview (aBDD dogfood run).
Beneficiaries: `user` = the visionary running up to ~6 ccr instances;
`operator` = the same person wearing the maintenance hat (recorded as a fact:
they are every stakeholder here); `agent-consumer` = scripts and orchestrating
agents reading ccr's output. Weights confirmed by non-correction at the Phase-1½
readback and re-walk at Phase 5. Seven of fifteen needs arrived only through
the Phase-3¼ checklist sweep (N9–N15).

| # | Need (first person) | For | Wt | Evidence / means | Coverage | Note |
|---|---|---|---|---|---|---|
| N1 | "When my sessions fan out subagents, I want to see which exist, what each is doing, and what it's costing me — orchestration must not be a black box." | user | 5 | Root vision, ratified Phase 0 | scenario: all three files | |
| N2 | "I want to tell at a glance who's alive, who's done, and how long it's been." | user | 4 | Phase 1 outcome election | scenario: subagents-view | |
| N3 | "I want each agent's current activity without leaving my workflow." | user | 4 | words-with-age ruling; tool-call fallback ladder | scenario: subagents-view | Means recorded: latest WORDS primary (ratified twice), age marker added in adversarial pass |
| N4 | "I want per-agent token/time accounting so I know who's burning budget." | user | 3 | Phase 1 outcome election | scenario: subagents-view | Per-session only; account-wide stays with economy panel; cross-session rollup deferred to post-MVP economy upgrade |
| N5 | "My tools and agents need the same facts I see, readable by machine, read-only for now." | agent-consumer | 3 | R12 door election ("this is more an agent question") | scenario: subagent-mirror | Means ruled: CLI door, JSON, `-i` family semantics |
| N6 | "I must eventually be able to stop a runaway subagent burning my budget." | user | 5 | Verified absent upstream (#352); owner: errors are "high yield" | absence: fence entry "Steering or managing subagents" + worktree-note deferral | Full weight carried as deliberately unbuilt; a future upstream control path reopens it |
| N7 | "Observability can't cost me screen-cycling overload or steal keys from Claude." | user | 3 | S2 election; F3-only reversal | structural + scenario: rotation scenarios in subagents-view | Means ruled: fourth position, built-ins-first invariant, no new keys ever |
| N8 | "When Claude Code changes or silences a channel, my views should degrade honestly, never lie." | user | 4 | R22/R35; born from owner's channel-catalogue point (R2) | scenario: subagents-view stale banner + subagent-channels | |
| N9 | "Nothing about this feature may need persisting — restart must rebuild the truth from transcripts alone." | operator | 4 | Checklist sweep (reliability) | structural | Statelessness ratified; drives retirement-timestamp mechanism (fence constraint) |
| N10 | "A dead panel must never cost me the facts — only the glance." | user | 3 | Checklist sweep (availability) | scenario: subagent-mirror | The CLI derives independently of the panel |
| N11 | "Words render verbatim — even when they quote secrets. Masking would be false comfort." | user | 2 | Checklist sweep (security), eyes-open posture; owner ruled a direct pin 2026-08-24 | scenario: subagents-view verbatim pin + absence: fence entry "Masking secret-shaped strings" | Scenario earns @security at bind time, alongside escape-sequence |
| N12 | "I commit to zero maintenance for this feature." | operator | 4 | Checklist sweep (ops burden) | absence: no persistence, no config fields, nothing swept | Enforced structurally by N9 |
| N13 | "When the roster looks wrong rather than merely stale, --debug must tell me which channels went dark without guessing." | operator | 2 | Checklist sweep (diagnosability) | scenario: subagent-mirror debug flag | Tension with R13 resolved: debug flag is the one standing surface beyond the banner |
| N14 | "Tomorrow's Claude Code must not wedge today's view or fabricate a roster." | operator | 4 | Checklist sweep (evolvability); Task→Agent rename precedent | scenario: subagent-channels | Fail-open parsing; catalogue lives in build docs, not runtime |
| N15 | "A new spawn must reach my eyes within a tick, even mid-burst." | user | 3 | Checklist sweep (performance) | scenario: subagents-view tick scenarios + burst cap | Token counts may trail a tick under bursts |

Tension links: N6 vs N7/N12 (steering desire capped by no-upstream-mechanism reality and minimalism — resolved as absence, not partial build); N11 vs hostile-render safety (verbatim text still renders inert — both hold); N13 vs R13 (one debug flag is the entire diagnosability surface; doctor stays out).

Coverage reconciliation: every feature file appears above (subagents-view → N2/3/4/7/8/11/15; subagent-mirror → N5/10/13; subagent-channels → N8/14). No orphan files; no uncovered ledger rows.
