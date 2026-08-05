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

`src/debate-engine/llm/spend-cap.ts`. `SqliteSpendCap` sums `llm_spend.cost_usd`
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

### 2. Cadence: 15 minutes for the paper soak

`paperStartingProfile` now carries `tickIntervalMs: 15 * 60_000`, up from the
60s `DEFAULT_TICK_INTERVAL_MS`, and `llmBudgetUsd: 50`.

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
