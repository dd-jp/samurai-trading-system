# Universe Selector Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-08-07
**Wayfinder map:** [Wayfinder: Universe Selector (Stage 0) + tick cadence gating](../../issues/397) — closed 2026-08-06, all four children resolved ([#398](../../issues/398), [#399](../../issues/399), [#401](../../issues/401), [#402](../../issues/402); [#400](../../issues/400) resolved and then superseded).

## Corrections to map #397's body — read before the rest

The map's body was written 2026-08-05 and four of its factual claims no longer hold. They are corrected here rather than silently rewritten downstream, because each one changes what gets built.

1. **Cadence is not this effort's Phase 1, and #400's numbers are dead.** The map builds its economics on "crypto 120 s, stocks 300 s → ~1,752 passes/day". [ADR-0008](../adr/0008-llm-spend-cap.md) supersedes that one day later with **a single 15-minute interval** for the paper soak (~296 passes/day, ≈$42 against the $50/14-day cap), already shipped in `paperStartingProfile`. The cost problem cadence gating was sequenced first to solve **is already solved, harder**. Per-asset-class gating survives as a later refinement, not the lever that makes the budget work. Every "−61%" / "−50%" figure on the map is against a baseline that no longer runs.

2. **The screener's data source is Alpaca, not Polygon.** The map's Phase 3 specifies "Polygon daily bars via `HttpPolygonClient.fetchAggregates`". [ADR-0001's 2026-08-06 appendix](../adr/0001-technical-foundation-hybrid.md) — landed *after* the map body — makes **Alpaca free Basic** the equities primary (`feed=sip&adjustment=raw`, 10.5 years of unadjusted dailies, 200 req/min) and demotes **Polygon free** to an increment-only fallback with a **2-year window and 5 req/min**. A ~100-name screener run on Polygon free would take 20 minutes of pure rate-limit waiting and could not see a 3-year lookback; on Alpaca it is one or two requests. See "Market data" under Implementation Decisions.

3. **`config.universe` is resolved at two composition sites now, not three, and the default is `SMOKE_TEST_UNIVERSE`.** The map cites `production.ts:1126`, `:1259`, `:1453` plus a `tradingCalendar` re-resolution bug. The current shape is two independent `config.universe ?? SMOKE_TEST_UNIVERSE` resolutions — one where the market-data source and routing map are built, one where `UniverseScheduler` is constructed — each pairing with its own `config.tradingCalendar ?? new UsEquityRegularHoursCalendar()`. The duplication is milder than the map describes but the hazard is identical and is what makes the provider a single-construction requirement below.

4. **`atr` is not an exported symbol.** The map and [#398](../../issues/398) both cite `indicators.ts:75` as if `atr` were importable. It is a module-private function; the public surface is `computeIndicator(bars, spec)` and `minimumBarsFor(spec)`, with `'atr'` as one indicator kind. This is a real decision for the implementation ticket, not a typo — see "Axis computation".

One further map claim is stale in a way that only affects an open question: the map says "none of the three existing alert transports covers" a stale watchlist. `ALERTS_MODES` is `['telegram', 'log-only']` — **two** modes, not three transports. The gap the map names is real; its count is not.

## Problem Statement

Samurai trades a hardcoded six-name universe. `DEFAULT_UNIVERSE` is SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD, and every tick asks the full pipeline the same question about the same six names — regardless of whether anything moved, and regardless of whether a better opportunity existed anywhere else that day.

Two costs fall out of that, and only one of them is money.

**The system cannot look for opportunity.** There is no opportunity-ranking capability anywhere in the repo. Re-asking six fixed names on a schedule is coverage of a list, not a search for an edge — and the list was chosen for liquidity and familiarity when the goal was a working pipeline, not because those six are where the moves are. David's ask (2026-08-05): an out-of-hours job that shortlists stocks worth monitoring next session, so the tick loop spends its budget on breadth instead of repetition.

**Spend is bounded, so breadth is not free.** ADR-0008 caps LLM spend at $50 per 14 days and buys headroom with a 15-minute tick interval. Widening the universe spends that headroom. Any selector has to be judged on whether the names it picks are worth more than the names it displaces — which means the selection has to be recorded well enough to be second-guessed after a bad session.

Three documents currently record the opposite decision — that v1 is deliberately *not* a scanner (`orchestrator-spec.md` §25 and §245, `analysts-spec.md` §245, and the historical `docs/wayfinder/orchestrator-map.md`). This spec reverses that, and amends all three.

## Solution

The **Universe Selector** is an out-of-session batch job that decides which equities the next trading session is worth spending on.

It runs out of hours, ranks a checked-in candidate pool (S&P 100 for v1) on three opportunity axes, and emits a **watchlist** of 5–10 names. At the next session boundary the Orchestrator's active list becomes that watchlist, plus any instrument Samurai currently holds a position in, plus the fixed crypto pair. Within a session the active list never changes.

Three properties define it, and each one is a decision made on the map rather than a preference:

- **It selects; it does not trade.** The screener's whole output is a list of names. It has no view on direction, size, or entry — Analysts, Debate, Trader and Risk are unchanged and unaware they are being handed a different list than yesterday.
- **It cannot drop a name Samurai holds.** An instrument with an open position stays in the active list regardless of rank. Under [ADR-0007](../adr/0007-fully-automatic-execution.md) there is no human gate to notice a held position that stopped being monitored, so this is an invariant, not a feature.
- **It fails toward the known-good universe.** A stale, empty or unreadable watchlist falls back to `DEFAULT_UNIVERSE` and alerts. It never falls back to an empty list, which would silently halt all trading while every health signal stayed green.

The crypto pair is out of the screener's reach entirely: BTC-USD and ETH-USD are always active, always 24/7, and are not ranked against equities.

## User Stories

1. As David, I want an out-of-hours job to shortlist the equities worth watching tomorrow, so that the tick budget buys breadth instead of re-asking the same six names.
2. As David, I want the shortlist to come from a candidate pool I can read in a diff, so that the set of names Samurai will ever trade changes only when someone approves a commit.
3. As David, I want the pool to be a config value, so that moving from the S&P 100 to the S&P 500 is a dial rather than a rewrite.
4. As David, I want the pool refreshed manually each quarter following index reconstitution, so that membership tracks the index without a vendor integration on the startup path.
5. As David, I want each screener run to log the shortlist together with the inputs that produced it, so that after a bad session I can tell whether the ranking or the trading was at fault.
6. As David, I want the ranking weights and the eligibility threshold to be config, so that paper trading can tune them without a code change.
7. As David, I want the weights recorded as UNSOURCED tuning, so that nobody later mistakes an arbitrary starting point for a derived constant.
8. As David, I want a name I hold a position in to stay monitored even when it ranks last, so that an open position always has an exit path.
9. As David, I want the shortlist to change only at a session boundary, so that a tick can never start against one universe and finish against another.
10. As David, I want a name that enters the shortlist to stay for at least the next session, so that a name at the rank boundary does not oscillate in and out on daily noise.
11. As David, I want to see what entered, held, was pinned, and dropped each session, so that churn is reviewable rather than inferred.
12. As David, I want a stale or empty watchlist to fall back to the default six names and raise an alert, so that a broken screener degrades to today's behaviour instead of halting trading silently.
13. As David, I want the screener to be idempotent, so that a re-run after a crash produces the same watchlist rather than a second, different one.
14. As David, I want the screener to run against completed daily bars only, so that its decisions cannot depend on a partially-formed bar.
15. As the Universe Selector, I want to read daily bars for the whole candidate pool in a small number of batched requests, so that a 100-name run finishes in seconds and stays far inside the data provider's rate limit.
16. As the Universe Selector, I want a hard liquidity gate applied before any scoring, so that a name too thin to trade never competes for a slot.
17. As the Universe Selector, I want each opportunity axis converted to a percentile within the surviving pool, so that three quantities on different scales are commensurable.
18. As the Universe Selector, I want percentiles computed after the liquidity gate, so that excluded names cannot distort the distribution the survivors are ranked against.
19. As the Universe Selector, I want a name to be top-quartile on at least one axis to enter the ranking, so that a name mediocre on all three cannot outrank a genuine standout.
20. As the Universe Selector, I want to emit only names present in the pool I was given, so that a pick can never reach the routing layer as an unknown instrument.
21. As the Universe Selector, I want to write the watchlist as a complete replacement rather than a merge, so that a partial write cannot leave a half-old, half-new list.
22. As the Orchestrator, I want the active list supplied by a provider rather than a static config value, so that the list can change between sessions without a restart.
23. As the Orchestrator, I want the provider to own pinning, minimum hold, and top-N fill, so that the scheduler never grows a dependency on the execution store.
24. As the Orchestrator, I want the universe resolved once and shared between the routing map and the tick plan, so that market-data routing and instrument iteration cannot disagree.
25. As the Orchestrator, I want the data-source routing map built over the whole candidate pool rather than the active list, so that an active-list change never produces an unknown-instrument throw mid-session.
26. As the Orchestrator, I want the crypto pair always present in the active list, so that 24/7 coverage is unaffected by an equities screener that did not run.
27. As the Orchestrator, I want the existing stocks-market-closed filter to keep working unchanged, so that a widened equity list still never ticks into a closed market.
28. As an operator, I want `yarn screener` to run the selection by hand, so that I can inspect tomorrow's list before the session opens.
29. As an operator, I want the screener scheduled out of hours by launchd, so that selection never competes with the tick loop for rate limit or CPU.
30. As an operator, I want a screener failure to leave yesterday's watchlist in place and alert, so that one bad run does not cascade into a lost session.
31. As a reviewer, I want the pool's provenance recorded with a date and a source, so that "where did this list come from" has an answer a year later.
32. As a reviewer, I want a test asserting a held name survives a re-rank that would otherwise evict it, so that the pinning invariant is enforced rather than documented.
33. As the Feedback Loop, I want attribution to keep aggregating by analyst across a rotating universe, so that rotation neither fragments nor rescues the sample.
34. As David, I want cadence gating kept as a separate, later refinement, so that this effort's value does not depend on re-opening a spend decision ADR-0008 already settled.

## Implementation Decisions

### Naming — the Universe Selector is not "Stage 0"

The map inherits the label "Stage 0" from `docs/research/07-stock-selection-manipulation-guardrails.md`, and it collides. `CONTEXT.md` already uses Stage 0 for the **data layer** — Market Intelligence is "the news/sentiment half of the Stage 0 data layer" and the Market Data Service is "a dedicated Stage 0-level data layer, parallel to Market Intelligence". `src/market-data-service/types.ts` says the same in code.

Resolved: **the Universe Selector is not a pipeline stage at all.** It runs *between* sessions, not inside a tick, and produces configuration for the next session rather than a decision within one. It is the **pre-session selector**; the pipeline it feeds still starts at Stage 0's data layer. `CONTEXT.md` gains the term with this disambiguation.

### Module and entrypoint

A new `src/universe-selector/` module with a `yarn screener` entrypoint, scheduled out of hours by launchd. It is a batch program, not a service: it reads bars, ranks, writes a watchlist, exits. It holds no state between runs beyond the watchlist itself.

### The selection pipeline (#398)

```
candidate pool
  → liquidity gate            (hard filter, not a ranked axis)
  → PERIL reject              (absent — Phase 4, out of scope here)
  → per-axis percentile       (computed over survivors only)
  → top-quartile-on-one gate  (eligibility)
  → weighted sum of percentiles
  → top-N (5-10)
```

**Blended score over percentile-ranked axes, not partitioned slots.** Partitioned slots (N breakout + N mean-reversion) pre-commit shortlist capacity to a strategy family, and the Stage 2 re-run reported no edge surviving selection for the one mechanical strategy this repo has tested (PBO 0.85 stocks / 0.55 crypto). Committing the scarcest resource in the system to an untested taxonomy is not justified, and partitioning would need a second undecided rule for unfillable buckets.

**Percentile-ranking, not a raw weighted sum.** High ATR% and an extreme range position co-occur, so summing raw values double-counts volatility twice over — once on scale, once on correlation. Percentiles remove the scale half outright and bound the correlation half: two correlated axes can contribute at most their combined weight rather than compounding arbitrarily.

**Equal starting weights, recorded as UNSOURCED tuning** in the same style as every other threshold in `paper-profile.ts`. There is no basis for anything else and inventing one would be fabrication.

**Eligibility: top-quartile on at least one axis.** This closes the "mediocre everywhere outranks a standout" flaw without partitioning, keeps one ordering and one dial, and is falsifiable — if the gate empties the shortlist, the quartile is wrong and the log says so.

**Percentiles are computed after the liquidity gate**, over survivors only. Ranking against already-excluded names distorts every percentile by the size of the excluded set.

Both the weights and the quartile threshold are config, and **the shortlist must be logged with the inputs that produced it**. A ranking whose inputs are not recorded cannot be second-guessed after a bad session.

### Axis computation

Three axes, all computable from daily bars: **volatility** (ATR as a percentage of price), **gap/momentum**, and **range position**.

ATR already exists but is **not reachable**: `atr()` in `src/market-data-service/indicators.ts` is module-private, and the public surface is `computeIndicator(bars, spec)` / `minimumBarsFor(spec)` with `'atr'` as an indicator kind. Two options, and the choice matters for consistency rather than effort:

- **Preferred:** export the existing implementation (or call it through `computeIndicator`), so the screener and the live Trader compute ATR identically. The live path's ATR feeds bracket construction; a screener that ranked on a *different* ATR would be selecting for something the trader does not see.
- **Rejected:** reimplement ATR inside the selector. Cheap now, and guarantees the two drift.

Gap/momentum and range position are new pure functions over `Bar[]`, in the same shape as the existing indicator functions — no new port, no service dependency.

### Market data — Alpaca free Basic, batched, SIP-pinned, out of hours

Per [ADR-0001's 2026-08-06 appendix](../adr/0001-technical-foundation-hybrid.md), equities daily bars come from **Alpaca free Basic** with `feed=sip&adjustment=raw`. Polygon free is the increment-only fallback (2-year window, 5 req/min) and is **not** an acceptable screener source, contra the map body.

Three consequences the implementation ticket must carry:

- **Batched multi-symbol reads, not the single-symbol port.** `MarketDataService` is strictly single-symbol and its `BarWindow.partial` defaults to `'error'`; the screener instead reads `/v2/stocks/bars?symbols=<comma list>` directly at the HTTP-client level. The row cap is `limit=10000` with a `next_page_token`; ~100 names × a few months of dailies is a handful of thousand rows, so a run is one or two requests against a 200 req/min budget. Rate limit is a non-issue; the row cap is the only pagination concern.
- **The screener pins `feed=sip`; the live tick path must not.** `DEFAULT_ALPACA_DATA_FEED` is `'iex'` and that default is load-bearing: a Basic subscription 403s on SIP data from the last ~15 minutes, which is exactly what a live tick asks for. The screener asks only for **completed daily bars, out of hours**, so the embargo cannot bite and it gets the full SIP archive. **The screener therefore constructs its own data client rather than reusing the tick loop's.**
- **Completed bars only.** The run must exclude any partially-formed session bar, so that a re-run at a different minute of the same evening produces the same watchlist (story 13/14).

### Candidate pool (#401)

**A checked-in static list with dated provenance, refreshed manually, quarterly**, following index reconstitution. A vendor call for a 100-name list that changes a few times a year is disproportionate — a new integration, a new credential, and a new failure mode on the startup path, for public and nearly-static data.

The pool is **load-bearing for routing, not just an input to scoring**. `AssetClassRoutingDataSource` builds its instrument→asset-class map at construction and deliberately **throws** on anything outside it (`#routeFor`, per [#358](../../issues/358): routing to a default would hit the wrong API root and 404 silently). So:

- The **routing map binds over the pool**; everything usage-priced binds over the **active list**.
- **The screener is constrained to the pool as its input, not filtered against it afterwards.** If the two ever diverge, the symptom is a throw mid-session on a name the screener itself chose — the worst possible place to find out. The implementation must assert directly that a run cannot emit a name absent from the pool it was given.
- Pool membership changes require a **process restart**. Acceptable, because reconstitution is quarterly, but it has to be a stated cadence rather than an accident.

Pool size is a config value (S&P 100 for v1) so the S&P 500 is a later dial. Nothing above the pool cares which index it is.

**`InstrumentRegistry` is not reused.** The port at `src/cost-model-backtest/universe.ts` answers a different question — `membershipDuring(window)` is *point-in-time* membership for survivorship-free backtesting, paired with `SurvivorshipViolationError`. The live pool is a present-tense list with no window and no survivorship assertion. Reusing the port would force a fake window argument and inherit a guard that means nothing here.

### The active list and rotation (#399)

**`ActiveUniverseProvider` is a new port owning three things in order:** pin held positions → apply the one-session minimum hold → fill remaining slots from the new top-N.

- **Pinning is the invariant.** An instrument with an open position stays regardless of rank. The provider takes the same sync `getOpenPositions` accessor the risk dependencies already bind, so the scheduler never grows an execution-store dependency.
- **Full re-rank each session, one-session minimum hold.** Full rotation with no hysteresis churns names sitting at the rank boundary on daily noise, and every entry costs a warm-up the system pays and discards. A long hold defeats re-ranking. One session is the shortest hold that breaks the oscillation and short enough that a genuinely dead name is gone in a day. Like the weights, this is a dial with a stated basis, and entry/exit churn per session is what a soak should watch.
- **Changes apply only at a session boundary — this is correctness, not taste.** The tick loop is a self-scheduling `setTimeout` chain with a single in-flight guard, and the routing source throws on unknown instruments. Mutating the active list mid-session means a tick can start against one universe and finish against another, and an in-flight instrument that has just left the list is exactly the throwing case. The list is **immutable within a session** and swaps at the boundary, alongside the existing stocks-market-closed filter in `UniverseScheduler.nextTick`. The pin is evaluated at that same moment — held names are carried into the next list *before* the top-N is applied, not patched in afterwards.
- **No decay.** The minimum hold already provides the smoothing a decay schedule would, in one dial instead of two, and decay would leave a name consuming instrument-passes at partial weight with no rule for when it stops. Under a hard spend cap, "partially in the universe" is not a state worth the arithmetic.
- **Log the transition each session:** entered, held, pinned, dropped.

### One universe, resolved once

`config.universe ?? SMOKE_TEST_UNIVERSE` is currently resolved independently at two composition sites — where the market-data source and routing map are built, and where `UniverseScheduler` is constructed — each with its own `config.tradingCalendar` fallback. Introducing a provider on top of that duplication would let the routing map and the tick plan disagree about what the universe is.

**The provider is constructed once and shared**, and the calendar with it. This is the same class of defect the routing source's throw exists to catch, moved one level up.

### Cadence gating — kept, demoted, separate

Per-asset-class tick intervals remain worth doing (crypto is ~65% of passes and does not need equities' treatment) but are **explicitly not sequenced first**, because ADR-0008's single 15-minute interval already solved the cost problem cadence gating was first for.

When it is built, the shape is settled: **a filter inside `Scheduler.nextTick`, not a second timer.** `startTickLoop` is a self-scheduling `setTimeout` chain whose single in-flight guard stops overlapping ticks multiplying concurrent LLM calls past `maxConcurrentInstruments`; a second timer breaks that guard and can write duplicate `current_tick` rows. One base clock, filtered — the same seam the active list uses.

### Feedback Loop — no change (#402)

Attribution keys credits on `analyst_id` alone, with no instrument in the key, so it is already aggregated globally across the universe. A rotating shortlist produces exactly as many observations per analyst as a fixed universe producing the same number of closed trades. No aggregation change is needed — not per-sector, not per-asset-class.

The real constraint is sample *size* (~296 instrument-passes/day at ADR-0008 cadence, few of which close a trade), and rotation neither helps nor hurts it. A screener that shortlists names more likely to move *should* produce more closed trades per day — a hypothesis, not a claim.

### Failure modes, specified rather than discovered

- **Idempotent runs.** Re-running the screener for the same session produces the same watchlist. Completed-bars-only is what makes this true in practice.
- **Stale/empty watchlist falls back to `DEFAULT_UNIVERSE` and alerts.** Never to an empty list. An empty active list is a total trading halt that presents as a healthy system: heartbeat green, no errors, no ticks. Staleness is judged against the session the watchlist was written for, not the file's age.
- **A failed screener run leaves the previous watchlist in place** and alerts, rather than writing a partial one.

## Testing Decisions

Good tests here assert **external behaviour at the highest seam available** — the shortlist a pool and a set of bars produce, and the active list a provider produces — never the internals of the scoring arithmetic. Prior art: the same seam discipline as every other stage spec (one high-level function, fakes for dependencies, assertions on outputs and side effects).

Four seams, in descending preference:

1. **`Screener.select(pool, bars) → Watchlist`** — the whole selection pipeline as one pure function over injected bars. Covers ranking, the liquidity gate, the eligibility gate, percentile ordering, and top-N with no HTTP and no clock. Table-driven cases: a name mediocre on all three axes is excluded by the eligibility gate; two correlated axes cannot compound past their combined weight; percentiles over survivors differ from percentiles over the full pool; a pool of one behaves sanely.
2. **`ActiveUniverseProvider.forSession(...) → readonly UniverseInstrument[]`** — pin, hold, fill. The invariant test is named on [#399](../../issues/399) and is non-negotiable: **a held name ranked last survives a re-rank that would otherwise evict it.** Plus: a name entering stays through the next session; a dropped name with no position is gone at the boundary and not before; pinned names are carried in before top-N is applied; crypto is always present.
3. **Pool containment** — a screener run cannot emit a name absent from the pool it was given, asserted directly rather than left to the routing throw to discover at fetch time.
4. **Fallback behaviour** — an unreadable, empty, or stale watchlist yields `DEFAULT_UNIVERSE` and raises an alert; a failed run leaves the prior watchlist intact. Assert the alert fires, not just that the list is right: the silent-halt failure mode is the one worth a test.

The batched Alpaca read is tested at the existing HTTP-client seam (fake fetch, assert the request shape — symbol batching, `feed=sip`, `adjustment=raw`, completed-bars window, pagination on `next_page_token`), matching how the existing Alpaca client tests are written. No live network in unit tests; one manual run against the real endpoint is the wiring check, as with every other external client in this repo.

## Out of Scope

- **The PERIL gate** — manipulation-vulnerability rejection from `docs/research/07-stock-selection-manipulation-guardrails.md`. It needs a fundamentals vendor the repo does not integrate, and the map assigns it **its own wayfinder map**. The pipeline above leaves the slot where it goes.
- **Crypto screening.** BTC-USD and ETH-USD are fixed and always active. Ranking crypto against equities, or selecting among crypto pairs, is not this effort.
- **The S&P 500 widening.** v1 is the S&P 100; 500 is a config dial whose cost implications (and the shortlist-vs-limiter question below) are not evaluated here.
- **Cadence gating implementation.** Kept as a later refinement with its shape settled, not built here — see above.
- **The no-new-bar skip gate** (map Phase 2b). Nothing today skips an instrument whose price has not moved; adding it requires `Scheduler.nextTick` to become `async` and it must **fail open** — a gate that cannot read data plans the instrument *in*, never out, or a data-provider 403 silently halts trading. Separate work, separate ticket.
- **Weight optimization.** Equal weights are a starting point tuned in paper trading, not something this spec derives or a later ticket fits.
- **Any change to Analysts, Debate, Trader, Risk, Verdict or Execution.** They receive a different list of names and are otherwise untouched.

## Open Questions

These are **not** resolved by the map or its children, and are named here rather than decided, because a spec that quietly settles them would launder an undecided fork into an implementation ticket.

1. **Where does the watchlist live?** Two defensible shapes, and the map never chose:
   - *A row in the shared SQLite store* — one store for all state, queryable by the dashboard, but a migration and invisible to review.
   - *A generated JSON artifact on disk* — matches the checked-in-pool precedent from [#401](../../issues/401) and is readable before a session, but adds a second persistence mechanism and a file-permissions failure mode.
   The staleness check and the fallback trigger are defined against whichever is chosen, so this blocks the implementation ticket.
2. **Where does a stale-watchlist alert go?** `ALERTS_MODES` is `['telegram', 'log-only']`. `log-only` cannot wake anyone, and Telegram is currently wired for trade notifications and the heartbeat. Whether this reuses the heartbeat channel, adds an operational-alert channel, or gets its own transport is undecided — and "it alerts" is load-bearing for the silent-halt failure mode above.
3. **Does shortlist size collide with the LLM budget window?** `LLM_BUDGET_WINDOW_MS` is 300 s and `STOCKS_MAX_DEBATES_PER_WINDOW` is 15. Whether a 10-name shortlist fits inside one window depends on per-stock-debate duration: under ~30 s/debate the whole shortlist lands in one window (10/15, and >15 names would be rejected outright); at ~60 s/debate it spans two-plus windows and the ceiling is nowhere near binding. `maxConcurrentInstruments` defaults to 1, so instruments run sequentially rather than bursting. **Per-stock-debate duration is unmeasured** — [#367](../../issues/367) decides it. Do not cap the shortlist or raise the ceiling on this basis until then; the constraint may not exist.

## Further Notes

**Provenance.** Synthesized from the closed wayfinder map [Wayfinder: Universe Selector (Stage 0) + tick cadence gating](../../issues/397) and its four resolved children: [#398](../../issues/398) (ranking shape), [#399](../../issues/399) (rotation and pinning), [#401](../../issues/401) (candidate pool), [#402](../../issues/402) (attribution — premise false, no work needed). [#400](../../issues/400) resolved the cadence question and was then superseded by ADR-0008; its arithmetic survives only as the input ADR-0008 cites and decides against.

**Reversals this spec lands.** Three documents recorded "not in v1" and are amended in the same change:
- `docs/specs/orchestrator-spec.md` §25 (key architectural decisions) and §245 (Out of Scope) — "fixed universe iteration, not a scanner".
- `docs/specs/analysts-spec.md` §245 — universe selection "is NOT part of this spec and is not yet owned by any charted component". It is owned now.
- `docs/wayfinder/orchestrator-map.md` — historical/reference per CLAUDE.md, so it gains a pointer rather than a rewrite.

**#381's dial hazards re-trigger the moment names rotate**, and the implementation ticket should re-check them against a widened equity list: `time_in_force: 'gtc'` is crypto-only and equities need `day`; `flag_thresholds.size_over: 0` is unit-incommensurable across instruments; correlation and volatility dials go from inert to live. One hazard on the map is already closed — `drift_tolerance` is no longer an absolute price distance; #381 replaced it with a fractional per-asset-class `drift_tolerance_pct`.

**Next steps per CLAUDE.md Standing Pipeline Rule 7:** cross-spec verification across all specs, then `/to-tickets`. The three open questions above should be closed first — questions 1 and 2 gate the implementation ticket; question 3 gates only shortlist sizing and can be carried as a known unknown.
