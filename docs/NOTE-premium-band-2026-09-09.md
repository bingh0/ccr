# Note: the 200k "premium" band does not show in the Claude 5 meter data

Dated 2026-09-09. A note for the burn model, not a change to it. Written
after a question the transcripts could not answer on their own, with the
data ccr itself keeps. Nothing here is bound; the numbers below are a
one-off measurement over one machine's sessions and should be reproduced
before anything in `src/burn.js` moves.

## What was asked

Whether the long-context surcharge (the "premium" band: input and output
billed at a higher rate once a request's context passes 200k tokens, as on
the 1M-context Sonnet 4.x builds) still applies to Fable 5.1, Opus 5 and
Sonnet 5 on a subscription plan — and whether ccr's burn model should
carry a step at 200k.

## What the transcripts say

Nothing. Across all 29 transcripts under `~/.claude/projects` (Claude Code
2.1.251–2.1.266, 2026-08-30 → 2026-09-09):

- every assistant `usage` object carries `service_tier: "standard"` and
  `speed: "standard"`, with an identical key set below and above 200k;
- no `[1m]` model-id suffix and no long-context marker appears anywhere —
  `claude-fable-5-1` reached a 704,101-token context under its plain id;
- so there is no field a reader could flip on at 200k. The join in
  `src/transcripts.js` is unaffected either way.

## What the burn logs say

A surcharge would make the five-hour meter move faster per token past
200k. Joining `~/.ccr/burnlog-<sid>.jsonl` (meter samples) to the same
session's transcript (per-message token counts), taking only intervals
where the meter moved by ≥2 points inside one reset window and ≥90% of
the messages in the interval sat in one band:

| model | band | intervals | meter % per weighted Mtok |
| --- | --- | --- | --- |
| claude-fable-5-1 | ≤200k | 19 | 12.5 |
| claude-fable-5-1 | >200k | 37 | 6.0 |
| claude-fable-5 | ≤200k | 15 | 9.6 |
| claude-fable-5 | >200k | 5 | 9.8 |

"Weighted" is the standard API price mix, input 1 : cache-write 1.25 :
cache-read 0.1 : output 5. A 2× premium band would read as roughly double
past 200k. Neither model shows it; Fable 5.1 reads cheaper per token past
200k, which is what a cache-read-dominated tail looks like with no
surcharge. Opus 5 had one usable interval (no conclusion); Sonnet 5 has no
transcripts on this machine at all.

Caveats, so the number is not over-read: the meter reports whole
percentages; the intervals are few; the weighting is the API mix, and the
subscription meter need not follow it; the per-component least-squares
fit was unstable on this little data (collinear, integer meter), so only
the one-parameter ratio above is quoted.

## What in ccr this touches

1. **`modelWindowGuess` (src/burn.js) knows no Claude 5 id.** `fable`,
   `opus-5`, `sonnet-5` all fall through to "unknown → observed-tier
   lower bound", so a Fable session reads as a 200k window until its
   context is seen past 200k, then 400k, 512k, 1M in steps. The observed
   maximum (704k on `claude-fable-5-1`) says the window is 1M; the
   live `context_window_size` in the status JSON is the authority where
   present and already wins.
2. **`clearROI`'s fallback `w(C) = READ_WEIGHT·C + K_TAIL`** is a single
   straight line through context. The data above is consistent with that
   shape and inconsistent with a step at 200k: do NOT add a premium
   knee for the 5-family on the strength of the 4.x pricing page. If a
   calibration (`calib`) is ever fitted from burn logs, fit it per
   model, not per family — the two Fable lines differ by 2× in slope.
3. **Anything that reports cost or "premium context" to the user** (none
   today) would need a per-model table with a `null` for "no band", not
   a constant 200k.

## Reproducing

The join, in outline (pure Python, no dependencies):

```python
# for each ~/.ccr/burnlog-<sid>.jsonl: samples (t, limits.five_hour.used, resets_at)
# for the same sid under ~/.claude/projects/*/<sid>.jsonl: assistant messages
#   (timestamp, usage.input_tokens, cache_creation_input_tokens,
#    cache_read_input_tokens, output_tokens), one per message id
# walk samples; on a rise of >=2 points inside one reset window, take the
#   messages between the previous rise-point and now; band = >200k if >=90%
#   of them have input+cache_read+cache_creation > 200_000, <=200k if none do,
#   else discard the interval; accumulate (meter delta, token components)
# report meter delta / (1*input + 1.25*cache_write + 0.1*cache_read + 5*output)
```

Re-run it when a Sonnet 5 or Opus 5 session with real length exists, and
before touching `WINDOW_TIERS` or `modelWindowGuess`.
