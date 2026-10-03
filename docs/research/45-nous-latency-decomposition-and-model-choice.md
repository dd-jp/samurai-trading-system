# 45 — Nous latency decomposition and model-choice evidence pass

**Date:** 2026-09-14
**Question:** #1023's two threads left open by #1012/#1021 — (1) is the 15x min-to-max debate-call
spread queue wait or generation, now that ruling-out (not attribution) is done; (2) does ADR-0009's
model choice survive a fresh evidence pass.
**Status:** MEASURED. Thread 1 gets a real, positive decomposition (not just ruling-out) via a
small streaming probe. Thread 2 re-confirms ADR-0009's haiku pick; of the other five candidates,
`gpt-5.4-mini` and `qwen3.8-flash` are evaluated and rejected (tail latency, reliability), and three
reasoning-tier candidates stay unevaluated at fair settings.

---

## 0. Where this picks up

[#1012](https://github.com/dd-jp/samurai-trading-system/issues/1012) named four threads: output
budget, streaming cutoff, queue/TTFT/generation attribution, model choice, and made 1/2/4
conditional on 3's answer. [PR #1021](https://github.com/dd-jp/samurai-trading-system/pull/1021)
(merged) closed threads 1 and 2 with a ruling-out argument — the slow tail call generated *fewer*
tokens than a fast adjacent one, no client-side blocking exists in the call chain, and every slow
call was back-to-back with no idle gap — but left thread 3 open on its own terms: `ttfb_ms`
measures header-arrival on a **non-streaming** fetch, and #1021 itself flagged that Nous likely
buffers the whole completion before sending any bytes, so `ttfb_ms` may just read `≈ latency_ms`
and decompose nothing.

[#1080](https://github.com/dd-jp/samurai-trading-system/issues/1080) — a sibling ticket on the
operational consequence of the same latency, not the cause — independently confirmed that
prediction against **production** traffic: *"the `ttfb_ms ÷ latency_ms` ratio has a median of
**1.00** across all 62 calls, which is exactly the buffered-proxy reading #1023 predicts, so
`ttfb_ms` as instrumented cannot decompose the two."* That is real evidence, not a guess, and it is
the reason this doc does not re-litigate the non-streaming instrumentation.

This doc does two things: adds a small, cheap streaming probe to get a **positive** decomposition
(not just a ruling-out one) for thread 3, and re-evaluates thread 4 (model choice) against
[ADR-0009](../adr/0009-single-provider-nous.md) using the per-model table an earlier probe already
collected for #1080. Both are within the ticket's stated budget: no change to the debate call path,
`stream:true` used only in this side probe, never enabled in production code.

## 1. Primary source: the #1080 five-model latency probe (2026-09-14)

Most of the evidence for both threads already existed before this doc was written — a probe run
earlier the same day for #1080, reproduced here as the primary source. It was originally run from a
job-scratch directory outside this repo's tree (a path that would not have survived that job); the
scripts and raw output are now archived in this repo so the primary source of thread 4's verdict
does not depend on evidence living outside version control:

- Scripts: [`45-nous-five-model-latency-probe.mjs`](45-nous-five-model-latency-probe.mjs) (the main
  five-model probe), [`45-nous-per-key-vs-account-probe.mjs`](45-nous-per-key-vs-account-probe.mjs)
  (the follow-up). Both are archived unchanged from what actually ran, except for the CommonJS
  `require()` → ESM `import` conversion this repo's `"type": "module"` requires.
- Raw output:
  [`archive/raw/2026-09-14-nous-five-model-latency-probe-results.json`](archive/raw/2026-09-14-nous-five-model-latency-probe-results.json),
  [`archive/raw/2026-09-14-nous-five-model-latency-probe-stderr.txt`](archive/raw/2026-09-14-nous-five-model-latency-probe-stderr.txt),
  [`archive/raw/2026-09-14-nous-per-key-vs-account-probe-results.json`](archive/raw/2026-09-14-nous-per-key-vs-account-probe-results.json),
  [`archive/raw/2026-09-14-nous-per-key-vs-account-probe-stderr.txt`](archive/raw/2026-09-14-nous-per-key-vs-account-probe-stderr.txt).

The report below carries every number and finding from that run unchanged. Headings are re-leveled
by two levels (h1→h3, h2→h4) to nest under this section, and the two local-path lines pointing at
the job-scratch directory's `probe.js`/`followup.js`/`results.json` are dropped since that directory
itself is gone — everything else, including every measured figure, is reproduced as written.

> ### Nous debate-model latency probe — #1080
>
> No API key value was ever printed, logged, or written anywhere in this run.
>
> #### Method notes / deviations from spec
>
> - **Actual prompt size came out larger than the ~1,600-token target**: measured `prompt_tokens`
>   ranged **3,031–4,614** across models (same prompt text, different tokenizers per model/provider).
>   The char-count heuristic used to size the filler under-shot real BPE token counts. This does not
>   invalidate the comparison — every model saw the *same* prompt — but absolute latencies here are
>   for a heavier prompt than originally specified.
> - **Every candidate model resolved** (no 404s), so no alternate model ids were needed.
> - **Four of the five candidates are reasoning models that burn the completion budget on hidden
>   chain-of-thought.** `max_tokens: 300` was consumed almost entirely by `reasoning_tokens`
>   (deepseek-v4-flash: 230/300, glm-5.3-flash: 297/300, qwen3.8-flash: 300/300, gemini-3.8-flash:
>   286/296), leaving little or no room for the actual `{stance, rationale, confidence}` JSON —
>   responses came back `content: null` or truncated mid-string. **Their 0% JSON-valid rate is a
>   budget/config artifact, not proof the model can't follow the format** — it would need either a
>   larger `max_tokens`, a provider-side "disable reasoning"/low-effort flag, or a
>   reasoning-token cap before it could be fairly judged on format-following. Their latency numbers
>   are still valid and usable.
>
> #### Results
>
> | Model | Seq p50 / max (ms) | Burst(4) p50 / max (ms) | JSON-valid (seq / burst) | Reasoning-token confound | Est. cost/call | Model spend |
> |---|---|---|---|---|---|---|
> | anthropic/claude-haiku-4.5 (baseline) | 5,764 / 6,385 | 18,912 / 25,687 | 3/3 / 4/4 | none (0 reasoning tok) | $0.00465 | $0.0325 |
> | openai/gpt-5.4-mini | 6,738 / 6,855 | 26,959 / 33,560 | 3/3 / 4/4 | none (0 reasoning tok) | $0.00283 | $0.0198 |
> | deepseek/deepseek-v4-flash-0731 | 6,390 / 6,810 | 14,433 / 20,951 | 0/3 / 0/4 | yes (reasoning ate budget) | $0.00015 | $0.0011 |
> | z-ai/glm-5.3-flash | 7,254 / 7,476 | 24,229 / 33,385 | 0/3 / 0/4 | yes | $0.00030 | $0.0021 |
> | google/gemini-3.8-flash | 5,981 / 8,339 | 19,560 / 38,338 | 0/3 / 0/4 | yes | $0.00450 | $0.0315 |
> | qwen/qwen3.8-flash | 11,259 / 34,882 | 18,372 / 34,609 (1 of 4 timed out at 45,000ms) | 0/3 / 1/3 | yes | $0.00083 | $0.0050 |
>
> **Total probe spend: $0.0920** (list-price basis; under the $0.25 budget). Note: the API's own
> reported per-call `cost` field for the two BYOK-priced models (deepseek, glm) was materially lower
> than the list-price estimate above (e.g. deepseek's reported cost was $0.00005/call vs. $0.00176
> list-price-equivalent), so actual billed spend was lower still.
>
> #### Conclusions
>
> 1. **Fit inside a 120 s tick at concurrency 4, with margin:** every model's 4-way concurrent burst
>    *max* latency landed well under 120 s — haiku (25.7 s), gpt-5.4-mini (33.6 s), deepseek (21.0 s),
>    glm (33.4 s), gemini (38.3 s) all clear it with 80+ s of margin. **qwen3.8-flash does not** —
>    one of its four concurrent calls hit the 45 s timeout outright, so it can't be trusted to
>    complete reliably at concurrency 4 even though its successful calls were fast enough. Of the
>    models that fit, only **haiku and gpt-5.4-mini currently produce complete, valid JSON** at
>    `max_tokens: 300`; the other three fitters (deepseek, glm, gemini) would need a reasoning-budget
>    fix before they're usable candidates, not just a latency check.
> 2. **Haiku's soak latency reproduces outside the soak, and it's a concurrency effect, not a Haiku-
>    or orchestrator-specific defect.** At concurrency 1 this probe measured Haiku at p50 5.8 s / max
>    6.4 s — far below the soak's p50 22,882 ms / p90 27,532 ms. But the concurrent burst-of-4 alone
>    reproduces the soak numbers almost exactly (p50 18.9 s, max 25.7 s, matching the soak's noted
>    "4 in flight → ~27 s"). Every other model tested shows the same sequential→burst inflation
>    pattern (e.g. gpt-5.4-mini 6.7 s → 27–34 s, glm 7.3 s → 24–33 s), so this is a general
>    characteristic of concurrent load against the Nous endpoint (proxy-side queueing or per-key rate
>    limiting), not something specific to Haiku or to the orchestrator's own code.
>
> #### Follow-up probe: is Nous concurrency queuing scoped per key or per account?
>
> Haiku only, same prompt as above, three keys from `.env.local`
> (`NOUS_API_KEY`, `NOUS_DEBATE_API_KEY`, `NOUS_SENTIMENT_API_KEY`). No key values printed anywhere.
> Total spend: **$0.0592** (under the $0.10 budget for this follow-up).
>
> Runs executed in sequence, each burst awaited fully before the next started:
>
> | Run | Config | Per-call latency (ms) | Notes |
> |---|---|---|---|
> | A1 | 3x concurrent, all `NOUS_DEBATE_API_KEY` | 12,776 / 8,256 / 8,948 | all OK |
> | B1 | 3x concurrent, one call per key | 8,573 (`NOUS_API_KEY`) / 15,657 (`NOUS_DEBATE_API_KEY`) / 23,777 (`NOUS_SENTIMENT_API_KEY`) | all OK |
> | C | 2x concurrent, `NOUS_DEBATE_API_KEY` | 7,684 / 18,342 | all OK |
> | A2 (repeat) | 3x concurrent, all `NOUS_DEBATE_API_KEY` | 8,753 / 16,791 / 27,432 | all OK |
> | B2 (repeat) | 3x concurrent, one call per key | 8,226 (`NOUS_API_KEY`) / 41,551 (`NOUS_DEBATE_API_KEY`) / **timeout at 45,000** (`NOUS_SENTIMENT_API_KEY`) | 1 of 3 failed |
>
> Aggregated across both repeats:
> - **A (same key, n=6):** p50 ≈ 10,862 ms, max 27,432 ms, 6/6 succeeded.
> - **B (one per key, n=6):** p50 ≈ 15,657 ms, max 41,551 ms (of 5 successful calls), **1/6 timed out outright**.
> - **C (concurrency 2, same key, n=2):** 7,684 ms and 18,342 ms.
>
> **Conclusion: the queuing is scoped per account, not per key.** Splitting the 3-call burst across
> three different Nous keys (B) did not go faster than sending all 3 on one key (A) — B was equal-or-
> worse on both repeats, including the only outright timeout seen in this follow-up (B2's
> `NOUS_SENTIMENT_API_KEY` call). If the throttling were per-key, B should have been close to C's
> concurrency-2-per-key latency on every call; instead B's slowest call in each repeat matched or
> exceeded A's slowest call. Concurrency-2 (C) landed between A's (concurrency-3) low and high calls
> (7,684 ms fastest call, 18,342 ms slowest), consistent with latency scaling with *total* concurrent
> in-flight requests against the account regardless of which key carries them — the same pattern the
> main probe found scaling from concurrency 1 to concurrency 4 on a single key.

This is already enough to establish: the inflation under load is real, identical in shape across
five structurally different models, and gated on total account-wide in-flight depth rather than
per-key rate limits or the debate engine's own code. What it does not do is split one slow call into
a queue-wait component and a generation component — every number above is a single wall-clock span.

**Cost-basis note (not in the original probe text):** the cost column is on the vendors' list-price
basis, as the reproduced report labels it — the archived producer
(`45-nous-five-model-latency-probe.mjs`) prices haiku at $1.00/$5.00 and `gpt-5.4-mini` at
$0.75/$4.50 per M tokens in/out, and recomputing from the archived usage (haiku 3,511 in / 226 out)
gives $0.00464 and $0.00279, matching the quoted $0.00465 and $0.00283. Nous's actual portal rates
(`server/shared/llm/pricing.ts`'s `MODEL_RATES`: $0.80/$4.00 haiku, $0.60/$3.60 `gpt-5.4-mini`) put
the real per-call cost ~20–25% lower than the column shows; anyone pricing a model swap off this
table should apply that discount.

## 2. A real decomposition: the streaming TTFT probe (this doc, 2026-09-14)

To answer #1023's actual thread-3 question — queue wait vs generation, not just ruling out length
and cold-connection effects — this doc adds one small `stream:true` probe. `stream:true` is used
**only in this standalone script**, run manually and once; it is not enabled anywhere in production
code, and nothing on the debate call path changed.

**Constraints honoured:** at most 8 calls total (5 sequential at concurrency 1, one burst of 3);
credentials read from `process.env` only (the script is invoked as
`node --env-file=.env.local ...`, the same pattern `dist/server/apps/orchestrator/index.js` runs
under); no key value or `.env` content printed, logged, or written — the script prints only key
*length* to confirm presence. A paper soak was running against the same Nous account at run time
(confirmed via `ps aux`), which is why the burst was kept to 3, not swept, and run once.

**"Concurrency 1" here means one call in flight from this probe process, not an idle account.** The
soak was actively issuing its own calls against the same Nous account throughout this run. The
sequential arm's `ttft` (3.1–5.2 s) is therefore a floor measured against *some* background load, not
against a quiescent queue — consistent with it running slightly above the earlier #1080 probe's
non-streaming concurrency-1 p50 of 5.76 s (§1), and it means a truly idle account would likely show
an even flatter, lower `ttft` than what this probe recorded.

Script: [`45-nous-streaming-ttft-probe.mjs`](45-nous-streaming-ttft-probe.mjs). Raw output:
[`archive/raw/2026-09-14-nous-streaming-ttft-results.json`](archive/raw/2026-09-14-nous-streaming-ttft-results.json),
[`archive/raw/2026-09-14-nous-streaming-ttft-stderr.txt`](archive/raw/2026-09-14-nous-streaming-ttft-stderr.txt).

The probe times three points per call, using the same debate-persona prompt shape as the #1080
probe above for comparability: `ttfb` (headers arrive — the same event `ttfb_ms` in
`server/shared/llm/nous-chat.ts` measures on the non-streaming path), `ttft` (the first
content-bearing SSE delta), and `total` (stream end, `[DONE]`). `generation_only = total − ttft`.

### Results (haiku, same prompt shape as §1, `max_tokens: 300`)

| Call | ttfb (ms) | ttft (ms) | total (ms) | generation-only (ms) |
|---|---|---|---|---|
| seq[0] | 4,261 | 4,262 | 6,922 | 2,660 |
| seq[1] | 4,534 | 4,535 | 7,296 | 2,762 |
| seq[2] | 3,119 | 3,119 | 6,156 | 3,037 |
| seq[3] | 3,932 | 3,932 | 6,570 | 2,638 |
| seq[4] | 5,188 | 5,188 | 7,765 | 2,577 |
| burst[0] | 3,705 | 3,732 | 6,289 | 2,558 |
| burst[1] | 11,868 | 11,869 | 13,779 | 1,910 |
| burst[2] | 16,317 | 16,318 | 19,279 | 2,961 |

All 8 calls returned `status: 200`, `finish_reason: "stop"`, 110 SSE chunks, 800 chars of content —
every call completed the stream normally with no timeout, abort, or truncation. The script does not
parse the assembled content, so JSON validity of the completion (unlike §1's probe, which does check
it) was not verified here; that is not this probe's question.

### Reading it

1. **`ttfb ≈ ttft` on seven of eight calls, to within ~1 ms; the eighth (`burst[0]`) differs by
   27 ms.** Nous does not hold response headers until the completion is fully generated on the
   streaming path — the header arrives right when the first token does. That is a genuinely
   different reading from the non-streaming path, where
   #1080 measured `ttfb_ms ÷ latency_ms` at a median of 1.00: on `chat/completions` without
   `stream:true`, headers and the full body arrive together because there is nothing to stream, so
   `ttfb_ms` there is measuring the same thing as `latency_ms`. With `stream:true`, `ttfb`/`ttft`
   together measure everything that happens **before the first emitted token**, distinct from the
   token-emission phase that follows.
2. **The pre-first-token phase is exactly what inflates under concurrency; token emission does not.**
   Sequential `ttft` ranges 3.1–5.2 s; burst `ttft` ranges 3.7–16.3 s — a >4x spread appearing
   inside a 3-call burst, consistent with the account-wide queuing §1 already established.
   `generation_only`, by contrast, sits in a **tight 1.9–3.0 s band across all 8 calls**, sequential
   and burst alike, with no visible correlation to queue depth. The burst's slowest call by total
   wall-clock (burst[2], 19.3 s) has a generation-only time (2.96 s) inside the same range as the
   *fastest* sequential call (seq[2], 3.04 s).
3. **What this probe can and cannot attribute the growing phase to.** `ttft` bundles two things this
   probe cannot separate: queue admission (idle wait for a request slot) and prompt *prefill* (the
   compute cost of ingesting the ~3,500-token prompt before the first output token can be produced).
   A pure queue-wait explanation and an upstream-prefill-contention explanation (multiple concurrent
   requests' prefill passes competing for the same compute) would produce the same signature —
   pre-first-token time growing with concurrency, decode time flat. What this probe *does* establish
   cleanly is the boundary: **the growing component is everything before the first token; the
   component that stays flat is token-by-token emission after that.** That is a positive attribution
   #1021's ruling-out argument and #1080's inconclusive `ttfb_ms ≈ latency_ms` reading could not make
   — but "queue wait, not generation" is one notch more specific than what these 8 calls prove; the
   defensible claim is "admission-plus-prefill, not decode."
4. **Caveat on sample size and scope.** Eight calls, one session, one model, one burst width (3, not
   4, to respect the soak-coexistence budget), run alongside an active soak rather than against an
   idle account (see the note above). This is not a replacement for #1080's much larger five-model,
   62-call production sample — it is a narrow, cheap confirmation that the mechanism those numbers
   implied (something before the first token, not the generation itself) is real, using the one
   measurement (`stream:true`) that can actually see it. A larger streaming sample, if ever
   justified, would tighten the confidence interval on the split and could in principle separate
   queue-idle from prefill contention (e.g. by varying prompt length independently of concurrency);
   it would not change which side of the split is growing.

### Route 1: does Nous expose server-side timing telemetry?

The issue named two routes to a real decomposition: vendor-side timing headers/logs, **or**
`stream:true`. This doc took the second route as primary; the first is one extra call, run once,
separately from the 8-call budget above (`node docs/research/45-nous-streaming-ttft-probe.mjs
--headers-only`, no request body/completion content involved). Raw output:
[`archive/raw/2026-09-14-nous-response-headers-probe.json`](archive/raw/2026-09-14-nous-response-headers-probe.json).
No `authorization` or `cookie`/`set-cookie` value was printed — the script redacts those by name
before writing anything.

Nous (behind Cloudflare, on a Railway-hosted origin per `x-railway-edge`/`x-railway-request-id`)
returns rate-limit accounting headers (`ratelimit`, `ratelimit-policy`,
`x-ratelimit-{limit,remaining,reset}-{requests,tokens}[-1h]`) and infra/tracing headers (`cf-ray`,
`x-hikari-trace`, `x-railway-request-id`). **None of them carry a queue-depth, admission-wait, or
server-side processing-time value.** The rate-limit headers describe *budget remaining* (399/400
requests, ~4M/4M tokens left in the current window), not *time spent waiting* — they cannot
substitute for this doc's client-side `ttft` measurement. This one call does not change the doc's
conclusion; it closes out the route the issue named as an alternative, with a negative result: no
vendor-side timing telemetry was found to read instead of inferring queue-plus-prefill time from the
client side.

## 3. Thread 4: model choice, re-evaluated against ADR-0009

[ADR-0009](../adr/0009-single-provider-nous.md) picked `anthropic/claude-haiku-4.5` for the debate
role by measurement (2026-08-06, 8 samples/model, 4 candidates), on the grounds that the crypto 15 s
budget is decided by the tail, not the median, and haiku's tail was flat while every alternative's
was 1.5–2x its own median. That ADR is equities-only scope now (crypto left 2026-08-16, per
CLAUDE.md), and the live budget it reasons about is the stocks one in
`server/pipeline/debate-engine/latency-budget.ts`, sized by #1080 at <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
`llmCallsPerDebate(1) * 28_000 ms = 112_000 ms` for one round.

The #1080 probe (§1) is a fresh, larger candidate set (5 models, not 3) run under closer-to-real
prompt sizes (3,031–4,614 prompt tokens, vs. ADR-0009's original ~unspecified detector prompt) and
under a burst-of-4 load that reproduces the soak's observed concurrency, not just concurrency-1.
Reading it against ADR-0009's own decision criterion (does the candidate fit the budget, does it
answer in valid JSON):

- **Haiku still wins on the criterion that matters.** Burst-of-4 max 25.7 s is comfortably inside
  the 112 s stocks budget (and would have cleared ADR-0009's original 15 s crypto budget too, the
  regime it was actually measured against). 4/4 burst calls valid JSON.
- **`gpt-5.4-mini` is the only other candidate that is both budget-safe and JSON-clean** (33.6 s
  burst max, 4/4 valid) — an improvement on ADR-0009's 2026-08-06 table, where none of the three
  non-haiku candidates it tested cleared their bar. It is, in fact, cheaper than haiku on Nous's own
  posted rates (`server/shared/llm/pricing.ts`: $0.60/$3.60 per M in/out vs. haiku's $0.80/$4.00,
  cheaper on both input and output) — cost is not the reason to prefer haiku. **Tail latency is.** ADR-0009's own stated
  decision criterion for this role is the tail, not the median or the price, because the tail is
  what a 1-round debate's budget has to survive: `gpt-5.4-mini` is slower than haiku at every
  measured point (seq max 6.86 s vs. 6.39 s; burst p50 27.0 s vs. 18.9 s; burst max 33.6 s vs.
  25.7 s), leaving materially less margin inside the 112 s stocks budget under fan-out. On that
  criterion `gpt-5.4-mini` does not beat haiku for this role, even though it is the cheaper model.
- **The three reasoning-tier candidates (deepseek-v4-flash, glm-5.3-flash, gemini-3.8-flash) are
  latency-plausible but JSON-broken at the config tested — not ruled out on merit, ruled out on a
  confound.** `max_tokens: 300` gets almost entirely consumed by hidden `reasoning_tokens`
  (230–300 of the 300-token budget across the three), leaving `content: null` or a truncated
  fragment. This is precisely the failure mode ADR-0009 already named when it excluded
  reasoning/`-pro` tiers before its own 2026-08-06 sampling round: *"kimi-k3 spending its entire
  `max_tokens` on hidden chain-of-thought and returning `finish_reason=length` with zero content,
  every time."* The #1080 probe reproduces that same failure mode on three different reasoning
  models, which strengthens rather than reopens ADR-0009's exclusion — but it is a config artifact,
  not a latency or capability finding, and a model excluded on a config artifact is not the same as
  a model excluded on the merits. A fair re-test would need either a materially larger `max_tokens`
  (accepting the extra spend and latency of a real reasoning pass) or a Nous-side low-effort/
  reasoning-disabled flag, if one exists for these models — neither was attempted here, and doing so
  is out of this ticket's evidence-pass scope.
- **`qwen3.8-flash` is excluded on reliability, not latency**: one of four burst calls hit the 45 s
  timeout outright. A model that cannot be trusted to complete at the fan-out width the live
  pipeline actually runs is disqualified regardless of its successful-call speed.

**Conclusion on thread 4: ADR-0009's pick is RE-CONFIRMED, not merely left standing.** This is a
materially different measurement from the one the ADR shipped with — 5 candidates instead of 3, a
heavier prompt, a burst-of-4 load instead of only concurrency-1 sampling — and haiku is still the
only model that is simultaneously budget-safe, JSON-clean, and free of the reasoning-token confound.
`gpt-5.4-mini` is the one candidate now known to be budget-safe as a genuine fallback (ADR-0009
already names "swap provider but keep haiku" and, separately, any `NOUS_DEBATE_MODEL` override as a
one-line change); it is not a reason to move off haiku today. The three reasoning-tier candidates
remain an open question, not a closed one, gated on a `max_tokens`/reasoning-effort fix nobody has
built.

## 4. What #1080 iteration 2 already does about the admission-plus-prefill finding

[#1080](https://github.com/dd-jp/samurai-trading-system/issues/1080) is the ticket that owns the
**policy** response to this latency — this doc explicitly does not (its acceptance criteria and
scope note say so: *"#1023 owns the cause question... this ticket does not restate or duplicate
it"*). #1080's own first iteration (measured fan-out budget policy — 1-round stocks debate inside a
112 s budget, no retry on deadline expiry, single-flight bar fetches) already merged to `main`
(PR #1513). Its named second-iteration candidate lever, per the ticket that spawned this doc, is an
account-wide in-flight cap of 1 concurrent Nous call, tracked as work on branch
`issue-1080-llm-inflight-cap` — #1080's own tracking is the source of truth for that branch's state,
not this doc, since branch state moves independently of a research doc's own timeline.

Given §1's finding that Nous's queuing is scoped **per account, not per key** (three different keys
in a 3-call burst performed no better than one key carrying all three), and §2's finding that the
component inflating under concurrency is the pre-first-token phase while token emission stays flat,
an account-wide in-flight cap is the lever that targets the actual mechanism this doc measured — it
removes the concurrent-burst condition that produces the long `ttft` tail, trading per-pass
fan-out throughput (multiple instruments' debates progressing at once) for per-call latency closer
to this doc's concurrency-1 numbers (haiku `ttft` 3.1–5.2 s, `total` 6.2–7.8 s) instead of the
burst tail (`ttft` up to 16.3 s, `total` up to 19.3 s seen here, or 25.7 s max in #1080's larger
burst-of-4 sample). Whether that trade is net-positive for the pipeline as a whole — fewer
instruments serviced per tick, at much lower risk of blowing the per-debate budget — is exactly
what #1080's own acceptance criteria ask it to measure over a real session; this doc does not
duplicate that measurement.

## 5. Risk assessment: enabling `stream:true` on the debate call path

The issue named this explicitly: a decomposition that "likely requires enabling streaming on debate
calls" is "a behavior change [that] needs its own risk assessment since the debate consumes each
response whole today." This doc's probe never touches production code (§2), but the risk assessment
itself is owed regardless, so a future ticket that wants to act on §2's findings does not have to
re-derive it.

**What consumes the response whole today.** `nousChat` (`server/shared/llm/nous-chat.ts`) awaits
`response.json()` exactly once and reads the entire parsed body in one pass: `choices[0].message`
for the completion text, and `usage.{prompt,completion}_tokens` for spend metering — both atomic
reads of a single complete JSON document. `NousMessagesClient.createMessage`
(`server/pipeline/debate-engine/llm/nous-messages-client.ts`) wraps that single string into one <!-- cite-exempt: historical — moved to server/shared/debate/llm/ in the #1748 rename -->
`content` block; downstream, the debate engine `JSON.parse`s that whole string as
`{stance, rationale, confidence}` (the same shape §1's probe checks). None of this reads content
incrementally — nothing in the call chain is written to act on a partial response.

**What breaks under partial chunks, unmodified.** `stream:true` changes the response body from one
JSON document to a Server-Sent-Events stream (`data: {...}\n\n` frames, `[DONE]` terminator — see
§2's probe for the parser this actually requires). Flipping the request flag alone, with
`nousChat`'s `response.json()` left as-is, does not degrade gracefully: `response.json()` would
throw on every single call (an SSE body is not valid JSON), landing every request in the
"response body could not be parsed as JSON" branch that today only fires on a genuinely malformed
reply. This is not a partial-content bug to harden against; it is total breakage from the first
call, and it is why `stream:true` cannot be a one-line config flip — the entire read path from
`fetch` through `JSON.parse` would need rebuilding to accumulate SSE deltas into a final string
before anything downstream sees it (the shape `docs/research/45-nous-streaming-ttft-probe.mjs`
already implements, for measurement only). A second, separate gap: OpenAI-compatible streaming only
includes final `usage` accounting when the request explicitly asks for it
(`stream_options: {include_usage: true}`) — this doc's probe did not request that option and did not
verify Nous honours it, so spend metering on a streamed path is an open question this doc does not
answer, not a detail already covered by §2's measurements.

**Deadline interaction.** Today's cancellation seam is timeout-shaped, not partial-progress-aware:
`AnthropicLlmClient.callWithTimeout`'s outer race timer starts before `createMessage` is even
called and is what actually fires `LlmTimeoutError` on a slow call; `nousChat`'s own `timeoutMs` is
a deliberately wider network backstop (see the doc comment on
`NousMessagesClientOptions.timeoutMs`). Both compose through `fetchWithTimeout`'s `AbortSignal.any`,
which cancels the real socket at a fixed budget — it has no concept of "some bytes have arrived,
more are coming," only "still open" vs. "aborted." Streaming's one genuine advantage this doc's data
suggests — aborting a call early once `ttft` alone has already blown the round's remaining budget,
before paying for the generation phase too — is not something the current abort composition does;
it would need new logic layered on top of the existing signal, not a request-shape change.
**Net: enabling `stream:true` today, without the read-path rebuild and the usage-accounting check
above, does not decompose or reduce anything — it breaks every debate call outright.** This confirms
§6 recommendation 2 rather than changing it.

## 6. Recommendation

1. **Keep `anthropic/claude-haiku-4.5` pinned for the debate role.** Re-confirmed by a materially
   larger evidence pass than ADR-0009 shipped with, not merely unchallenged.
2. **Do not enable `stream:true` in production code as a result of this doc.** It narrows the causal
   question (the growing component is pre-first-token time, not decode — see §2.3 for the precise,
   hedged claim) but does not by itself reduce latency — the actionable lever against
   concurrency-driven inflation is admission control / concurrency policy, which is #1080's scope,
   not a transport change. §5's risk assessment is the reason this is not a one-line flip even if it
   were wanted later: the entire response-consumption path breaks outright, not gracefully, without
   a rebuild this evidence pass is explicitly out of scope for.
3. **Treat #1080's account-wide in-flight cap as the primary candidate lever against the latency
   this doc attributes to the pre-first-token phase**, and let #1080's own acceptance criteria
   (measured session, quorum rate, budget-exceeded rate) decide whether the throughput trade is
   worth it — not a decision this doc makes.
4. **Re-open the three reasoning-tier candidates only if/when someone runs them at a fair
   `max_tokens` or reasoning-disabled setting.** Not before, and not as a consequence of this doc —
   their exclusion here is a confound, not a verdict.

## Open questions

- Does #1080's in-flight cap of 1 actually restore concurrency-1-like `ttft` under the real
  production fan-out width (20 instruments), measured over a real session rather than an 8-call
  probe? This doc's numbers are a mechanism check, not that measurement.
- Would a larger `max_tokens` or a Nous-side reasoning-effort/low-effort flag (if one exists for
  deepseek-v4-flash, glm-5.3-flash, or gemini-3.8-flash) make those three fairly comparable to
  haiku, and is the extra spend/latency of finding out worth it at the current fan-out width?
- This doc's decomposition is client-side timing inference (`ttfb`/`ttft`/`total` on our own
  clock), never vendor-confirmed queue telemetry. The response headers exposed to this account
  (checked in §2's Route 1) carry rate-limit budget, not timing — no queue-depth or processing-time
  header was found. Whether Nous/Anthropic expose real timing telemetry through a channel other than
  response headers (a status API, request logs, an account dashboard) was not asked about; worth
  raising if the account relationship allows it.
- Is the near-exact `ttfb ≈ ttft` equality this probe measured a stable property of Nous's streaming
  path, or an artifact of an 8-call sample where the pre-first-token phase happened to already be
  resolved by the time headers were sent? A larger streaming sample would tighten this without
  changing which component (admission-plus-prefill, not decode) is the one that grows under load.
