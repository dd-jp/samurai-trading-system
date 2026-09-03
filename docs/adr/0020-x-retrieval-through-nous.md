# ADR-0020 — Live X retrieval through Nous: a floating alias, and what it costs

- **Status:** Accepted
- **Date:** 2026-09-03
- **Decided by:** David — *"should be combining reddit and x for social, go with x now, once reddit replies we will merge reddit. lets soak with x."*
- **Related:** [ADR-0009](0009-single-provider-nous.md) (**amended by this ADR's findings** — two of its stated facts were false), [ADR-0008](0008-llm-spend-cap.md) (the $50/14d cap this prices against), [#969](https://github.com/dd-jp/samurai-trading-system/issues/969) (the ticket whose premise this falsified), [#485](https://github.com/dd-jp/samurai-trading-system/issues/485) (the retrieval-evidence guard this finally exercises), [#914](https://github.com/dd-jp/samurai-trading-system/issues/914) (the measured mute analyst), [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) (what a mute analyst cost), [#976](https://github.com/dd-jp/samurai-trading-system/issues/976) (Reddit, pending App Review), map [#522](https://github.com/dd-jp/samurai-trading-system/issues/522)

## Context

`MarketContext.social` has never had a producer. `sentiment-analyst.ts` is
built, wired, registered, and emits `NO_DATA_MARKER` on every tick — measured
on the 2026-08-26 soak (#914) — and #625 priced what that costs: with both
news-fed analysts pinned at confidence 0.05, the stocks conviction ceiling was
**0.5478 against a 0.55 floor**, so a stock could not trade at any RSI, in any
market.

Map #522 spent weeks looking for a writer and found the rungs closed one by
one. StockTwits is shut to new registrations. Reddit needs discretionary
approval (#976, submitted 2026-09-02, still with App Review). Bluesky passed
every licensing gate and then **failed on volume** — 0 cashtag hits in 25,269
posts, and the only finance-worded hits were affiliate spam and tokenised-stock
pump bots (#1041, doc 25). X was the remaining rung, blocked behind #969: *is a
direct xAI client worth an ADR-0009 exception?*

**That question had no subject.** Probed live on 2026-09-03 with the
credential this system already holds — see ADR-0009's amendment for the full
correction — Nous serves `POST /responses`, and the server-side `x_search` tool
runs there on the OpenRouter-routed alias `~x-ai/grok-latest`. No second
vendor, no exception, no new key.

Retrieval was verified **genuine offline**, not merely claimed: an X status id
is a snowflake, so `(id >> 22) + 1288834974657` decodes the post's own
timestamp. The cited posts landed **40–80 seconds before the response's own
`created_at`**. No training corpus contains a post from forty seconds ago.

What remains to decide is not *whether* — that is settled by measurement — but
the two things the measurement forces, each separately supersedable.

## Decision 1 — A floating alias may carry a load-bearing capability, because pinning is not on the menu

ADR-0009 pinned `x-ai/grok-4.5` and named the risk of floating precisely: *"a
future model behind the alias could start returning invented sentiment into the
analyst path, and no test would catch it."* That reasoning was correct and is
not overturned. What changed is that **the choice no longer exists**:
`x_search` 400s on every pinned id with *"Server-side search tools are not
available for model 'x-ai/grok-4.5'. They are supported only on
OpenRouter-routed models."*

So the retrieval path runs on `~x-ai/grok-latest`, and safety comes from a
**liveness assertion instead of a pin**:

1. **Invented content cannot reach the analysts, whatever model is behind the
   alias.** ADR-0009's risk rested on "nothing asserts on content" — true when
   empty was the correct answer. It is no longer true. Every item must name a
   permalink that (a) parses as a real `x.com/<handle>/status/<id>` URL and
   (b) appears in the response's own citation set; the stored `url` is taken
   from the **citation**, never from the model's body text. A model that
   invents items produces items with no matching citation, and they are
   dropped. This is a **per-item** gate, not the per-call boolean #485 built:
   a response can genuinely cite three posts and pad with seven recalled ones,
   and a call-level flag would pass all ten on the strength of the three.
2. **Re-resolution to a model that cannot run the tool fails loudly.** The 400
   is matched by name in `GrokAgent`'s error path and reported as a
   configuration fault that retries cannot fix, and the resulting empty
   `social` bucket trips `MiCoverageMonitor` on the **first** miss.
3. **The meter follows the alias.** `resolveMeteredModel` prices against the id
   the provider echoed, and `~x-ai/grok-latest` echoes `x-ai/grok-4.5` — so
   **both** rows in `MODEL_RATES` carry the retrieval rates. A tier on the
   alias row alone would never fire.

**Residual risk, stated plainly:** the alias can re-resolve to a model that
runs the tool but reasons worse, and nothing here would catch *that*. It is
bounded by what one item can do — contribute one score of ±1 among at most ten,
to one of several analysts, never reaching the order path — not eliminated.
`pricing.ts` already documents one prior re-resolution of this alias, so this
is an observed behaviour, not a hypothetical.

## Decision 2 — The retrieval cost regime: the cap selects the result count

Search results ride in the **prompt**. That single fact is the whole cost
story, and it is what makes a retrieving call a different economic object from
the recall-only call ADR-0009 priced at ~$0.001.

| | 3 results | 10 results |
| --- | --- | --- |
| Prompt tokens | ~5,300 | 58,153 (19,584 cached) |
| Measured cost | ~$0.02 (est.) | **$0.089** |
| 168-call soak | **~$3–5** | **~$15** |

**Buckets are session-derived, and that is the number to check first.**
`UniverseScheduler.nextTick` returns an **empty** instrument list whenever the
calendar says closed, so the sentiment refresh never fires outside the session.
A 6.5h US session touches **4** two-hour buckets, not the 12 a 24-hour day
would give. The soak is therefore 3 instruments × 4 buckets × 14 sessions =
**168 calls**, and every figure here moves if the scheduler or `GROK_REFRESH_MS`
moves.

**So the cap does NOT force 3 results at soak scale** — even 10 costs ~$15
against a $50 ceiling shared with a ~$0.29/day debate leg. An earlier draft of
this ADR said it did, on a 12-buckets-a-day reading nobody had checked against
the scheduler; that is the same failure this ADR indicts ADR-0009 for, caught
one commit later. The conclusions that survive:

- **`max_search_results` defaults to 3, with a hard ceiling of 10.** The
  ceiling is a clamp on operator input, not advice: `SAMURAI_X_MAX_RESULTS` is
  typed by a human, and a typed 100 must yield 10 and a warning rather than an
  order-of-magnitude overspend discovered days later as an exhausted budget.
  The **ceiling** is now the real guard; the **default** of 3 is a conservative
  starting point that V5 is expected to move, not a cap-derived necessity.
  It matters at the *live* universe rather than the soak: 7 instruments × 4
  buckets × 252 sessions at 10 results is ~$630/yr, where the same at 3 is
  ~$141/yr.
- **The 3-result figure is a RANGE, not a point.** The probe measured input
  tokens at that setting but never output, and output does not scale with
  result count — the 10-result call spent 2,009 of its 4,007 output tokens on
  reasoning. Quoting a point estimate here is the error this ADR's own
  predecessor made with "$0.001/call, ~$0.50 per soak"; the reconciliation
  against the provider's invoice is what replaces the range with a number.
  **The call COUNT is a derived assumption on the same footing** — it descends
  from the scheduler's session gating and from `GROK_REFRESH_MS`, and neither
  is a constant of nature.
- **The cadence and the result count are ONE decision.** `GROK_REFRESH_MS`
  moved 4h → 2h in the same change. The old 4h was derived from a *staleness*
  argument (1/6th of the analysts' 24h window) made while nothing retrieved and
  the ingested item count was structurally zero — it was bounding the freshness
  of an empty set. With real retrieval the binding constraint is **sample
  size**, and on session-derived buckets that is **thin**:
  `sentiment-analyst.ts` averages `social` wholesale, so 4 × 3 = **12
  posts/instrument/session** is what decides whether three bot posts can swing
  the lens — below the ~17 cashtag posts/ticker/day at which Bluesky was judged
  too sparse to carry a signal (#1041). The lever if that proves too thin is
  **more results per bucket, not more buckets**: 4 × 10 = 40 posts/session for
  ~$15 across the soak. That is the opposite of what an earlier 12-bucket draft
  concluded, and it is the direction V5's measurement is expected to push.

Three metering defects had to be closed before any of this could run
unattended, all in the under-counting direction — see the commit for #969. The
one worth recording here is that **Nous reports OpenAI-inclusive usage**, where
`cached_tokens` is a subset of `prompt_tokens`, while `AnthropicUsage` means
the Anthropic thing, where the two are disjoint and both are billed. Carrying
the count across without subtracting double-bills the cached tokens — ~26% on
the measured probe. The golden test pins the decomposition
(58,153 / 19,584 / 4,007 → **$0.088778**), and that arithmetic is what
*confirms* the inclusive reading rather than assuming it.

## What is archived, and what is not

`market-intelligence-spec.md` specifies `mi_archive_raw.payload` as "immutable
vendor bytes" (#554). **X posts are archived as a narrowed projection instead**
— status id, permalink, handle, post timestamp, and the derived score. **No
verbatim post body.**

The reason is that nobody has cleared storing X post text against X's terms,
and an archive is the worst place to discover the answer: it is the durable,
hard-to-unwind artifact. The GDELT six-column projection is the in-repo
precedent for exactly this deviation, and this matches the score-plus-permalink
posture already committed to for Reddit (#975).

The projection is not a minimal-effort compromise; it is chosen to keep the two
jobs the archive has here. **Replay** (#558) works because scores are stored and
never recomputed, which is what ADR-0003 §2 requires. And **bot share stays
answerable from soak data** because the handle is kept — that is the question
that killed Bluesky, and going into a soak unable to ask it would repeat the
mistake rather than learn from it.

**If X's terms bar even this**, the fallback is citation-only evidence with no
archive row, recorded as a deviation. Read them before treating the archive
shape as settled.

## What this changes about the experiment

**Retrieval defaults OFF** (`SAMURAI_SENTIMENT_RETRIEVAL=on` to enable), and
the polarity is deliberately the opposite of `SAMURAI_SENTIMENT`'s `!== 'off'`.

Sentiment has been excluded from the evidence average while mute (#676). Real
data puts it back in — through the same gate that produced #625's zero-trade
result. **A soak with retrieval on is measuring a different experiment from
#625 and #752**, and two soaks whose difference nobody noticed would be worse
than one soak fewer. So it is switched on by an explicit, dated act, not left
on by an operator who never set the variable.

The first soak day is also when `max_search_results = 3` stops being a
cap-derived number and becomes a measured one: citations returned per call,
items surviving the evidence gate, and the human-vs-bot split of cited handles
are all recorded, and the dial moves on that evidence.

## Alternatives considered

- **A direct xAI client under an ADR-0009 exception** — what #969 was filed to
  evaluate. Rejected on measurement, not principle: the retired `xAI_API_KEY`
  returns `401 unauthenticated:bad-credentials`, and Nous prices the same
  capability **20% under** xAI's list on every line (1.6 vs 2.0 in, 4.8 vs 6.0
  out, 0.004 vs 0.005 search). The exception would have bought a second vendor,
  a second billing relationship, and a higher price for identical data.
- **Wait for Reddit (#976) and soak with both.** Rejected by David: *"go with x
  now, once reddit replies we will merge reddit."* App Review has no SLA, and
  `social` has been empty since the system was built. `source: 'reddit'` is
  reserved so the merge is additive.
- **Keep the per-call `retrievalEvidence` boolean as the only gate.** Rejected:
  it lets one real citation bless nine recalled items. The per-call flag is
  kept, but now means what #485 wanted it to mean — *did we look* — set from
  whether the tool ran, so that "looked and saw nothing" stays distinguishable
  from "could not look". Setting it from surviving items would have destroyed
  exactly the distinction #485 exists to preserve.
- **Archive the vendor bytes, per the spec.** Rejected pending a terms review;
  see above.
