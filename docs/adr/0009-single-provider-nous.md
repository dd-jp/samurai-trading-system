# ADR-0009 — One LLM provider: Nous

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decided by:** David — *"we have anthropic api key and xai api, i want to change this to a single provider. lets use Nous API to use models."*
- **Related:** [ADR-0008](0008-llm-spend-cap.md) (the $50/14d cap — **amended by this ADR**, see below), [#274](https://github.com/dd-jp/samurai-trading-system/issues/274) (the live transport layer this retargets), [#464](https://github.com/dd-jp/samurai-trading-system/issues/464) (the Grok sentiment agent), [#367](https://github.com/dd-jp/samurai-trading-system/issues/367) (`llm_spend`), [ADR-0020](0020-x-retrieval-through-nous.md) (what retrieval costs and what a floating alias now carries)

> **AMENDED 2026-09-03 — the decision stands, two of its stated facts do not.**
> This ADR recorded that "Nous proxies `chat/completions` only" and that
> "xAI Live Search becomes permanently unreachable". Both are false, and its
> own escape clause — *"Revisit if retrieval ever becomes reachable"* — has
> fired.
>
> Probed live with the credential this system already holds
> ([#969](https://github.com/dd-jp/samurai-trading-system/issues/969), map
> [#522](https://github.com/dd-jp/samurai-trading-system/issues/522)):
> `POST {NOUS_BASE_URL}/responses` returns 200, and the server-side `x_search`
> tool runs there on the OpenRouter-routed alias `~x-ai/grok-latest`. It 400s
> on the pinned `x-ai/grok-4.5` — *"Server-side search tools are not available
> for model 'x-ai/grok-4.5'. They are supported only on OpenRouter-routed
> models."*
>
> **Retrieval is therefore reachable INSIDE the single-provider rule.** Same
> vendor, same key, same spend meter — a second endpoint, not a second
> provider. The decision this ADR makes is not weakened by that; it is
> strengthened, because the main thing it was recorded as costing turns out
> not to be a cost at all. No ADR-0009 exception was needed, and the direct
> xAI path #969 was filed to evaluate was tested and rejected on its merits:
> the retired `xAI_API_KEY` returns `401 unauthenticated:bad-credentials`, and
> going direct would cost MORE, since Nous prices the alias 20% under xAI's
> list on every line (1.6 vs 2.0 in, 4.8 vs 6.0 out, 0.004 vs 0.005 search).
>
> Every paragraph below that reasons from "retrieval is unreachable" is marked
> inline. The cost figures in the Context section are also wrong by two orders
> of magnitude for a retrieving call — see ADR-0020, which carries the
> retrieval cost regime and the floating-alias decision this amendment forces.

## Context

The system talked to two vendors on two keys:

| Surface | Endpoint | Model | Key |
| --- | --- | --- | --- |
| Debate engine | `POST api.anthropic.com/v1/messages` | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| Sentiment agent | `POST api.x.ai/v1/chat/completions` | `grok-4` | `XAI_API_KEY` |

Two vendors means two billing relationships, two failure surfaces, two rate
tables to keep honest, and a model roster bounded by whichever vendor a given
stage happens to be pointed at.

Nous fronts many vendors behind a single OpenAI-compatible
`chat/completions` endpoint, with a key per model. The repo already runs
against it: `.github/workflows/ai-review.yml` drives the PR reviewer through
`NOUS_BASE_URL` with two keys for two models (`NOUS_API_KEY` for DeepSeek,
`KIMI_NOUS_API_KEY` for Kimi). That is the shape this ADR generalises.

## Decision

**All LLM traffic goes through Nous.** `ANTHROPIC_API_KEY` and `XAI_API_KEY`
are retired.

One wire helper (`shared/llm/nous-chat.ts`), two thin adapters — one satisfying
the debate engine's existing `AnthropicMessagesClient` interface, one
satisfying `GrokSentimentClient`. Nothing above the wire changed:
`AnthropicLlmClient`'s retry policy, timeout race, cancellation, prompt-safety
wrapping, error classification and spend metering are provider-neutral, and the
interface was documented from the start as deliberately structural so a
non-SDK wire client could satisfy it.

### Models

| Role | Model | Rate (in/out per M) |
| --- | --- | --- |
| `debate` | `anthropic/claude-haiku-4.5` | $0.80 / $4.00 |
| `sentiment` | `x-ai/grok-4.5` | $1.60 / $4.80 |

Both are overridable per role: `NOUS_<ROLE>_MODEL` → `NOUS_MODEL` → the default
above, with `NOUS_<ROLE>_API_KEY` → `NOUS_API_KEY` for the key.

**Why Grok for sentiment, and what it actually returns.** The stage reads
X/Twitter sentiment, and Grok is the model trained on that discourse — with no
live retrieval available through Nous (see below), the training corpus *is* the
edge, so the model that has seen X is the one worth asking. Latency does not
bind (the stage sits off the tick's critical path behind a 4-hour bucket) and
neither does cost: at a measured ~$0.001 per call and ~36 calls/day, a 14-day
soak is roughly **$0.50** against a $50 cap.

> **AMENDED 2026-09-03 (#969): this figure describes a NON-RETRIEVING call and
> must not be quoted for the retrieval path.** A call that runs `x_search`
> carries its search results in the prompt, which is where the cost is: a
> 3-result call measures ~5,300 input tokens and a 10-result call 58,153,
> against roughly 200 for the recall-only call priced above. Measured, a
> 10-result call cost **$0.089** — ninety times this line's figure. The soak
> arithmetic changes with it: 3 instruments x 12 two-hour buckets x 14 days =
> 504 calls, which is ~$45 at 10 results (over the whole $50 cap on its own,
> before the debate leg) against roughly $10-15 at the default 3. The cap does
> not merely bound the retrieval path; it SELECTS its result count. ADR-0020
> carries the regime.

**Measured, 2026-08-06: the stage returns `{"items":[]}` on every call, and
that is the correct behaviour rather than a defect.** The first real exercise of
this client — it had never made a live call under `XAI_API_KEY` either — went
through `NousSentimentClient.fetchSentiment` against BTC-USD and AAPL and parsed
zero items from a well-formed fenced `{"items":[]}`. Four further calls isolated
the cause with the production system prompt held verbatim and only the user
message varied:

| user message | items |
|---|---|
| `Instrument: TSLA. As of: <today>.` | 0 |
| `Instrument: TSLA. As of: <today>.` (repeat) | 0 |
| `Instrument: TSLA.` (no date) | 0 |
| `Instrument: TSLA. As of: 2025-06-01.` (inside corpus) | 0 |

Empty regardless of date, so this is **not** a knowledge-cutoff effect. The
driver is the prompt's own anti-fabrication clause — *"an empty list is a valid
and useful answer, and inventing sentiment to fill the list is worse than
reporting none"*. Drop that clause and the same model immediately produces
fluent, plausible, entirely invented TSLA sentiment (*"traders highlight
upcoming delivery numbers and robotaxi progress"*), and asked directly it
confirms: *"I do not have live access to X/Twitter posts in this API call and am
answering from training data."*

So the stage's honest output, given no retrieval, is nothing. Analysts see
`NO_DATA_MARKER` either way (#463), which is the same state they were in when
`XAI_API_KEY` sat empty — the difference is that it is now a measured, explained
state rather than an assumed one. **Do not treat empty intelligence rows during
the soak as a bug.** The stage is left enabled so that the caller is exercised
in a real process at ~$0.50, which is this repo's dominant defect class (tested
mechanisms nothing calls); the moment a retrieval source exists, the wiring is
already proven.

**Pinned, not floating.** `~x-ai/grok-latest` (the leading `~` is the portal's
marker for a floating alias; the bare id 404s, confirmed against `/models`) was
the first choice, justified on corpus recency — track the newest Grok, because
the corpus is the edge. The measurement above removes that upside: while the
answer is `{"items":[]}`, a fresher corpus is worth nothing. What floating still
carries is a live-money downside — a future model behind the alias could start
returning invented sentiment into the analyst path, and **no test would catch
it**, because empty is currently the correct answer and nothing asserts on
content. So the default pins `x-ai/grok-4.5`. Revisit if retrieval ever becomes
reachable, at which point recency starts paying again.

> **AMENDED 2026-09-03 (#969): that revisit has happened, and the answer is
> not the one this paragraph anticipated.** It expected retrieval to make
> floating worth its risk again on CORPUS RECENCY grounds. What actually
> happened is that pinning stopped being available at all: `x_search` 400s on
> every pinned id, so the routed alias is not a preference on the retrieval
> path, it is the only thing that works.
>
> The downside this paragraph names — "a future model behind the alias could
> start returning invented sentiment into the analyst path, and no test would
> catch it, because empty is currently the correct answer and nothing asserts
> on content" — is real and is now ADDRESSED rather than accepted. Empty is no
> longer the correct answer, and the content is no longer unasserted: every
> item must name a permalink that appears in the response's own citation set,
> so an invented item is dropped whatever model produced it
> (`x-search-client.ts`). Alias re-resolution to a model that cannot run the
> tool fails loudly instead — the 400 is named explicitly in the agent's error
> and the resulting empty `social` bucket trips `MiCoverageMonitor` on the
> first miss. ADR-0020 records the residual risk.
>
> The pinned default is UNCHANGED for the non-retrieving client, which still
> ships as the fallback.

The alias probe is still worth recording, because it validates the
metered-model rule below: **Nous echoes the concrete model it resolved to.** A
live probe of `~x-ai/grok-latest` came back as `model: "x-ai/grok-4.5"`, and
`nousChat` meters against that echo whenever the table can price it — so a
floating alias, if ever used, prices at whatever actually ran. Both ids stay in
`MODEL_RATES`.

**Why haiku for the debate — decided by measurement, and it overturned the
first answer.** `openai/gpt-5.6-luna` was chosen on the price list: cheapest
frontier-family non-reasoning tier, ~$5/14d against haiku's ~$34. It did not
survive contact with the portal.

The binding constraint is the 15s crypto budget
(`debate-engine/latency-budget.ts`), which covers the **whole debate** — the
once-per-debate disagreement call plus three *sequential* persona calls, so
four calls have to fit. What decides that is not median latency but the **tail**:
one slow call cancels the debate.

Two naive sampling rounds disagreed with each other by 2× on the same model,
which is itself the finding — portal latency drifts over minutes, so any
one-model-at-a-time benchmark measures the weather. Re-run with candidates
rotated so load hit each equally (8 samples each, real detector prompt,
2026-08-06):

| model | p50 | max | 4 × max | fits 15s |
|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 2902ms | 2962ms | 11.8s | **yes** |
| `openai/gpt-5.4-mini` | 3521ms | 7531ms | 30.1s | no |
| `openai/gpt-5.6-luna` | 3709ms | 5551ms | 22.2s | no |
| `deepseek/deepseek-v4-flash` | 4874ms | 5866ms | 23.5s | no |

All four returned valid JSON on all 8 samples, so **correctness did not
separate them — the tail did.** Haiku's is essentially flat; every other
candidate's is 1.5–2× its own median. The cheap tiers appear to be cheap partly
because they are queued.

So the accepted cost is ~$34 per 14 days, roughly two thirds of ADR-0008's $50
cap, to buy latency headroom. That is the right trade when the alternative is
debates that cancel mid-round. Reasoning and `-pro` tiers were excluded before
sampling: `ai-review.yml` records kimi-k3 spending its entire `max_tokens` on
hidden chain-of-thought and returning `finish_reason=length` with zero content,
every time.

Every candidate above is one environment variable away (`NOUS_DEBATE_MODEL`) if
a later measurement disagrees.

**This table is one day's weather, and the record should not be read as more
than that** *(noted 2026-08-17)*. It is 8 samples per model taken on
2026-08-06, on a portal whose latency the same section shows drifting by 2×
between rounds. The decision it supports is load-bearing — it is the only
evidence the 15s crypto budget is met — so the conditions under which it stops
being evidence are stated explicitly rather than left to be rediscovered:

- **The headroom is thinner than 11.8s vs 15s suggests.** The budget covers
  four *sequential* calls, so the margin absorbs one slow call, not a shifted
  distribution. A sustained portal load spike moves the tail, not the median,
  and the tail is the whole basis of the choice.
- **Re-measure, do not extrapolate, on any of:** a change to the debate prompt
  length or to the number of calls per debate; the introduction of tool use in
  the debate path; a provider-side model version bump behind the same id; or
  any observed debate cancellation attributed to timeout.
- **A cancelled debate is the signal.** Debate-cancellation-on-timeout is the
  operational tell that this measurement has expired; it should be treated as a
  re-measurement trigger rather than as an isolated transient.

## What this amends in ADR-0008

ADR-0008 states, as fact #1 under its Context:

> **Model choice is not a lever.** Debates already run on
> `claude-haiku-4-5-20251001`, the cheapest model in `pricing.ts`. There is
> nothing cheaper to move to.

**That is no longer true.** It was true of a single-vendor price table; a
multi-vendor portal reprices the whole question — the same Haiku the debate
already ran on is $0.80/$4.00 here against Anthropic's own $1.00/$5.00, so
debate spend drops from roughly $42 per 14 days to roughly $34 on an unchanged
model, and the portal's cheaper tiers are available if latency ever allows one.

The cut is smaller than it first looked, because model choice turned out to be
bounded by the latency budget rather than by the price list — see the debate
model note above.

The rest of ADR-0008 stands unchanged and is the reason this cutover is safe:
the cap is enforced in dollars against `llm_spend`, not in calls, so it does
not care which provider produced a row.

**Cadence is reopened, not changed.** ADR-0008 chose 15 minutes against a
debate that cost ~8× what one costs now. That headroom is real, and spending it
is a separate decision with its own evidence — not a side effect of a provider
swap. This ADR pulls no cadence lever.

## What this costs

**xAI Live Search becomes permanently unreachable.** The sentiment agent is
named for live X/Twitter sentiment, and xAI's Live Search rides on
`POST /v1/responses`; Nous proxies `chat/completions` only.

This is **not a regression against what shipped**. The xAI client being
replaced posted to plain `/chat/completions` with no `search_parameters` — it
was already answering from training data, not from X. What the cutover closes
off is the *fix*. Restoring real retrieval for that stage now needs a genuine
data source rather than a model swap, and it is separate work. David chose this
over retiring the agent.

> **WITHDRAWN 2026-09-03 (#969). This section is wrong on the facts, and it is
> the single most consequential wrong line in this ADR** — it was inherited by
> `pricing.ts` (which called its server-tool arithmetic inert "because
> ADR-0009"), by `nous-sentiment-client.ts`'s hard-coded
> `retrievalEvidence: false`, by `market-intelligence-spec.md`, and by #485 and
> #969, both of which were framed as needing a second vendor. A whole design
> branch was priced against a premise nobody re-probed for four weeks.
>
> Corrected, point by point:
>
> - **"Nous proxies `chat/completions` only"** — false. `POST /responses`
>   returns 200 on the same base URL and the same key.
> - **"xAI Live Search becomes permanently unreachable"** — false. The
>   server-side `x_search` tool runs through Nous on `~x-ai/grok-latest`.
> - **"needs a genuine data source rather than a model swap"** — inverted. It
>   needed exactly a model swap: the same endpoint, the same credential, a
>   routed alias instead of a pinned id.
>
> What remains TRUE is the sentence this section leads with: the client that
> was replaced was already answering from training data, so nothing regressed
> at cutover. The error was in the forward-looking claim, not the backward one.
>
> The lesson is the one this repo keeps relearning and
> `wayfinder-bodies-go-stale` already records: a capability claim about a
> third party is a MEASUREMENT with an expiry date, not a fact. This one cost
> four weeks of `social` being empty, which #625 had already priced at "a stock
> could not trade at any RSI, in any market".

`source: 'twitter'` and `agent_id: 'grok'` are kept: they are persisted in
`market_intelligence` rows, so renaming them is a migration rather than a
rename.

## The two failure modes this cutover had to close

Both would have shipped green and failed silently in production.

1. **An unpriced model silently un-caps the budget.** `spend-cap.ts` sums
   `COALESCE(SUM(cost_usd), 0)`, and `priceUsage` returns `null` for a model
   absent from `MODEL_RATES` — so an unpriced row contributes **zero** and the
   $50 ceiling stops existing, with no throw and no failing test. Every Nous
   model id is a new string: `anthropic/claude-haiku-4.5` does not match the
   old `claude-haiku-4-5` prefix. Closed two ways: `nousCredentials` refuses at
   startup to build a client for a model with no rate, and the wire client
   meters against a provider-echoed model id **only** when the table can price
   it, falling back to the requested id otherwise.

   `rateFor` also became an **exact** match. Prefix matching existed for
   Anthropic's dated snapshot ids; against Nous's stable `vendor/model` strings
   it would misprice, because `openai/gpt-5.6-luna` is a literal prefix of
   `openai/gpt-5.6-luna-pro`.

2. **A truncated completion would be retried and re-billed.**
   `finish_reason: 'length'` yields partial or empty text, which
   `parseResponse` rejects as `LlmMalformedResponseError` — a class
   `isRetryable` retries. The same budget fails identically on every attempt.
   `NousTruncatedError` carries no `.status`, so it classifies as
   non-retryable and fails once, loudly.

## Alternatives considered

- **Keep xAI direct for sentiment, move only the debate.** Preserves the Live
  Search option. Rejected: it is two vendors, which is the thing being removed,
  and it preserves an option nothing is scheduled to exercise.
  *(2026-09-03: this rejection is VINDICATED, not merely upheld. The option it
  gave up turned out not to require two vendors at all, so the cost this
  alternative was weighed against was never real — and when #969 re-tested the
  direct path four weeks later it was both dead, `401 bad-credentials`, and
  20% more expensive per line than the route that replaced it.)*
- **Retire the sentiment agent entirely** until a real retrieval source exists.
  The most honest option on the merits — the signal is model recall either way.
  Rejected by David in favour of keeping the stage running.
- **Swap provider but keep `claude-haiku-4.5`,** changing one variable at a
  time. Genuinely lower risk, and it remains the fallback; rejected as the
  default because it leaves ~7× of the saving on the table for a model whose
  workload is short structured JSON.
