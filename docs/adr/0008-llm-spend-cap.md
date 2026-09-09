# ADR-0008 — A hard LLM spend cap, and the cadence that sits under it

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decided by:** David — *"for paper trading lets keep 50$ / 14 day budget. can increase for live trading as per decision cruypto 2 min and stock 5 mins."*
- **Related:** [#400](https://github.com/dd-jp/samurai-trading-system/issues/400) (the crypto 2 min / stocks 5 min cadence decision), [#397](https://github.com/dd-jp/samurai-trading-system/issues/397) (Universe Selector — owns per-asset-class cadence gating), [#238](https://github.com/dd-jp/samurai-trading-system/issues/238) (the 14-day soak), [#367](https://github.com/dd-jp/samurai-trading-system/issues/367) (`llm_spend`, the table this reads)

## Context

The 14-day soak's measured cost was ~$45/day, ~$630 for the run, at the 60s
default tick interval over the six-instrument ADR-0001 universe. David set the
paper budget at **$50 for the whole 14 days** — roughly a 13× cut.

Two facts shaped how that can be achieved:

1. **Model choice is not a lever.** Debates already run on
   `claude-haiku-4-5-20251001`, the cheapest model in `pricing.ts`. There is
   nothing cheaper to move to.

   > **Amended by [ADR-0009](0009-single-provider-nous.md) (2026-08-06).** No
   > longer true. That was a statement about a single-vendor price table;
   > moving to the Nous portal reprices the question, and the debate now runs
   > on `openai/gpt-5.6-luna` at roughly $5 per 14 days rather than $42. The
   > rest of this ADR stands — the cap counts dollars against `llm_spend` and
   > does not care which provider produced a row. ADR-0009 reopens cadence as
   > a lever; it deliberately does not pull it.
2. **Cadence is the only lever, and it is an imprecise one.** `startTickLoop`
   is a `setTimeout` **chain**, so a cycle is `pass duration + interval`, not a
   fixed period. Scaling spend proportionally with the interval is therefore an
   **upper bound on the saving**, not a promise — real cost lands above the
   proportional estimate. The $45/day figure it starts from is itself
   indicative rather than measured per call.

So cadence alone can put the run in the right order of magnitude and cannot
guarantee a dollar figure. A budget stated in dollars needs something that
counts dollars.

## Decision

**Both: a cadence sized to fit, and a hard cap that makes it a guarantee.**

### 1. `SpendCap`, checked before a debate is admitted

`server/pipeline/debate-engine/llm/spend-cap.ts`. `SqliteSpendCap` sums `llm_spend.cost_usd`
— the same table `SqliteLlmSpendStore` already writes, priced at write time —
and refuses to admit a debate once cumulative spend reaches the budget.

Distinct from `RateLimiter`, which bounds **calls per window** and refills with
time. This bounds **total dollars** and never refills. A run can sit
comfortably inside its rate limit and still spend a fortnight's budget in three
days; that is exactly the failure a cadence-only plan risks.

It also covers what cadence cannot: a retry storm, a debate running more rounds
than expected, a provider price change, or the estimate simply being wrong. An
unattended 14-day run is where an unmodelled cost multiplies before anyone
looks.

**It fails closed.** This deliberately inverts `SqliteLlmSpendStore.record`,
which swallows its own failures to a `warn` — that is bookkeeping attached to a
call that already happened, and losing a row must never fail a trade. This is a
control read *before* money is spent, so a read it cannot answer must refuse.
The alternative is a locked or drifted database silently removing the only
ceiling on the bill. A refusal short-circuits the tick at Trader with no trade,
which is recoverable; an unbounded bill is not.

Open positions are unaffected by a breach: bracket legs remain live
venue-side, and Execution, reconcile and fill ingestion all keep running. Only
new debates stop.

**A breach escalates, once.** It is routed through the existing
`BreachAlertChannel` — the same channel the Feedback Loop's kill-threshold
breaches use — so on `SAMURAI_ALERTS=telegram` it reaches a phone. This is not
optional polish: a 14-day unattended run with no human approval gate that
silently stops trading on day 4 is *indistinguishable from a quiet market*,
because the heartbeat keeps beating and the ticks keep completing with no
trade. That is the same argument
[#431](https://github.com/dd-jp/samurai-trading-system/issues/431) makes about
a silently-skipping analyst stage. The fail-closed path escalates too — an
unreadable `llm_spend` also stops the system, and unlike a spent budget it is
not something the operator meant to happen.

Once, not per refusal: the cap does not refill, so every subsequent tick
refuses identically, and at a 15-minute cadence that would be ~1,000 identical
alerts over the remainder of the run — which is how an operator learns to mute
a channel that also carries kill-threshold breaches.

**Once per refusal *kind*, though — not once per process.** The two kinds share
an exit path but are unrelated conditions, and one is transient while the other
is permanent. Under a single latch, one `SQLITE_BUSY` would fire the fault
alert, mark the breach announced, and then recover; when spend later crossed
the ceiling the refusal would short-circuit on the already-set latch and reach
nobody. A momentary lock on day 1 would buy the silent stop on day 10 that the
paragraph above exists to rule out, so a transient fault must not be able to
consume the budget breach's one alert.

**The window is the whole `llm_spend` table, and that has a cost worth
stating.** A per-process baseline was considered and rejected: it would hand a
fresh budget to every restart, and a 14-day soak on a MacBook (CLAUDE.md lists
crash-restart as a Key Constraint) *will* restart. Whole-table is the only
definition that survives that. The price is that spend from earlier runs
against the same database file counts — and on this machine that is not
hypothetical: `data/samurai-development.sqlite` already held **196 calls /
$0.38** when this ADR was written, from prior experimentation. So the root
announces the opening total at startup (`LLM spend cap armed: $X of $50 already
recorded … $Y remaining`) rather than letting an operator assume zero. **Start
the soak from a fresh store if it is meant to have the full budget.**

### 2. Cadence: ~~15 minutes~~ **2 minutes** for the paper soak

> **Amended 2026-08-16 by [#670](https://github.com/dd-jp/samurai-trading-system/issues/670) — the cadence is now τ = 2 minutes.** The paragraph immediately below ends "It does not go lower until #617 lands, after which spend stops depending on τ and the optimum jumps to ~1 minute. Sequencing in #670." **#617 has landed**, so that condition is met and this section's headline number is superseded. `paperStartingProfile` now carries `tickIntervalMs: 2 * 60_000`.
>
> **The τ ≥ 3.69 min "independent hard floor" does not survive #617.** It was derived as `0.878 × 15 × 14 / 50` — i.e. from spend scaling with 1/τ, which is precisely the assumption #617 removed. Post-#617 spend is keyed to the debate bar, so a faster tick produces no additional debates and `llmBudgetUsd: 50` is untouched by this change. Cost of the step is ≈0, and that is the point. For the same reason τ\* = 21.8 min no longer describes the optimum: that figure minimised `T(τ) = C/τ + B·√τ` with an LLM cost per tick in `C`, and post-#617 that term is gone.
>
> **What the step buys is exit resolution, not more decisions.** Entries remain gated by `DEBATE_BAR_TIMEFRAME_MS` (1h). The bracket, however, is evaluated every tick, and doc 41 Result 2 measures the conditional tail as `g(D) = 0.525%·√D` on a 3x equity ETP: at τ = 15 a stop overshoots by ≈−1.97% in the worst 5% of exits; at τ = 2 that falls to ≈−0.72%. Against a −2.16% stop, that is the difference between a stop that means what it says and one that does not. (Both figures are at D = τ, the *worst* delay, not the mean — a stop is breached at some instant and noticed at the next tick, so the delay is uniform on (0, τ). Doc 41's own "Solving" section uses D = τ/2 because it is costing an average day rather than bounding a single exit.)
>
> **Why 2 and not the unconstrained optimum of 1.** 2 min leaves ~9x headroom over the measured ~13s pass (120/13) where τ = 1 would leave ~4.6x (60/13) — and the pass duration is a measurement of the system as it was, while section B widens the analyst's indicator set.
>
> **Still not [#400](https://github.com/dd-jp/samurai-trading-system/issues/400)'s decision.** David chose crypto 2 min / stocks 5 min there; those are per-asset-class cadences needing #397's Phase 1, which is not built. There is one base interval for every instrument. And as when the cadence went *slower*, no dial needs retuning: #400 established that `max_signal_age` and `drift_tolerance_pct` both measure within-pass intervals, so the tick interval never enters either gate's arithmetic.
>
> Full derivation is carried in the `tickIntervalMs` docblock at `server/apps/orchestrator/paper-profile.ts`. **Everything below this box is the superseded 15-minute reasoning, preserved as the record of how the number was chosen.**

> **Amended by [#657](https://github.com/dd-jp/samurai-trading-system/issues/657)
> and [#670](https://github.com/dd-jp/samurai-trading-system/issues/670)
> (2026-08-09) — the table below is an estimate and it is wrong by 3.4×.**
> Measured against the soak's actual `llm_spend` (1,151 calls over 42.6h), real
> spend at this cadence is **$0.878/day**, not $3.00 — **25% of the cap, not
> 84%**. The unit is **4 calls, ~13s and $0.0060 per debate run**. Every ticket
> body quoting "$42/14d ≈ 84% of the cap" inherits the estimate and should be
> read against this line instead.
>
> Two further corrections to how this section reasons:
>
> 1. **Passes are not debates.** `debate_log` stores one row per bar, which
>    makes the debate *look* bar-gated. It is not — one `debate_id` spans 46.5
>    minutes across four 4-call clusters, one per tick, because the id hashes
>    the same three inputs. That is
>    [#617](https://github.com/dd-jp/samurai-trading-system/issues/617), still
>    open: 4 runs per bar, 3 discarded and paid for. Price cadence from **runs
>    in `llm_spend`**, never rows in `debate_log`.
> 2. **The cadence optimum is slower than 15 minutes, not faster.** Minimising
>    `T(τ) = C/τ + B·√τ` over measured drift and tail data gives **τ\* = 21.8
>    min**, robust from CVaR25 to CVaR1 and never below 15. The cap alone
>    independently forbids τ < 3.69 min. Derivation and measurement in
>    [`docs/research/41-tick-latency-economics.md`](../research/41-tick-latency-economics.md).
>
> **Net: 15 minutes stands, for better reasons than it was chosen with.** It
> does not go lower until #617 lands, after which spend stops depending on τ
> and the optimum jumps to ~1 minute. Sequencing in #670.
>
> Note also that [ADR-0009](0009-single-provider-nous.md)'s "~$5 per 14 days on
> `openai/gpt-5.6-luna`" does **not** describe the running system:
> `server/shared/llm/nous-config.ts:98` pins
> `debate: 'anthropic/claude-haiku-4.5'`, chosen later on measured latency while
> explicitly accepting the higher bill.

> **Amended 2026-09-03 by [#969](https://github.com/dd-jp/samurai-trading-system/issues/969)
> — the cap now has a SECOND unit, and it is an order of magnitude larger than
> the first.** `$0.0060 per debate run` is unchanged and still describes the
> debate leg; nothing below is withdrawn. What changed is that the market-
> intelligence leg stopped being a rounding error. A sentiment call that
> *retrieves* — the server-side `x_search` tool, live from 2026-09-03 behind
> `SAMURAI_SENTIMENT_RETRIEVAL=on` — carries its search results **in the
> prompt**, so it measures **$0.089** at 10 results and roughly **$0.02** at the
> default 3, against the ~$0.001 a recall-only sentiment call cost.
>
> **The call count has two multipliers, and both were got wrong once each
> before this settled. Re-derive them rather than quoting them.**
>
> 1. **Buckets are session-derived.** `UniverseScheduler.nextTick` returns an
>    empty instrument list when the calendar says closed, so the sentiment
>    refresh never fires outside the session: a 6.5h US session touches **4**
>    two-hour buckets, not the 12 a first draft read off a calendar.
> 2. **The universe is 20 names.** [#1051](https://github.com/dd-jp/samurai-trading-system/issues/1051)
>    widened `DEFAULT_UNIVERSE` from 3 to 20 while the #969 branch was open.
>
> So the soak is **20 x 4 x 10 sessions = 800 calls** — **~$16** at the default
> 3 results, **~$71** at 10, alongside #1051's ~$8.40 debate leg.
>
> **This cap therefore DOES bind the MI leg, and at 3 results the MI leg is now
> the LARGER of the two** (~$16 against ~$8.40) — the first time anything has
> outweighed the debate under this cap. Together ~$24, about half the ceiling.
>
> **`SAMURAI_X_MAX_RESULTS=10` on a 20-name universe does not fit.** The clamp
> to 10 bounds an operator TYPO; it does not bound the budget. What bounds the
> budget is this cap, and it fails closed — a breach short-circuits the tick —
> so the failure is the soak **going dark partway through**, invalidating the
> experiment rather than overspending. Better failure, still a failure. On the
> live LSE pool (7 underlyings) the annual figures are ~$141/yr at 3 and
> ~$630/yr at 10, against a ~$74/yr debate leg.
>
> **Two metering corrections were required before this could run unattended**,
> both of which had been under-counting: Nous reports **OpenAI-inclusive**
> usage (`cached_tokens` is a subset of `prompt_tokens`, not disjoint as
> `AnthropicUsage` means it), and the vendor applies a **large-prompt tier**
> above 200k prompt tokens that `pricing.ts` did not model. A cap that
> under-counts is not a cap. [ADR-0020](0020-x-retrieval-through-nous.md)
> carries the full regime; the range above is a **range, not a point**, until
> reconciled against the provider's invoice.

> **Amended 2026-09-04 by [#1085](https://github.com/dd-jp/samurai-trading-system/issues/1085)
> — three sentences of the #969 amendment above are now false, and the
> correction is in the MI leg's favour on one count and against it on another.**
> Nothing about the debate leg changes; the figures are untouched.
>
> **1. "This cap therefore DOES bind the MI leg" was only ever half true.**
> `GrokAgent` reads the cap before it calls. `MiIngestAgent` — the news-scoring
> half — does not, and never did: it scores through the shared `LlmClient`,
> which METERS into `llm_spend` but is gated by nothing. *(Superseded
> 2026-09-09 — #1106 landed; see the amendment box below. `MiIngestAgent` now
> reads the cap before it calls too.)* So the sentiment half was bound and the
> news half was merely counted. #1085's `MiRefreshQueue` checks the cap once
> per composed MI pass and is the first ceiling the news path has ever had.
> Read the pre-#1085 MI figures as a floor on what could be spent, not as a
> bound.
>
> That check covers both agents at once, which makes the composition ORDER at
> the root load-bearing (ingest first, so Grok's own read sees the post-ingest
> total). Documented at the call site, pinned by test on total spend, and
> [#1106](https://github.com/dd-jp/samurai-trading-system/issues/1106) removes
> the invariant by giving `MiIngestAgent` its own cap. *(Superseded 2026-09-09
> — #1106 landed; see the amendment box below. The order is no longer
> load-bearing.)*
>
> **2. "It fails closed — a breach short-circuits the tick" no longer describes
> the MI leg.** It still describes the debate leg exactly: `debate-adapter.ts`
> refuses at `error` and the tick short-circuits at Trader with `no_trade`. An
> MI breach does NOT do that. It warn-logs under the `mi-refresh` trace id and
> the tick continues, with the news-fed analysts reporting `NO_DATA_MARKER`.
> That is deliberate — the MI seam's standing promise is that an outage
> degrades the debate rather than failing a tick that would otherwise have
> traded.
>
> **It does not follow that the soak trades on blind.** There is ONE
> `SqliteSpendCap` over the whole of `llm_spend` and no per-stage sub-budget:
> the same instance is handed to the MI queue, the debate step and the Risk
> Critic. So `spent >= budget` at an MI check implies the same at the debate
> check, and the debate leg's own refusal short-circuits at Trader with
> `no_trade` exactly as this ADR says. **The soak DOES go dark and the trade
> count DOES go to zero** — through the debate leg, not the MI one. The only
> window where MI is refused while trading continues is a transient: spend
> crosses the ceiling after a tick's debate was already admitted, and MI's
> refusal (which since #1085 drains off the tick's stack, so its check can land
> anywhere relative to a debate) reports first.
>
> **The thing to record is the shape of the risk, not a present failure mode.**
> Give MI its own sub-budget — a plausible next step, and the direction
> [#1106](https://github.com/dd-jp/samurai-trading-system/issues/1106) points —
> and the transient becomes a steady state: MI exhausted, debate still funded,
> the desk **trading on a debate that has stopped hearing from its news and
> sentiment analysts**, which is quiet and hard to detect. Anyone adding a
> per-stage budget owes an answer to that before it ships.
>
> Until then the operator signal for a budget breach is the DEBATE refusal line
> (`stage: 'debate'`, level `error`, "not started"), which is what actually
> stops the desk. The `mi-refresh` warn line tells you the ceiling was reached;
> it does not by itself tell you trading continued.
>
> **3. The single breach alert is now more likely to be spent by MI.**
> `SqliteSpendCap.#refuse` latches `#budgetAnnounced` on the first refusal of
> ANY kind, and the first refusal is now much more likely to be an MI one,
> because MI checks the cap on a path that previously did not. The alert body
> itself is stage-agnostic (`breaches: ['llm_spend_cap']`), so nothing is
> misphrased and the operator is told the true thing — the budget is gone. What
> they are NOT told separately is that the debate leg has since stopped too:
> its own first refusal escalates nothing, leaving only its `error` log line.
>
> Left as one latch deliberately. A per-stage latch would emit several alerts
> for one budget, which is the thing the latch exists to prevent, and the
> breach is a single fact about a single ceiling. Recorded here so the next
> reader meets it in the ADR rather than during an incident.

> **Amended 2026-09-09 by [#1106](https://github.com/dd-jp/samurai-trading-system/issues/1106)
> — the composition-order invariant point 1 above records is now resolved, not
> merely pointed at.**
>
> `MiIngestAgent` reads its own `SpendCap` before `scoreItems`, the same seam
> `GrokAgent` already read before its own call. The paragraph above ("That
> check covers both agents at once, which makes the composition ORDER at the
> root load-bearing...") no longer describes production:
> `composeMarketIntelligence([miIngestAgent, grokAgent])`'s array order is not
> load-bearing any more — either agent refuses on a breach whichever one the
> queue's single pre-pass check admits second, and that check is now a cheap
> outer bound on the whole composed pass rather than the only ceiling either
> agent has.
>
> Point 3 above still holds and is now stronger, not weaker: with BOTH MI
> agents self-gating, the single `#budgetAnnounced` latch is claimed by
> whichever of the three checkers (`MiIngestAgent`, `GrokAgent`, the debate
> step) reaches a breach first, so an MI refusal is at least as likely to
> consume the one alert as it was before — the per-stage-latch mitigation
> named there remains undone.

`paperStartingProfile` now carries `tickIntervalMs: 15 * 60_000`, up from the
60s `DEFAULT_TICK_INTERVAL_MS`, and `llmBudgetUsd: 50`. *(Superseded 2026-08-16
— it now carries `2 * 60_000`; see the amendment box above. `DEFAULT_TICK_INTERVAL_MS`
itself is unchanged at 60s.)*

Taking #400's instrument-pass arithmetic (2 × 1,440 crypto + 4 × 390 stocks =
4,440 passes/day at 60s):

| Interval | Passes/day | ≈ $/day | ≈ $/14d |
| --- | --- | --- | --- |
| 60 s (today) | 4,440 | $45 | $630 |
| 12.6 min (exact fit) | 352 | $3.6 | $50 |
| **15 min (chosen)** | **296** | **$3.0** | **$42** |

15 minutes rather than the 12.6 the budget divides to exactly: the saving is an
upper bound, so the margin is deliberate, and a round number is easier to read
in a soak log.

**No dial needs retuning to go slower.** #400 established that
`max_signal_age` and `drift_tolerance_pct` both measure *within-pass* intervals
— `decision_timestamp` is the pass's own `mark.observed_at`, and `getMark`
re-fetches unconditionally with no TTL cache — so the tick interval never
enters either gate's arithmetic, at any cadence.

## What this does NOT do

**It does not overturn #400.** David chose crypto 2 min / stocks 5 min there,
and that decision stands for a run with a live budget. Two reasons it is not
what the paper soak runs at:

1. Those are **per-asset-class** cadences. The gating that makes them
   expressible is #397's Phase 1, which is not built — today there is one base
   interval for every instrument.
2. At 2 min / 5 min the soak would spend $50 in roughly three days and then
   halt on the cap, which is not a 14-day soak.

A live run supplies its own `tickIntervalMs` — and, once #397 lands, its own
per-class cadences — from a composition root with a live budget.

## Consequences

### The budget and "the soak produces learning-layer evidence" are in tension

At ~296 passes/day across six instruments, few passes produce a trade. Three
things follow, and they should be said plainly rather than discovered later:

- `cosine_setups` will hold single digits, so precedent-based sizing has almost
  nothing to retrieve.
- Feedback Loop attribution runs over near-empty samples.
- ADR-0006 gates Sharpe/drawdown at 60 observations; the run will not reach it.

**The soak's deliverable at this budget is plumbing evidence** — crash-restart,
reconcile-before-ingest, fill lifecycle, idempotent order IDs, breaker arming,
and the cap itself holding. It is not evidence about the strategy or the
learning layers. Stage 2's verdict is independently KILL (PBO 0.65/0.30 against
a 0.05 line; DSR 0.255/0.519 against 0.95), so there is no edge the soak is
being asked to confirm.

### Wiring discipline

`buildDebateStep` takes `spendCap` as a **required positional argument** — the
third dependency in that signature to be required for the same reason (#364,
#388): an optional budget control is one the composition root will eventually
drop. `UNCAPPED_SPEND` is the explicit way to say "no ceiling", so that choice
is visible at the call site rather than being the default.

The check runs **before** `rateLimiter.reserve`, which mutates counters —
booking a window for a debate the budget will refuse would burn allowance a
later admissible debate needs. Pinned by test.

An absent `llmBudgetUsd` warns loudly at startup rather than defaulting
silently, the same posture `SAMURAI_ALERTS` takes: no safe default, say what
was chosen.

### Amendment 2026-09-04 (#1080) — the cap's sum is a floor, and the size of the gap is now readable

`SqliteSpendCap` sums `llm_spend.cost_usd`, and `llm_spend` holds a row only
for an LLM call that **returned**: `AnthropicLlmClient.recordSpend` is
unreachable from the timeout and error paths, because a failed call carries no
usage block to read. Every attempt the provider generated and billed but that
never came back is therefore missing from the cap's arithmetic, and the
ceiling this ADR enforces is looser than $50 by exactly that amount. The
direction of the error is the unsafe one.

That was already stated at the writer as "a known floor, not an oversight".
What #1080 adds is a measurement and a way to keep measuring it:

- **Measured.** In the 2026-09-03 paper session, at least 9 of the 26
  timed-out debates contained a full 30s attempt that timed out and was
  retried — provably, because one attempt is bounded by
  `AnthropicLlmClientConfig.timeoutMs`, so any interval between consecutive
  logged calls that exceeds it must contain one. One debate (`9d9e505f3493`)
  consumed its entire 60s budget with **zero** `llm_spend` rows. At the
  session's mean metered debate-call cost of $0.002332, those attempts are a
  floor of roughly **$0.021** the cap could not see.
- **Readable.** `AnthropicLlmClientConfig.onRetryAttempt` now logs every
  retried attempt at `warn` with its elapsed milliseconds
  (`llm retry: <model> attempt N of M failed after Xms …`), wired at the
  composition root. The rows are still not written — the information does not
  exist client-side — so the sum remains a floor, but a floor whose size can
  be checked against the log instead of inferred from timestamp gaps.

The retry schedule itself is now bounded by the latency budget it runs inside:
`maxAttempts * (timeoutMs + maxDelayMs) <= LATENCY_BUDGET_MS.stocks`, pinned by
test in `production.test.ts`. Before #1080 that product was 64,000ms against a
60,000ms budget — one logical call could, alone and invisibly, exceed the
deadline it was supposed to be helping the caller meet.
