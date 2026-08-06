# ADR-0009 — One LLM provider: Nous

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decided by:** David — *"we have anthropic api key and xai api, i want to change this to a single provider. lets use Nous API to use models."*
- **Related:** [ADR-0008](0008-llm-spend-cap.md) (the $50/14d cap — **amended by this ADR**, see below), [#274](https://github.com/dd-jp/samurai-trading-system/issues/274) (the live transport layer this retargets), [#464](https://github.com/dd-jp/samurai-trading-system/issues/464) (the Grok sentiment agent), [#367](https://github.com/dd-jp/samurai-trading-system/issues/367) (`llm_spend`)

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
| `sentiment` | `~x-ai/grok-latest` | $1.60 / $4.80 (resolves to `x-ai/grok-4.5` today) |

Both are overridable per role: `NOUS_<ROLE>_MODEL` → `NOUS_MODEL` → the default
above, with `NOUS_<ROLE>_API_KEY` → `NOUS_API_KEY` for the key.

**Why Grok for sentiment.** The stage reads X/Twitter sentiment, and Grok is
the model trained on that discourse — with no live retrieval available through
Nous (see below), the training corpus *is* the edge, so the model that has seen
X is the one worth asking. Latency does not bind (the stage sits off the tick's
critical path behind a 4-hour bucket) and neither does cost: ~36 calls/day is
roughly **$1.60 across a 14-day soak**, against a $50 cap.

The leading `~` is the portal's own marker for a floating alias — the id
without it returns 404, confirmed against the live `/models` endpoint. Floating
is deliberate: for a stage whose value is corpus recency, tracking the newest
Grok is the point.

It stays honest on cost for a reason worth recording, because it validates the
metered-model rule below: **Nous echoes the concrete model it resolved to.** A
live probe of `~x-ai/grok-latest` came back as `model: "x-ai/grok-4.5"`, and
`nousChat` meters against that echo whenever the table can price it. So the
alias prices at whatever it actually ran on and follows xAI's next release with
no code change; the alias's own rate is a fallback that should never be
reached. `x-ai/grok-4.5` is the pinned alternative, one env var away.

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
- **Retire the sentiment agent entirely** until a real retrieval source exists.
  The most honest option on the merits — the signal is model recall either way.
  Rejected by David in favour of keeping the stage running.
- **Swap provider but keep `claude-haiku-4.5`,** changing one variable at a
  time. Genuinely lower risk, and it remains the fallback; rejected as the
  default because it leaves ~7× of the saving on the table for a model whose
  workload is short structured JSON.
