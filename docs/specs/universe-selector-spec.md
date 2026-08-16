# Universe Selector Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-08-07
**Wayfinder map:** [Wayfinder: Universe Selector (Stage 0) + tick cadence gating](../../issues/397) — closed 2026-08-06, all four children resolved ([#398](../../issues/398), [#399](../../issues/399), [#401](../../issues/401), [#402](../../issues/402); [#400](../../issues/400) resolved and then superseded).

**2026-08-16 — the screener and the active list are re-specified, not annotated.** This spec previously carried a `PARTIALLY SUPERSEDED` banner listing what the horizon change invalidated while the body below still described the superseded design. **That banner is deleted and the affected sections are rewritten**, because a banner over a stale body is a note that the body lies, and a reader following the body gets the old rule. Superseded text is struck in place with its replacement adjacent.

Three sections are rewritten and one clause is withdrawn:

- **The candidate pool** (`Candidate pool`) — S&P 100 becomes a checked-in LSE leveraged-ETP pool, screened on the **US underlying's** bars. Live equities route through the Trading 212 ISA, where only **GBP LSE-listed ETFs and ETCs** are cost-viable: US stocks cost 0.30% round trip on FX and are negative-expectancy, UK individual shares carry 0.5% stamp duty ([#659](https://github.com/dd-jp/samurai-trading-system/issues/659)). SPY/QQQ/AAPL/TSLA are **not tradeable** on the live path.
- **The ranking** (`The selection pipeline`, `Axis computation`) — three percentile-ranked axes become **one objective-aligned axis**.
- **The active list** (`The active list and rotation`) — the crypto clause is **withdrawn**, not suspended.
- **Open Questions 1 and 2 are closed** below; they gated the implementation ticket.

**Withdrawn entirely: crypto.** Crypto left Samurai's scope on 2026-08-16 ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment) — dropped, with a separate system to be designed for it later, not parked pending a return. Every crypto clause in this spec is struck rather than conditioned, including story 26 and the `crypto is always present` test assertion.

**Unchanged and still live:** `docs/research/17-universe-manipulation-guardrails.md` (`:89`) constrains *which* names are eligible — orthogonal to what the universe is selected for, and unaffected by either change. The mover-screener objective survives and is now the live one; doc 10's competing effective-bets objective (2.58 → 4.60 across a 12-instrument diversified basket) is superseded on horizon along with the rest of doc 10, and [#635](https://github.com/dd-jp/samurai-trading-system/issues/635) is re-scoped accordingly.

**Still stale, and not fixed here:** `docs/research/archive/2026-08-05-cost-model-calibration.md` sampled Alpaca quotes for instruments that are no longer tradeable. **LSE ETP spreads must be measured, not assumed** — [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) owns it, and the liquidity gate below is written to survive that number being unknown.

## Corrections to map #397's body — read before the rest

The map's body was written 2026-08-05 and four of its factual claims no longer hold. They are corrected here rather than silently rewritten downstream, because each one changes what gets built.

1. **Cadence is not this effort's Phase 1, and #400's numbers are dead.** The map builds its economics on "crypto 120 s, stocks 300 s → ~1,752 passes/day". [ADR-0008](../adr/0008-llm-spend-cap.md) supersedes that one day later with **a single 15-minute interval** for the paper soak (~296 passes/day, ≈$42 against the $50/14-day cap), already shipped in `paperStartingProfile`. The cost problem cadence gating was sequenced first to solve **is already solved, harder**. Per-asset-class gating survives as a later refinement, not the lever that makes the budget work. Every "−61%" / "−50%" figure on the map is against a baseline that no longer runs.

2. **The screener's data source is Alpaca, not Polygon.** The map's Phase 3 specifies "Polygon daily bars via `HttpPolygonClient.fetchAggregates`". [ADR-0001's 2026-08-06 appendix](../adr/0001-technical-foundation-hybrid.md) — landed *after* the map body — makes **Alpaca free Basic** the equities primary (`feed=sip&adjustment=raw`, 10.5 years of unadjusted dailies, 200 req/min) and demotes **Polygon free** to an increment-only fallback with a **2-year window and 5 req/min**. A ~100-name screener run on Polygon free would take 20 minutes of pure rate-limit waiting and could not see a 3-year lookback; on Alpaca it is one or two requests. See "Market data" under Implementation Decisions.

3. **`config.universe` is resolved at two composition sites now, not three, and the default is `SMOKE_TEST_UNIVERSE`.** The map cites `production.ts:1126`, `:1259`, `:1453` plus a `tradingCalendar` re-resolution bug. The current shape is two independent `config.universe ?? SMOKE_TEST_UNIVERSE` resolutions — one where the market-data source and routing map are built, one where `UniverseScheduler` is constructed — each pairing with its own `config.tradingCalendar ?? new UsEquityRegularHoursCalendar()`. The duplication is milder than the map describes but the hazard is identical and is what makes the provider a single-construction requirement below.

4. **`atr` is not an exported symbol.** The map and [#398](../../issues/398) both cite `indicators.ts:75` as if `atr` were importable. It is a module-private function; the public surface is `computeIndicator(bars, spec)` and `minimumBarsFor(spec)`, with `'atr'` as one indicator kind. This is a real decision for the implementation ticket, not a typo — see "Axis computation".

One further map claim is stale in a way that only affects an open question: the map says "none of the three existing alert transports covers" a stale watchlist. `ALERTS_MODES` is `['telegram', 'log-only']` — **two** modes, not three transports. The gap the map names is real; its count is not.

## Problem Statement

*(This paragraph describes the code as it stands, and the six names it names are now doubly wrong as a destination: four are untradeable on the live venue and two are out of scope. That makes the problem sharper, not stale — the hardcoded default is further from the target than when this was written.)*

Samurai trades a hardcoded six-name universe. `DEFAULT_UNIVERSE` is SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD, and every tick asks the full pipeline the same question about the same six names — regardless of whether anything moved, and regardless of whether a better opportunity existed anywhere else that day.

Two costs fall out of that, and only one of them is money.

**The system cannot look for opportunity.** There is no opportunity-ranking capability anywhere in the repo. Re-asking six fixed names on a schedule is coverage of a list, not a search for an edge — and the list was chosen for liquidity and familiarity when the goal was a working pipeline, not because those six are where the moves are. David's ask (2026-08-05): an out-of-hours job that shortlists stocks worth monitoring next session, so the tick loop spends its budget on breadth instead of repetition.

**Spend is bounded, so breadth is not free.** ADR-0008 caps LLM spend at $50 per 14 days and buys headroom with a 15-minute tick interval. Widening the universe spends that headroom. Any selector has to be judged on whether the names it picks are worth more than the names it displaces — which means the selection has to be recorded well enough to be second-guessed after a bad session.

Three documents currently record the opposite decision — that v1 is deliberately *not* a scanner (`orchestrator-spec.md` §25 and §245, `analysts-spec.md` §245, and the historical `docs/wayfinder/orchestrator-map.md`). This spec reverses that, and amends all three.

## Solution

The **Universe Selector** is an out-of-session batch job that decides which equities the next trading session is worth spending on.

It runs **once per trading day, out of session, at 22:15 London** on **completed US sessions' bars — intraday, not daily** *(corrected 2026-08-16: this line said "daily", which the rewritten axis contradicts; the reach rate asks whether a level was touched *within* a session and a daily high/low cannot answer touch ORDER — see "Axis computation")*, ranks a checked-in candidate pool of **LSE-listed leveraged ETPs** on **one objective-aligned axis**, and emits a **watchlist** of 5–10 names. At the next session boundary the Orchestrator's active list becomes that watchlist plus any instrument Samurai currently holds a position in. Within a session the active list never changes.

Three properties define it, and each one is a decision made on the map rather than a preference:

- **It selects; it does not trade.** The screener's whole output is a list of names. It has no view on direction, size, or entry — Analysts, Debate, Trader and Risk are unchanged and unaware they are being handed a different list than yesterday.
- **It cannot drop a name Samurai holds.** An instrument with an open position stays in the active list regardless of rank. Under [ADR-0007](../adr/0007-fully-automatic-execution.md) there is no human gate to notice a held position that stopped being monitored, so this is an invariant, not a feature.
- **It fails toward the known-good universe.** A stale, empty or unreadable watchlist falls back to the checked-in pool's rows carrying `fallback_default: true` (defined below) and alerts. It never falls back to an empty list, which would silently halt all trading while every health signal stayed green. **`DEFAULT_UNIVERSE` is no longer that fallback** — SPY/QQQ/AAPL/TSLA are not tradeable on the live venue, so falling back to them would substitute an untradeable list for an empty one and fail just as silently, one layer later.

~~The crypto pair is out of the screener's reach entirely: BTC-USD and ETH-USD are always active, always 24/7, and are not ranked against equities.~~ **Withdrawn 2026-08-16.** Crypto is out of Samurai's scope, so there is no crypto pair to hold out of the screener's reach. The clause is deleted rather than inverted: nothing in the active list is exempt from screening, and the active list has exactly two additive components (watchlist + held) rather than three.

## User Stories

1. As David, I want an out-of-hours job to shortlist the equities worth watching tomorrow, so that the tick budget buys breadth instead of re-asking the same six names.
2. As David, I want the shortlist to come from a candidate pool I can read in a diff, so that the set of names Samurai will ever trade changes only when someone approves a commit.
3. As David, I want the pool to be a config value, so that widening it is a dial rather than a rewrite. *(Amended 2026-08-16 — the pool is no longer an index membership list, so "S&P 100 → S&P 500" is no longer the widening it names.)*
4. ~~As David, I want the pool refreshed manually each quarter following index reconstitution, so that membership tracks the index without a vendor integration on the startup path.~~ **Replaced 2026-08-16:** as David, I want the pool refreshed **on issuer delisting rather than on a calendar**, so that the list tracks what is actually tradeable. Leveraged ETPs are not an index and have no reconstitution date; a quarterly refresh would be a ritual with no event behind it, while a delisting is a real event that makes a row untradeable overnight.
5. As David, I want each screener run to log the shortlist together with the inputs that produced it, so that after a bad session I can tell whether the ranking or the trading was at fault.
6. ~~As David, I want the ranking weights and the eligibility threshold to be config, so that paper trading can tune them without a code change.~~ **Replaced 2026-08-16:** as David, I want the ranking to have **no weights to tune**, so that the screener contributes zero trials to the selection accounting ([ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) D4). One axis is a sort, and a sort has no dial. The bracket the axis measures against is frozen by ADR-0018 and is not a screener parameter.
7. ~~As David, I want the weights recorded as UNSOURCED tuning, so that nobody later mistakes an arbitrary starting point for a derived constant.~~ **Withdrawn 2026-08-16** — there are no weights. The concern behind it stands and is now carried by story 7a.
7a. As David, I want the screener's one axis to be **the objective itself rather than a proxy for it**, so that no correlate has to be justified and no weight has to be invented.
8. As David, I want a name I hold a position in to stay monitored even when it ranks last, so that an open position always has an exit path.
9. As David, I want the shortlist to change only at a session boundary, so that a tick can never start against one universe and finish against another.
10. As David, I want a name that enters the shortlist to stay for at least the next session, so that a name at the rank boundary does not oscillate in and out on daily noise.
11. As David, I want to see what entered, held, was pinned, and dropped each session, so that churn is reviewable rather than inferred.
12. As David, I want a stale or empty watchlist to fall back to ~~the default six names~~ **the pool's `fallback_default: true` rows** and raise an alert, so that a broken screener degrades to a tradeable list instead of halting trading silently. *(Amended 2026-08-16 — "the default six names" is SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD, none of which the live venue can hold, so that fallback substituted an untradeable list for an empty one and failed just as silently one layer later. See invariant 3 and the pool schema.)*
13. As David, I want the screener to be idempotent, so that a re-run after a crash produces the same watchlist rather than a second, different one.
14. As David, I want the screener to run against **completed bars only**, so that its decisions cannot depend on a partially-formed bar. *(Amended 2026-08-16 — this said "completed DAILY bars only". The completeness requirement is what story 13's idempotence needs and it stands unchanged; the resolution does not. The axis reads intraday bars, so what must be excluded is any bar of a session still forming, at whatever resolution.)*
15. As the Universe Selector, I want to read the whole candidate pool's bars in a small number of batched requests, so that a run finishes in seconds and stays far inside the data provider's rate limit. *(Amended 2026-08-16 — said "daily bars" and "a 100-name run". The pool is the hand-compiled LSE ETP list, ~12–80 rows, and the bars are intraday. That is more rows per name and far fewer names; the row cap, not the request count, is the pagination concern.)*
16. As the Universe Selector, I want a hard liquidity gate applied before any scoring, so that a name too thin to trade never competes for a slot.
17. ~~As the Universe Selector, I want each opportunity axis converted to a percentile within the surviving pool, so that three quantities on different scales are commensurable.~~ **Dormant 2026-08-16, not deleted** — with one axis there is nothing to make commensurable, so the percentile step is inert. It is retained in the spec because R1 ([#707](https://github.com/dd-jp/samurai-trading-system/issues/707)) may earn a second axis, and the reasoning that produced this story would have to be re-derived otherwise.
18. ~~As the Universe Selector, I want the liquidity gate applied before ranking, so that a name too thin to trade never competes for a slot.~~ **Merged into story 16, 2026-08-16.** Once the percentile-distortion rationale went dormant with story 17, this restated story 16 almost verbatim — same requirement, same justifying sentence. The two were distinct only while "before any scoring" and "before ranking" named different steps of a percentile pipeline; with one axis there is one step. Kept as a struck row rather than deleted so a reader of the map's story numbering does not find a gap.
19. ~~As the Universe Selector, I want a name to be top-quartile on at least one axis to enter the ranking, so that a name mediocre on all three cannot outrank a genuine standout.~~ **Withdrawn 2026-08-16 — the flaw it guards against cannot occur with one axis.** With three axes a blended sum could let a name mediocre everywhere outrank a standout; with one axis the ranking *is* the standout ordering, and a top-quartile gate would only truncate it. **Top-N survives; top-quartile does not** — see "The selection pipeline" for why one of them had to go rather than both being kept.
20. As the Universe Selector, I want to emit only names present in the pool I was given, so that a pick can never reach the routing layer as an unknown instrument.
21. As the Universe Selector, I want to write the watchlist as a complete replacement rather than a merge, so that a partial write cannot leave a half-old, half-new list.
22. As the Orchestrator, I want the active list supplied by a provider rather than a static config value, so that the list can change between sessions without a restart.
23. As the Orchestrator, I want the provider to own pinning, minimum hold, and top-N fill, so that the scheduler never grows a dependency on the execution store.
24. As the Orchestrator, I want the universe resolved once and shared between the routing map and the tick plan, so that market-data routing and instrument iteration cannot disagree.
25. As the Orchestrator, I want the data-source routing map built over the whole candidate pool rather than the active list, so that an active-list change never produces an unknown-instrument throw mid-session.
26. ~~As the Orchestrator, I want the crypto pair always present in the active list, so that 24/7 coverage is unaffected by an equities screener that did not run.~~ **Withdrawn 2026-08-16 — crypto is out of Samurai's scope** ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment). Note what is lost with it: this story was the reason a failed equities screener could not take *all* coverage down. That protection now rests entirely on story 12's fallback, which makes story 12 load-bearing where it was previously a second line of defence. **The fallback's alert is therefore no longer optional** — see Open Question 2, closed below.
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

The map inherits the label "Stage 0" from `docs/research/17-universe-manipulation-guardrails.md`, and it collides. `CONTEXT.md` already uses Stage 0 for the **data layer** — Market Intelligence is "the news/sentiment half of the Stage 0 data layer" and the Market Data Service is "a dedicated Stage 0-level data layer, parallel to Market Intelligence". `server/providers/market-data-service/types.ts` says the same in code.

Resolved: **the Universe Selector is not a pipeline stage at all.** It runs *between* sessions, not inside a tick, and produces configuration for the next session rather than a decision within one. It is the **pre-session selector**; the pipeline it feeds still starts at Stage 0's data layer. `CONTEXT.md` gains the term with this disambiguation.

### Module and entrypoint

A new `server/pipeline/universe-selector/` module with a `yarn screener` entrypoint, scheduled out of hours by launchd. It is a batch program, not a service: it reads bars, ranks, writes a watchlist, exits. It holds no state between runs beyond the watchlist itself.

### The selection pipeline (#398)

**Rewritten 2026-08-16. The three-axis blended ranking below is replaced by a single objective-aligned axis; the superseded design and its reasoning are kept adjacent, because it was reasoned rather than provisional and the argument for replacing it has to beat the argument that produced it.**

```
candidate pool  (LSE ETPs, each carrying its screening_instrument)
  → liquidity gate       (hard filter, not a ranked axis)
  → PERIL reject         (absent — Phase 4, out of scope here)
  → reach rate at the frozen bracket, on the screening instrument
  → top-N (5-10)
```

**One axis: the reach rate at the frozen bracket.** For each pool row, over the last N completed sessions, the fraction in which `underlying return × leverage` reached the frozen take-profit before the frozen stop, **measured from 14:30 London** (the US open, which is when Samurai's entry window opens). The levels are ADR-0018's, injected — the screener does not choose them and cannot tune them.

Three reasons this beats the three-axis blend, in the order they matter:

1. **It is the objective, not a correlate of it.** Volatility, gap/momentum and range position were three proxies for "this name is likely to reach a profit target intraday". The reach rate *is* that quantity, computed the same way `simulate()` computes it in [`docs/research/18-threshold-study.py`](../research/18-threshold-study.py). A proxy needs a justification for why it tracks the objective; the objective needs none.
2. **It removes every free parameter from the screener.** The blend carried three weights and a quartile threshold, all UNSOURCED. ADR-0018 D4 caps the selection budget across the whole programme, and a screener with four tunable dials spends from it every time anyone touches them. **One axis is a sort. A sort contributes zero trials.** This property is load-bearing and is why a second *ranked* axis is refused below even if R1 finds one.
3. **The old axes were partly answered by the venue change.** Gap/momentum ranks on overnight-gap behaviour, and the tradeable instrument is an LSE ETP that has been trading since 08:00 by the time we enter at 14:30 — the gap is priced in before the entry window opens. Range position was explicitly a proxy for an untested taxonomy. Only volatility survives on its own merits, and ATR% is strongly correlated with reach rate at a fixed bracket, so it is largely subsumed rather than lost.

**Top-N survives; the top-quartile eligibility gate does not.** With three axes the gate did real work — it stopped a name mediocre on all three from outranking a standout on one. With one axis it degenerates into "take the top 25%", which is a *different selector* from top-N, not a filter in front of it: on a 40-row pool it emits 10 names, on a 12-row pool 3, and on a 60-row pool 15 — the shortlist size would float with the pool size for no stated reason. **Top-N is kept because the constraint it expresses is real** (the tick budget buys a bounded number of instrument-passes) and the quartile expresses no constraint at all once the ranking is one-dimensional.

**Retained but dormant: the percentile machinery.** Percentile conversion (story 17) and the weighted sum stay in the spec and should stay implementable, because R1 may earn a second axis. **If it does, that axis enters as a hard eligibility gate — dropping the bottom quintile of the pool before the sort — and never as a second ranked axis**, because a second ranked axis reintroduces a relative weight, which is a fitted parameter, which undoes reason 2 above. A quintile cut declared in advance has no free parameter beyond the cut itself.

**The liquidity gate stays a hard filter and is deliberately crude for now.** Real LSE ETP spreads are unmeasured ([#666](https://github.com/dd-jp/samurai-trading-system/issues/666)), so v1 gates on the pool's static `t212_isa` tradeability flag rather than on a spread threshold. This is stated as a known weakness rather than hidden: **a name that is tradeable but expensive currently passes the gate**, and the cost only shows up later as the injected round-trip figure the trader sizes against. When #666 lands, the gate gains a spread ceiling and this paragraph is replaced.

**The shortlist must still be logged with the inputs that produced it.** Fewer inputs does not mean fewer records — the reach rate, the session count, the bracket used, and the screening instrument all belong in the log, because "the ranking or the trading" is still the first question after a bad session.

<details>
<summary>Superseded 2026-08-16 — the three-axis design, kept for its reasoning</summary>

> ```
> candidate pool
>   → liquidity gate            (hard filter, not a ranked axis)
>   → PERIL reject              (absent — Phase 4, out of scope here)
>   → per-axis percentile       (computed over survivors only)
>   → top-quartile-on-one gate  (eligibility)
>   → weighted sum of percentiles
>   → top-N (5-10)
> ```
>
> **Blended score over percentile-ranked axes, not partitioned slots.** Partitioned slots (N breakout + N mean-reversion) pre-commit shortlist capacity to a strategy family, and the Stage 2 re-run reported no edge surviving selection for the one mechanical strategy this repo has tested (PBO 0.85 stocks / 0.55 crypto). Committing the scarcest resource in the system to an untested taxonomy is not justified, and partitioning would need a second undecided rule for unfillable buckets. **This argument is not superseded** — it rules out partitioning under one axis exactly as it did under three.
>
> **Percentile-ranking, not a raw weighted sum.** High ATR% and an extreme range position co-occur, so summing raw values double-counts volatility twice over — once on scale, once on correlation. Percentiles remove the scale half outright and bound the correlation half: two correlated axes can contribute at most their combined weight rather than compounding arbitrarily.
>
> **Equal starting weights, recorded as UNSOURCED tuning** in the same style as every other threshold in `paper-profile.ts`. There is no basis for anything else and inventing one would be fabrication.
>
> **Eligibility: top-quartile on at least one axis.** This closes the "mediocre everywhere outranks a standout" flaw without partitioning, keeps one ordering and one dial, and is falsifiable — if the gate empties the shortlist, the quartile is wrong and the log says so.
>
> **Percentiles are computed after the liquidity gate**, over survivors only. Ranking against already-excluded names distorts every percentile by the size of the excluded set.

</details>

### Axis computation

*(Rewritten 2026-08-16 alongside the pipeline above.)*

**One axis, computed from intraday bars rather than daily ones.** The reach rate asks whether a level was touched *within* a session, which a daily bar cannot answer — a daily high/low tells you the extremes but not their order, and the order is the whole question. The screener therefore reads **intraday bars on the screening instrument**, and the resolution it needs is set by the bracket: at ADR-0018's levels on a 3× ETP the underlying move is ~0.67%, so 5-minute bars are ample and 1-minute is unnecessary precision at 12× the rows.

**The reach rate must be computed by the same code path as the research figure**, for the same reason the old ATR decision preferred `computeIndicator` over a reimplementation: a screener ranking on a *different* reach rate would select for something the record never measured. `simulate()` in `docs/research/18-threshold-study.py` is the reference implementation; the TypeScript screener must reproduce it on a shared fixture, asserted as a test, not assumed from a shared description.

**The old ATR decision still binds if the volatility axis ever returns.** ATR is **not reachable** as a symbol: `atr()` in `server/providers/market-data-service/indicators.ts` is module-private, and the public surface is `computeIndicator(bars, spec)` / `minimumBarsFor(spec)` with `'atr'` as an indicator kind. Should R1 earn an ATR-based eligibility gate, it goes through `computeIndicator` — never a reimplementation inside the selector, which is cheap now and guarantees the two drift.

~~Gap/momentum and range position are new pure functions over `Bar[]`~~ — **not built.** Both axes are withdrawn above; writing the functions for a ranking nothing consumes is precisely this repo's dominant defect class (a tested mechanism nothing calls).

### Market data — Alpaca free Basic, batched, SIP-pinned, out of hours

Per [ADR-0001's 2026-08-06 appendix](../adr/0001-technical-foundation-hybrid.md), equities bars come from **Alpaca free Basic** with `feed=sip&adjustment=raw`. *(2026-08-16: this section said "daily bars" throughout. The axis reads **intraday** bars — 5-minute, per "Axis computation" — so the endpoint takes a `timeframe` and the row arithmetic below changes with it. Everything else in this section is resolution-independent and stands.)* Polygon free is the increment-only fallback (2-year window, 5 req/min) and is **not** an acceptable screener source, contra the map body.

Three consequences the implementation ticket must carry:

- **Batched multi-symbol reads, not the single-symbol port.** `MarketDataService` is strictly single-symbol and its `BarWindow.partial` defaults to `'error'`; the screener instead reads `/v2/stocks/bars?symbols=<comma list>` directly at the HTTP-client level. The row cap is `limit=10000` with a `next_page_token`. *(Re-costed 2026-08-16 for intraday: the old figure was "~100 names × a few months of dailies is a handful of thousand rows". The pool is ~12–80 rows, not 100, but a US session is ~78 five-minute bars, so a few months per name is ~5k rows and the run is **tens of requests, paginated**, not one or two. Still comfortably inside a 200 req/min budget — but the row cap now binds per name rather than across the pool, so pagination is a requirement of the implementation rather than a caveat on it.)*
- **The screener pins `feed=sip`; the live tick path must not.** `DEFAULT_ALPACA_DATA_FEED` is `'iex'` and that default is load-bearing: a Basic subscription 403s on SIP data from the last ~15 minutes, which is exactly what a live tick asks for. The screener asks only for **completed bars of completed sessions, out of hours**, so the embargo cannot bite and it gets the full SIP archive. **The screener therefore constructs its own data client rather than reusing the tick loop's.**
- **Completed bars only.** The run must exclude any partially-formed session bar, so that a re-run at a different minute of the same evening produces the same watchlist (story 13/14).

### Candidate pool (#401)

**A checked-in static list with dated provenance, refreshed manually.** A vendor call for a list that changes a few times a year is disproportionate — a new integration, a new credential, and a new failure mode on the startup path, for public and nearly-static data. *(The refresh trigger changed 2026-08-16: **on delisting, not quarterly.** See story 4.)*

#### The pool is LSE ETPs, and each row carries two instrument identities *(2026-08-16)*

~~S&P 100 for v1.~~ The pool is a **mapping**, compiled by hand from the three LSE leveraged-ETP issuers (Leverage Shares, WisdomTree Boost, GraniteShares) cross-referenced against Trading 212 instrument metadata:

```
{ lse_ticker, screening_instrument, underlying, leverage, direction, subclass, currency, t212_isa, fallback_default }
```

**`fallback_default` is a required boolean, and it is what makes the story-12 fallback a real artifact rather than a name.** Invariant 3 above says a stale, empty or unreadable watchlist falls back to "the checked-in pool's declared default subset" — that subset is exactly the rows with `fallback_default: true`. Three constraints, because with story 26 withdrawn this fallback is the **only** thing standing between a bad screener run and a fully dark session:

- **The loader rejects a pool where no row carries it.** A pool that cannot answer "what do we trade when the screener fails" is a pool that fails silently on the one day it matters, and the failure presents as a healthy no-trade session.
- **Not the full pool.** Falling back to every row would deploy into 40–80 names at once, which the subclass envelope refuses anyway — so the fallback would produce a refusal storm instead of trading. The subset is sized to the watchlist range (5–10 names), liquid and `t212_isa: true`.
- **It is a hand-declared field, not a derived one.** Deriving it from last known ranking reintroduces the dependency on the artifact whose unreadability triggered the fallback in the first place.

**`screening_instrument` is a new required field and it exists to keep the routing invariant below honest.** Screening runs on the **US underlying's** bars, because [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history — so the instrument that is ranked and the instrument that is traded are genuinely different objects. Two ways to express that, and only one is safe:

- **Rejected: leave it implicit** — pass the underlying's symbol wherever bars are fetched and the ETP's wherever orders are routed. That is the exact ambiguity `#routeFor`'s throw exists to prevent, re-created one layer up, and it fails the same way: a wrong-root fetch that 404s or, worse, silently returns bars for a different asset.
- **Adopted: two named identities per row.** `lse_ticker` is what Samurai trades and routes; `screening_instrument` is what the screener fetches bars for. Neither is defaultable from the other, and the loader **must reject a pool row missing either**. The routing map still binds over `lse_ticker` only — `screening_instrument` never reaches the routing layer at all, which is what keeps the invariant intact rather than merely restated.

**Residual risk, stated rather than discovered.** Ranking one instrument and trading another is a real assumption, not a formality, and three things can break it:

1. **Tracking error.** The ETP tracks `leverage × underlying` daily, with drift from financing costs, rebalancing, and the volatility decay inherent to daily-reset leverage. A reach rate measured on the underlying and multiplied by leverage is an approximation whose error grows with intraday path roughness — the exact regime the screener is trying to select for.
2. **The GBP/USD leg.** The ETP is GBP-denominated over a USD underlying, so a currency move is an uncompensated term in the realised return that the screening bars cannot see.
3. **The sessions do not align.** 14:30 London is the *US* open and the screening instrument's first bar, but the ETP has been trading since **08:00** — six and a half hours of price discovery the screening window omits entirely. The reach rate is therefore conditioned on a session start the traded instrument does not share.

None of these is a reason to screen on unavailable LSE bars. They are the reason the screener's output is a **watchlist and not a signal**: the debate still decides, and doc 18's and doc 41's analyses already rest on this same tracking assumption.

The pool is **load-bearing for routing, not just an input to scoring**. `AssetClassRoutingDataSource` builds its instrument→asset-class map at construction and deliberately **throws** on anything outside it (`#routeFor`, per [#358](../../issues/358): routing to a default would hit the wrong API root and 404 silently). So:

- The **routing map binds over the pool**; everything usage-priced binds over the **active list**.
- **The screener is constrained to the pool as its input, not filtered against it afterwards.** If the two ever diverge, the symptom is a throw mid-session on a name the screener itself chose — the worst possible place to find out. The implementation must assert directly that a run cannot emit a name absent from the pool it was given.
- Pool membership changes require a **process restart**. ~~Acceptable, because reconstitution is quarterly~~ *(2026-08-16 — story 4 replaced quarterly reconstitution with a delisting trigger, so that justification is gone: ETPs are not an index and a delisting lands on no calendar.)* **Still acceptable, on a different basis:** the restart is not racing the market. A delisted row is untradeable from its effective date, which the issuer announces in advance, so the pool edit and the restart are scheduled work — not an incident response. What the delisting trigger does change is that the cadence is now **event-driven and unbounded**: there may be no restart for months and then two in a week. It has to be a stated property rather than an accident, and "quarterly" no longer states it.

Pool size is a config value so widening is a later dial. Nothing above the pool cares what the rows are.

**Check the pool count in the first commit, because it may make the ranking machinery pointless.** Index ETPs and commodity ETCs alone is roughly **12–15 underlyings**, at which "shortlist 5–10 from the pool" is close to a rename and the sort is nearly the identity. Adding 3× single-stock ETPs — which ADR-0018 D3 already prices as a subclass — takes it to roughly **40–80**, where ranking earns its keep. **If the pool lands under ~25 rows, ship without the ranking and trade the whole pool**, and record that as the reason rather than building a selector that selects nothing.

**`InstrumentRegistry` is not reused.** The port at `server/tools/backtest/universe.ts` answers a different question — `membershipDuring(window)` is *point-in-time* membership for survivorship-free backtesting, paired with `SurvivorshipViolationError`. The live pool is a present-tense list with no window and no survivorship assertion. Reusing the port would force a fake window argument and inherit a guard that means nothing here.

### The active list and rotation (#399)

**`ActiveUniverseProvider` is a new port owning three things in order:** pin held positions → apply the one-session minimum hold → fill remaining slots from the new top-N.

- **Pinning is the invariant.** An instrument with an open position stays regardless of rank. The provider takes the same sync `getOpenPositions` accessor the risk dependencies already bind, so the scheduler never grows an execution-store dependency.
- **Full re-rank each session, one-session minimum hold.** Full rotation with no hysteresis churns names sitting at the rank boundary on daily noise, and every entry costs a warm-up the system pays and discards. A long hold defeats re-ranking. One session is the shortest hold that breaks the oscillation and short enough that a genuinely dead name is gone in a day. Like the weights, this is a dial with a stated basis, and entry/exit churn per session is what a soak should watch.
- **Changes apply only at a session boundary — this is correctness, not taste.** The tick loop is a self-scheduling `setTimeout` chain with a single in-flight guard, and the routing source throws on unknown instruments. Mutating the active list mid-session means a tick can start against one universe and finish against another, and an in-flight instrument that has just left the list is exactly the throwing case. The list is **immutable within a session** and swaps at the boundary, alongside the existing stocks-market-closed filter in `UniverseScheduler.nextTick`. The pin is evaluated at that same moment — held names are carried into the next list *before* the top-N is applied, not patched in afterwards.
- **No decay.** The minimum hold already provides the smoothing a decay schedule would, in one dial instead of two, and decay would leave a name consuming instrument-passes at partial weight with no rule for when it stops. Under a hard spend cap, "partially in the universe" is not a state worth the arithmetic.
- **Log the transition each session:** entered, held, pinned, dropped.

#### Cadence — stated explicitly, because the spec left it implicit *(2026-08-16)*

The screener runs **once per trading day, out of session, at 22:15 London, on completed US daily and intraday bars.** The US close is 21:00 London, so by 22:15 every bar the screener reads is final — which is what makes the completed-bars-only idempotence requirement above achievable rather than aspirational. The list it produces is consumed by the **next** session, whose entry window opens at 14:30 — about sixteen hours later.

Three consequences the implementation ticket must carry rather than discover:

1. **It is keyed to the next *trading* day, not to "tomorrow".** A Friday-evening run serves Monday. This is safe only because staleness is judged **against the session the watchlist was written for**, not against the file's age — a Friday watchlist is not stale on Monday morning, and an age-based check would declare it so and fall back for no reason. That rule already exists under "Failure modes"; the daily cadence is what makes it load-bearing.
2. **Do not derive the trading-day calendar independently here.** [#696](https://github.com/dd-jp/samurai-trading-system/issues/696) reports the US equity calendar as weekend-only — it trades through Thanksgiving — so a second, local derivation inherits that bug and the two disagree silently. Resolve the target session through the same calendar the Orchestrator uses.
3. **The list is not fully fresh each day, by design.** The one-session minimum hold and the pin on held positions both carry names forward. **"Re-ranked daily with hysteresis" is the accurate description**, and anyone reading a diff of two consecutive watchlists should expect overlap rather than treat it as a stuck screener.

### One universe, resolved once

`config.universe ?? SMOKE_TEST_UNIVERSE` is currently resolved independently at two composition sites — where the market-data source and routing map are built, and where `UniverseScheduler` is constructed — each with its own `config.tradingCalendar` fallback. Introducing a provider on top of that duplication would let the routing map and the tick plan disagree about what the universe is.

**The provider is constructed once and shared**, and the calendar with it. This is the same class of defect the routing source's throw exists to catch, moved one level up.

### Cadence gating — withdrawn *(was "kept, demoted, separate")*

~~Per-asset-class tick intervals remain worth doing (crypto is ~65% of passes and does not need equities' treatment) but are **explicitly not sequenced first**, because ADR-0008's single 15-minute interval already solved the cost problem cadence gating was first for.~~

**Withdrawn 2026-08-16 — the refinement has no remaining content.** Per-asset-class gating existed to run crypto and equities at different intervals, and its whole justification was that crypto was ~65% of passes. With crypto out of scope there is one asset class, so there is nothing to gate *between*. Story 34 (keep cadence gating as a separate later refinement) is satisfied vacuously.

**What replaces it is a different decision, and it lives in the Orchestrator spec, not here:** the tick interval and the debate-bar cadence are now split — exits evaluate every tick, entries once per debate bar. That is a re-specification of what a tick *is*, not a per-asset-class interval, and `orchestrator-spec.md` carries it.

~~When it is built, the shape is settled: **a filter inside `Scheduler.nextTick`, not a second timer.**~~ *(2026-08-16 — struck with the refinement itself. There is no "when it is built": per-asset-class gating has nothing left to gate between.)* **The mechanical warning it carried is kept, because it outlives the feature and applies to ANY later per-instrument cadence work:** `startTickLoop` is a self-scheduling `setTimeout` chain whose single in-flight guard stops overlapping ticks multiplying concurrent LLM calls past `maxConcurrentInstruments`. A second timer breaks that guard and can write duplicate `current_tick` rows. Whatever earns a differentiated cadence next must be **one base clock, filtered** — the same seam the active list uses — not a second timer.

### Feedback Loop — no change (#402)

Attribution keys credits on `analyst_id` alone, with no instrument in the key, so it is already aggregated globally across the universe. A rotating shortlist produces exactly as many observations per analyst as a fixed universe producing the same number of closed trades. No aggregation change is needed — not per-sector, not per-asset-class.

The real constraint is sample *size* (~296 instrument-passes/day at ADR-0008 cadence, few of which close a trade), and rotation neither helps nor hurts it. A screener that shortlists names more likely to move *should* produce more closed trades per day — a hypothesis, not a claim.

### Failure modes, specified rather than discovered

- **Idempotent runs.** Re-running the screener for the same session produces the same watchlist. Completed-bars-only is what makes this true in practice.
- **Stale/empty watchlist falls back to the pool's `fallback_default` rows and alerts.** *(Amended 2026-08-16 — this line said `DEFAULT_UNIVERSE`, which is SPY/QQQ/AAPL/TSLA and untradeable on the live venue. See invariant 3 and the pool schema.)* Never to an empty list. An empty active list is a total trading halt that presents as a healthy system: heartbeat green, no errors, no ticks. Staleness is judged against the session the watchlist was written for, not the file's age.
- **A failed screener run leaves the previous watchlist in place** and alerts, rather than writing a partial one.

## Testing Decisions

Good tests here assert **external behaviour at the highest seam available** — the shortlist a pool and a set of bars produce, and the active list a provider produces — never the internals of the scoring arithmetic. Prior art: the same seam discipline as every other stage spec (one high-level function, fakes for dependencies, assertions on outputs and side effects).

Four seams, in descending preference:

1. **`Screener.select(pool, bars) → Watchlist`** — the whole selection pipeline as one pure function over injected bars. Covers the liquidity gate, the reach-rate ranking and top-N with no HTTP and no clock. *(Amended 2026-08-16.)* Table-driven cases: a pool of one behaves sanely; a name that never reaches the target ranks last rather than erroring; **ordering matters** — a session that touches the stop before the target does not count as a reach, which is the assertion that distinguishes a real reach rate from a daily high/low comparison; ties break deterministically, so a re-run cannot reorder the shortlist. ~~a name mediocre on all three axes is excluded by the eligibility gate; two correlated axes cannot compound past their combined weight; percentiles over survivors differ from percentiles over the full pool~~ — dormant with the three-axis design.
1a. **Reach-rate parity with the research implementation** *(new 2026-08-16)* — a checked-in fixture on which the TypeScript screener and `simulate()` from `docs/research/18-threshold-study.py` produce the same reach rate. Without this the screener can rank on a quantity the record never measured while every other test still passes.
2. **`ActiveUniverseProvider.forSession(...) → readonly UniverseInstrument[]`** — pin, hold, fill. The invariant test is named on [#399](../../issues/399) and is non-negotiable: **a held name ranked last survives a re-rank that would otherwise evict it.** Plus: a name entering stays through the next session; a dropped name with no position is gone at the boundary and not before; pinned names are carried in before top-N is applied. ~~crypto is always present~~ — **this assertion is deleted, not inverted** *(2026-08-16)*. An earlier draft of this change would have amended it to assert a *suspension*; that framing is superseded by ADR-0014's amendment, under which there is no crypto pair to assert anything about. Replaced by: **the active list has exactly two sources** — watchlist and held positions — and a provider that emits an instrument traceable to neither fails.
3. **Pool containment** — a screener run cannot emit a name absent from the pool it was given, asserted directly rather than left to the routing throw to discover at fetch time. **Extended 2026-08-16:** the emitted name is the `lse_ticker`, never the `screening_instrument`. Assert that a `screening_instrument` symbol cannot appear in a watchlist, since that is the one failure the routing map's throw would catch only at fetch time, mid-session.
4. **Fallback behaviour** — an unreadable, empty, or stale watchlist yields the pool's `fallback_default` rows and raises an alert. *(Amended 2026-08-16 from `DEFAULT_UNIVERSE`.)* **Assert additionally that the fallback list is non-empty and that every name in it is `t212_isa`-eligible** — a fallback that returns nothing, or returns names the live venue cannot hold, is the silent halt wearing the fallback's name. A loader test covers the other half: a pool with no `fallback_default` row is rejected at load, not at fallback time. A failed run leaves the prior watchlist intact. Assert the alert fires, not just that the list is right: the silent-halt failure mode is the one worth a test.

The batched Alpaca read is tested at the existing HTTP-client seam (fake fetch, assert the request shape — symbol batching, `feed=sip`, `adjustment=raw`, completed-bars window, pagination on `next_page_token`), matching how the existing Alpaca client tests are written. No live network in unit tests; one manual run against the real endpoint is the wiring check, as with every other external client in this repo.

## Out of Scope

- **The PERIL gate** — manipulation-vulnerability rejection from `docs/research/17-universe-manipulation-guardrails.md`. It needs a fundamentals vendor the repo does not integrate, and the map assigns it **its own wayfinder map**. The pipeline above leaves the slot where it goes.
- **Crypto, entirely.** ~~BTC-USD and ETH-USD are fixed and always active.~~ *(2026-08-16.)* Crypto is out of Samurai's scope per [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s amendment — not screened, not pinned, not present. Selecting among crypto pairs belongs to the separate crypto system, and this section's reasoning transfers to it as an input.
- **Pool widening.** v1 is the hand-compiled LSE ETP pool; widening it is a config dial whose cost implications (and the shortlist-vs-limiter question below) are not evaluated here.
- **Anything that reads MI or news.** The screener ranks on price behaviour alone. A sentiment-based ranking cut was considered and dropped — it saves single-digit pounds per year against a ~£1,000 cap, and ranking on *direction* would pre-empt the debate, which is what decides. Coverage-based gating (does a name have any evidence at all) is a Market Intelligence concern and is specified there, not here.
- **Cadence gating implementation.** ~~Kept as a later refinement with its shape settled, not built here.~~ *(2026-08-16 — **withdrawn, not deferred.** With crypto out of scope there is one asset class and nothing to gate between; see "Cadence gating — withdrawn" above. The one-base-clock-filtered constraint survives as guidance for any future per-instrument cadence work.)*
- **The no-new-bar skip gate** (map Phase 2b). Nothing today skips an instrument whose price has not moved; adding it requires `Scheduler.nextTick` to become `async` and it must **fail open** — a gate that cannot read data plans the instrument *in*, never out, or a data-provider 403 silently halts trading. Separate work, separate ticket.
- **Weight optimization.** ~~Equal weights are a starting point tuned in paper trading, not something this spec derives or a later ticket fits.~~ *(2026-08-16 — **there are no weights.** Story 6's replacement collapsed the blended multi-axis score to a single axis, and a sort has no dial to tune. This bullet described deferring the tuning of a parameter that no longer exists. It becomes live again only if R1 ([#707](https://github.com/dd-jp/samurai-trading-system/issues/707)) earns a second axis, at which point weighting is a decision that map has to make rather than one this spec defers.)*
- **Any change to Analysts, Debate, Trader, Risk, Verdict or Execution.** They receive a different list of names and are otherwise untouched.

## Open Questions

**Questions 1 and 2 are closed below, 2026-08-16.** They gated the implementation ticket, so leaving them open would have stalled the ticket regardless of everything else in this rewrite. Question 3 stays open and is not a gate.

### 1. Where does the watchlist live? — **CLOSED: a row in the shared SQLite store**

The two candidates were a store row (one store for all state, dashboard-queryable, but a migration and invisible to review) and a JSON artifact on disk (matches the checked-in-pool precedent, readable before a session, but a second persistence mechanism and a file-permissions failure mode).

**Decided: the store.** Three reasons, in the order they decided it:

1. **The staleness check is defined against the target session, not the file's age**, and that is the rule the cadence section above depends on. A store row holds `written_for_session` as a first-class column that the fallback queries directly. On disk the same fact lives inside the file, so answering "is this stale" requires opening and parsing the artifact — and the failure mode being guarded is *the artifact being unreadable*. A staleness check that must read the file to know the file is bad is the wrong shape.
2. **Crash-restart must not lose it.** Both survive a restart, but the store is already the thing this system restarts against, and adding a second persistence mechanism means two recovery paths where one is exercised daily and the other never.
3. **The reviewability argument for the artifact is real but is answered more cheaply.** The stated benefit was reading tomorrow's list before the session — which `yarn screener` already provides by printing it, and which the dashboard provides continuously once the row exists. Neither needs a file.

**Follow-on obligations, so this does not land half-done:** it needs a migration (a plain additive table, unlike the `current_tick` stage-enum rebuild the Orchestrator spec calls for); the transition log (entered/held/pinned/dropped) belongs in the same write and in the same transaction, so a partial write cannot leave a list without its provenance; and story 21's complete-replacement-not-merge requirement is satisfied by writing one row per target session rather than by mutating a single mutable row.

### 2. Where does a stale-watchlist alert go? — **CLOSED: the operational-alert path, and `log-only` must not satisfy it**

`ALERTS_MODES` is `['telegram', 'log-only']`. `log-only` cannot wake anyone; Telegram is currently wired for trade notifications and the heartbeat.

**Decided: this alert routes through the same operational-alert path as the breaker and the heartbeat, and `log-only` is explicitly not an acceptable destination for it.** The failure being signalled is a total trading halt that presents as a healthy system — heartbeat green, no errors, no ticks — so an alert that only writes a log line reproduces exactly the condition it was added to catch.

**This decision got sharper, not weaker, with the crypto drop.** Story 26's always-present crypto pair used to mean a failed equities screener still left the system trading something; that backstop is gone, so **the fallback and its alert are now the only thing between a bad screener run and a fully dark session.**

Two implementation obligations:

- **Fail loud on misconfiguration, at startup.** If the configured alert mode cannot deliver an operational alert, the system must say so when it boots, not when the screener first fails. The repo has shipped a missing-transport hole repeatedly and now enforces channel exhaustiveness at the type level — this alert must be a member of that enforced set, not a free-floating call.
- **The alert names the instruments and the reason**, and it is asserted in a test that the alert *fires*, not merely that the fallback list is correct. Per the testing section, the silent-halt mode is the one worth the test.

### 3. Does shortlist size collide with the LLM budget window? — open, not a gate

`LLM_BUDGET_WINDOW_MS` is 300 s and `STOCKS_MAX_DEBATES_PER_WINDOW` is 15. Whether a 10-name shortlist fits inside one window depends on per-stock-debate duration: under ~30 s/debate the whole shortlist lands in one window (10/15, and >15 names would be rejected outright); at ~60 s/debate it spans two-plus windows and the ceiling is nowhere near binding. `maxConcurrentInstruments` defaults to 1, so instruments run sequentially rather than bursting. **Per-stock-debate duration is unmeasured** — [#367](../../issues/367) decides it. Do not cap the shortlist or raise the ceiling on this basis until then; the constraint may not exist.

## Further Notes

**Provenance.** Synthesized from the closed wayfinder map [Wayfinder: Universe Selector (Stage 0) + tick cadence gating](../../issues/397) and its four resolved children: [#398](../../issues/398) (ranking shape), [#399](../../issues/399) (rotation and pinning), [#401](../../issues/401) (candidate pool), [#402](../../issues/402) (attribution — premise false, no work needed). [#400](../../issues/400) resolved the cadence question and was then superseded by ADR-0008; its arithmetic survives only as the input ADR-0008 cites and decides against.

**Reversals this spec lands.** Three documents recorded "not in v1" and are amended in the same change:
- `docs/specs/orchestrator-spec.md` §25 (key architectural decisions) and §245 (Out of Scope) — "fixed universe iteration, not a scanner".
- `docs/specs/analysts-spec.md` §245 — universe selection "is NOT part of this spec and is not yet owned by any charted component". It is owned now.
- `docs/wayfinder/orchestrator-map.md` — historical/reference per CLAUDE.md, so it gains a pointer rather than a rewrite.

**#381's dial hazards re-trigger the moment names rotate**, and the implementation ticket should re-check them against a widened equity list: `time_in_force: 'gtc'` is crypto-only and equities need `day`; `flag_thresholds.size_over: 0` is unit-incommensurable across instruments; correlation and volatility dials go from inert to live. One hazard on the map is already closed — `drift_tolerance` is no longer an absolute price distance; #381 replaced it with a fractional per-asset-class `drift_tolerance_pct`.

**Next steps per CLAUDE.md Standing Pipeline Rule 7:** cross-spec verification across all specs, then `/to-tickets`. ~~The three open questions above should be closed first~~ — **questions 1 and 2 are closed above (2026-08-16), so the implementation ticket is no longer gated.** Question 3 gates only shortlist sizing and is carried as a known unknown.

**What this spec now depends on that it did not before** *(2026-08-16)*:

- **ADR-0018's frozen bracket is an input, not a screener choice.** The reach-rate axis is meaningless without the levels, and if the tranche vector changes under [#708](https://github.com/dd-jp/samurai-trading-system/issues/708) the screener's ranking changes with it. **Inject the levels; never copy them.** A screener holding its own copy of the bracket is how the ranking and the trading quietly diverge.
- **The pool file is a prerequisite for everything here**, including the tests — there is no ranking to write until the rows exist, and the count decides whether the ranking is built at all.
- **[#666](https://github.com/dd-jp/samurai-trading-system/issues/666) (real LSE spreads) upgrades the liquidity gate** from a static tradeability flag to a spread ceiling. Until then the gate admits expensive names, stated above as a known weakness.
- **[#665](https://github.com/dd-jp/samurai-trading-system/issues/665) (the Trading 212 complex-products questionnaire) constrains which rows may be held at all.** It is external input, not code, and it can shrink the pool after it is compiled.
