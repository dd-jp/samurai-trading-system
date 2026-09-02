# Cross-Spec Contracts — Frozen Registry

**Status:** Frozen 2026-07-13 (cross-spec verification pass). **Owner of each type is authoritative; consumers conform.**
This is the single source of truth for types shared across ≥2 specs. If a spec disagrees with this file, this file wins and the spec is wrong. Propagation edits into consuming specs are tracked in the pass log at the bottom.

Reconciles the accumulated additions from all 10 specs + the 3 newly-charted components (Market Data Service, Execution, cost-model/backtest), under [ADR-0001](../adr/0001-technical-foundation-hybrid.md).

---

## 1. `debate_id` — load-bearing for THREE consumers

- **Producer:** Debate Engine. **Deterministic** = hash(instrument + bar + AnalystView set), stable across the no-persistence re-run-from-scratch (#10).
- **Consumers:** (a) Trader/Verdict provenance; (b) cosine setup-store join; (c) **Feedback Loop → debate-log attribution join** at trade close.
- **Non-optional.** Must be present on `OrderIntent.metadata` → `VerdictDecision` → every Execution record (`OpenPosition`/`Fill`/`ClosedTrade`) → setup store.
- **Debate log** (debate-engine story 20) is FL's persisted system-of-record for `AnalystContribution[]`, joined by `debate_id`. Distinct from ephemeral operational debate state (#10 no-persistence): the *log* is a separate append-only record that IS persisted.

## 2. `DebateResult` — additions the mechanical Trader requires

- **`direction: Direction`** (§10) — structural, so a no-LLM Trader maps to order `side` without parsing free-text.
- **Deterministic `debate_id`** (see §1).
- **Owner:** Debate Engine. **Impl ticket #24 (Domain Types & Contracts) must include both.**

## 3. `MarketDataService` — interface for FOUR consumers

- **Owner:** Market Data Service. **Consumers:** Analysts (`getBars`/`getIndicator`), Trader (`getBars`/`getIndicator`), Risk (`getMark` + `getIndicator` for volatility-halt baseline), Verdict (`getMark` for staleness/drift).
- **Canonical interface:**
  ```
  getBars(instrument, window, asOf): Bar[]        // close_time <= asOf (no forming candle)
  getIndicator(instrument, spec, asOf): IndicatorValue   // lookback pinned in hash key
  getMark(instrument, asOf): Mark                 // live: latest_mark table; backtest: last completed bar
  ```
- **`Mark.observed_at`** = data-observation timestamp (not request time). Powers **two** freshness bounds, both built and neither optional:
  - Verdict's `no_go_reason: 'stale_feed'` gate ([#641](https://github.com/dd-jp/samurai-trading-system/issues/641)) — supplements, does not replace, the `decision_timestamp` signal-age gate. Bound: `VerdictConfig.max_mark_age`. **Skipped, together with the `drift` gate, for an intent carrying `metadata.unpriced_exit === true` since [#826](https://github.com/dd-jp/samurai-trading-system/issues/826) (2026-08-19)** — the Trader sets that flag only on the ADR-0014 mandatory flatten when the mark could not be read at all, and both gates compare against a bracket price a market flatten never submits. Verdict does not re-read the mark on that branch. See `verdict-spec.md`'s gate-sequence amendment. This is the same failure the #841 line below closed one stage earlier: the degradation Risk now permits was still being undone at Verdict.
  - The Risk Manager's valuation refusal ([#640](https://github.com/dd-jp/samurai-trading-system/issues/640)) — `computePortfolioView` throws `StaleMarkError` rather than valuing a held position at a price the market may no longer support. Bound: `RiskConfig.max_mark_age`. **Entry path only since [#841](https://github.com/dd-jp/samurai-trading-system/issues/841) (2026-08-18):** an EXIT values the book WITHOUT the unvaluable names (`unvaluable_marks: 'exclude'`) and names them on `PortfolioView.unvalued_instruments`, because refusing there suppressed the flatten and one dark name blocked the whole book's flatten against ADR-0014. See `risk-manager-spec.md`'s amendment for the three guards that keep the degraded view off the entry path.
  - **Two separate config fields on purpose, with the same starting values.** They gate different-weight actions — declining one trade versus refusing to compute the book's exposure at all — and a shared constant would invite loosening the second while meaning to loosen the first. The shared *arithmetic* lives in `server/providers/market-data-service/mark-freshness.ts`, so the two cannot disagree about what "age" means; only about how much of it is tolerable. Both treat an `observed_at` AHEAD of the reading clock as stale ONCE it exceeds `MARK_FORWARD_TOLERANCE_MS` (5s) — **AMENDED 2026-08-27 by [#939](https://github.com/dd-jp/samurai-trading-system/issues/939):** `asOf` is a tick-start instant and a mark is read later in the same pass, so a live-stamped mark lands a few hundred milliseconds "ahead" of it on every busy tick; that is pass latency, not a clock disagreement, so it is tolerated below the bound and only treated as a genuine skew beyond it. See `risk-manager-spec.md`'s amendment.
- **No-lookahead guarantee:** ccxt/IBKR timestamp candles at *open*; service filters on `close_time = open_time + timeframe <= asOf`. Backtest `getMark` derives from last completed bar, never the live `latest_mark` table.
- **Shared store gains `bars` (append-only, survivorship-free) + `latest_mark` (upserted) tables.**

## 4. `ClosedTrade` / `Fill` / `OpenPosition` — Execution is SOLE writer

- **Owner:** Execution. **`ClosedTrade` is DEFINED in execution-spec** (feedback-loop-spec referenced it without defining — FL adopts, does not redefine).
- **`ClosedTrade` fields (FL + Risk adopt exactly):** `entry`, `stop`, `filled_size`, `realized_pnl_net` (net of fees), `debate_id`, `idempotency_key`, `asset_class`, `side`, `opened_at`, `closed_at`, `close_reason`.
- **`filled_size` rule — LOAD-BEARING:** downstream reads `filled_size` / `avg_entry_price`, **never requested size**, for partially-filled positions. Persist BOTH `requested_size` and `filled_size`.
  - Risk `PortfolioView` exposure = `OpenPosition.filled_size × current mark`.
  - FL `R = realized_pnl_net ÷ (|entry − stop| × filled_size)`.
- **`Fill.cost_breakdown`** `{spread_cost, commission, slippage, market_impact}` persisted on every fill — this is the source for FL's **live-vs-modeled cost divergence check**. Live fills therefore populate the same breakdown shape the cost model produces (via broker fee/slippage attribution).
- **Scale-in = per-lot:** each `entry`/`scale_in` is its own lot with own bracket, `debate_id`, and `ClosedTrade`/R (preserves FL's single-entry-bracket R assumption; blended-average accounting deferred to v2).

## 5. `MetricsSuite` (flat) vs `MetricsReport` (nested) — recompose, don't duplicate

- **Owner of computation:** cost-model/backtest **validation library** (flat `MetricsSuite` + DSR/PBO/walk-forward primitives). Single implementation so live metrics == backtest metrics exactly.
- **FL recomposes**, does not reimplement:
  - `MetricsReport.daily` **= `MetricsSuite`** (Sharpe, Sortino, Calmar, max_drawdown, profit_factor, expectancy, skew, kurtosis, turnover, exposure).
  - `MetricsReport.revalidation` = the library's DSR/PBO/walk-forward output.
  - `MetricsReport.breaches` stays FL-only.
- **FL owns cadence + breach-response + the kill decision; the library owns the math.** No duplication. *(Amended 2026-08-09 by [ADR-0013](../adr/0013-no-human-gate-anywhere.md): the kill is no longer "human-owned" — under full automation nobody owns it, so a breach must produce a mechanical response rather than an alert awaiting a decision.)*
- **`config_trials` log** (shared SQLite): N = **distinct configs evaluated for selection**, keyed by config hash. Re-runs and in-bounds FL auto-tuning do NOT increment N. FL revalidation reads frozen N, never appends. Getting this wrong makes DSR/PBO/MinBTL kill healthy strategies by construction.

## 6. `CostModel.fill` ↔ `SimulatedBrokerAdapter` ↔ `MarketState`

- **Owner of `CostModel.fill(request, marketState) → Fill`:** cost-model component. **Consumer:** Execution's `SimulatedBrokerAdapter` (backtest + paper) — the real Alpaca/ccxt/IBKR adapters do NOT call it.
- Fill price always moves adversely: `fill_price = mid + sign(side) × (half_spread + slippage + market_impact)`, commission booked separately. Non-zero cost floor even on the most optimistic config (research principle 1, made structural).
- **`MarketState` = { mid, spread, adv, volatility, asset_class, timestamp }.** See §OPEN-GAP-A for the sourcing hole.

## 7. Broker abstraction — DUAL-TARGET (ADR-0001)

- **`BrokerAdapter` implementations:** **Alpaca** (MVP paper/live-equities), **ccxt** (Kraken/Coinbase crypto), **IBKR** (stocks), **Simulated** (backtest/paper, calls `CostModel.fill`).
- Atomic bracket + one-cancels-other exit semantics guaranteed at the boundary (native OCA on IBKR/Alpaca; Execution-managed emulation on ccxt).
- **Idempotency key = `hash(instrument + bar/timestamp)`** (trader-spec/CONTEXT/verdict authoritative — NOT `debate_id`; `trader-map.md:30` `debate_id +` prefix is stale, spec is canonical).

## 8. `InvalidationResult` — crosses the `invalidation` → `risk` boundary

Added 2026-08-05 from [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291). **Owner:** Devil's Advocate / invalidation stage (devils-advocate-spec.md). **Consumer:** Risk Manager.

- **The pipeline will be SEVEN stages once `invalidation` ships; it is six today** (`invalidation` is specced, not built — CLAUDE.md, `orchestrator-spec.md`): `analysts → debate → trader → [invalidation] → risk → verdict → execution`. `TickStage` and `current_tick.stage` will gain `'invalidation'` when it ships; the latter's SQL `CHECK` over six names will require a table-rebuild migration at that point. *(Corrected 2026-09-02 — see `docs/reviews/devils-advocate-spec-cross-verify-2026-09-02.md` GAP-A: this entry previously asserted seven stages as already current, contradicting CLAUDE.md and the majority of specs.)*
- **Canonical shape:**
  ```
  InvalidationCondition { id, observable, comparator: '<'|'<='|'>'|'>=', threshold: number, rationale: string }
  InvalidationObservable = { kind:'indicator', spec: IndicatorSpec }
                         | { kind:'mark' }
                         | { kind:'bars', window: BarWindow, measure:'volume_ratio' }
                         | { kind:'mi_context', window_ms: number, measure:'news_count'|'social_count' }
  EvaluatedCondition   { condition, state: 'breached'|'not_breached'|'unevaluable' }
  InvalidationResult   { thesis_restated, thesis_source: {debate_id}|null, conditions: EvaluatedCondition[] }
  ```
- **Reuses `IndicatorSpec` verbatim** (§3) rather than inventing a parallel way to name an indicator. **No** model-assigned severity, weight, or confidence — conditions are predicates. **No** `thesis_holds`; consumers derive it.
- **`thesis_source` is nullable by contract** — `{ debate_id }` when read from `DebateResult.synthesis`, null when inferred from telemetry. It therefore **cannot** be a primary key, which is why `invalidation_log` is keyed on content, not on `debate_id`.
- **Transport into Risk:** `RiskInput.invalidation?: InvalidationResult`, pre-built outside `evaluate()` — the same seam ADR-0003 uses for `RiskInput.critic?`. Risk stays deterministic given its inputs. A non-empty breached list is a hard reject with `binding_constraint: 'thesis_invalidated:<condition_kind>'`.
- **Narrowing rule — load-bearing:** the stage's outcome union has three statuses (`evaluated` / `no_conditions` / `unavailable`) and only `evaluated` carries an `InvalidationResult`. The other two both arrive at Risk as `undefined`. **Risk cannot and must not distinguish them**; that distinction survives in `invalidation_log` and the warn/alert path only. It is a prompt-safety property, not a convenience — see devils-advocate-spec.md. **Its cost is a monitoring blind spot, and the blind spot is stated here so the implementation ticket owns it** *(added 2026-08-17)*: because `no_conditions` and `unavailable` are indistinguishable at Risk, a stage that has silently stopped evaluating invalidation altogether presents to every downstream consumer exactly as a stage that evaluated and found nothing to reject. Nothing goes red. The warn/alert path is therefore not an operational nicety but the **sole** detector of that failure, which makes two things mandatory: the `invalidation_log` must record the status for every tick including the non-`evaluated` ones (so the ratio is queryable after the fact), and the alert on a sustained run of `unavailable` must be a first-class alert on the same footing as the fallback alerts elsewhere, not a log line. A silenced or unrouted alert here is the difference between a degraded system and an undetectably degraded one.
- **`invalidation_log` retrieval is by `(instrument, bar_timestamp)`, NOT by any generated id**, because a replay mints fresh `trace_id`/`debate_id` values and cannot bridge to live rows. `bar_timestamp` must be **floored to the instrument's bar boundary** at write time, the same way `debate_log` does it. *(Corrected 2026-09-02: this previously claimed `debate_log`'s write path has the same unfloored-`clock.now()` defect today. That was fixed by #687 — `floorToBar`/`DEBATE_BAR_TIMEFRAME_MS` are applied at write in `debate-log-store.ts`. `invalidation_log`'s implementation should follow `debate_log`'s current, fixed pattern, not inherit a bug that no longer exists.)*

---

## 9. Threshold clamps — the research bright lines are enforced in code (#638)

Recorded here **once** so it stops being re-litigated per spec. Both
`risk-manager-spec.md` and `cost-model-backtest-spec.md` previously exposed
research-mandated bright lines as ordinary tunable config; this section is the
settled answer for every spec.

**The rule.** A threshold that a research document states as a bright line stays
**config**, but the config is bounded by a table in code (`server/shared/threshold-bounds.ts`),
and a value outside its bound is **REFUSED, never coerced**. Refusing to boot is
the correct behaviour: a silently clamped value reads as accepted, and the
operator then believes a limit is in force that is not.

**Why in code and not in a spec sentence.** [ADR-0007](../adr/0007-fully-automatic-execution.md)
removed the human from the trade path — "the breakers are now the only stop".
[ADR-0013](../adr/0013-no-human-gate-anywhere.md) went further: nothing re-arms
by hand and nothing gates a loosening, so **the numeric thresholds are the only
stop**, and a config edit was the entire distance between the running system and
an arbitrary risk limit. ADR-0013 calls the clamp "a precondition of this ADR
being safe, not a tidiness item". The threat model is not a fat-fingered file —
it is the **Feedback Loop walking a dial by itself**, with nobody in the path at
all since [#736](https://github.com/dd-jp/samurai-trading-system/issues/736)
removed the loosen gate. That is no longer a future condition: `runDailyCycle`
applies every bounded loosening in every mode and only tells the operator
afterwards, so this table is the sole remaining stop.

**Guarded values, and where each bound comes from:**

| Threshold | Bound | Source |
|---|---|---|
| `max_pbo` | ≤ 0.05 | `CONTEXT.md` — "Kill if PBO > 0.05"; `feedback-loop-spec.md` story 13; `PBO_REJECT_THRESHOLD` |
| `min_oos_sharpe` | ≥ 0.5 | `feedback-loop-spec.md` story 13 — lowering it softens the kill |
| `min_deflated_sharpe` | ≥ 0.95 | `CONTEXT.md` falsification test, DSR-significant at the conventional 5% level |
| `max_drawdown_pct` | ≤ 0.45 | **engineering choice**, stated as one: David's 2026-08-31 approval of [#925](https://github.com/dd-jp/samurai-trading-system/issues/925), re-siting the ceiling above [#798](https://github.com/dd-jp/samurai-trading-system/issues/798)'s accepted 41.8% single-stock envelope (shipped trip 0.44, one tuning step under the ceiling) |
| `recovery_drawdown_pct` | ≤ 0.418 | [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) D5's measured envelope, re-measured by [#729](https://github.com/dd-jp/samurai-trading-system/issues/729) and accepted by [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) — the book resumes only inside the drawdown it was sized for |
| `daily_loss_pct` (+ both per-class tiers) | ≤ 0.10 | **engineering choice**, derived from `max_drawdown_pct` so the daily tier can fire several sessions before the drawdown trip |

Bounds carry a `source` string in the table, and an uncited bound is an invented
safety limit — the two engineering choices above say so in as many words rather
than borrowing authority from a document that does not state them.

**Where the clamp binds.** Four seams, because a boot-time-only check would
constrain nothing the Feedback Loop does:

1. `CircuitBreakers`' constructor — boot. Complements, and does not replace, the
   pre-existing hysteresis-width check, which is a *relative* ordering test:
   `max_drawdown_pct: 0.95` with `recovery_drawdown_pct: 0.90` passes it and
   leaves a drawdown breaker that can never fire.
2. `resolveRiskConfig` — **the live path, and the one that matters.**
   `RiskManagerImpl.evaluate()` re-resolves its config from the `risk_thresholds`
   table on *every* call, so a row written between two ticks binds on the second
   one without passing through startup again. It checks the **whole stored
   record**, not only the six keys it applies, so the guard travels with the
   allow-list rather than with today's contents.
3. `TuningStore.setRiskThreshold` / `seedRiskThreshold` (both implementations) —
   the Feedback Loop's write door.
4. `buildProductionComponents` and `computeMetrics` — the kill lines, at boot and
   per cycle.

`yarn smoke` drives a negative probe through each seam for every guarded name and
fails the gate if any accepts an out-of-bound value, or if the probe stops
covering the whole table.

**Deliberately NOT guarded, and why:**

- **A FLOOR on `max_drawdown_pct`.** A trip set too *low* halts new entries early
  and never blocks an exit, so it cannot increase loss — that is an availability
  failure, owned by [#634](https://github.com/dd-jp/samurai-trading-system/issues/634)
  and ADR-0013, not by this clamp. Siting the trip above ADR-0018's measured
  envelope remains a spec-level obligation (`risk-manager-spec.md`).
- **The six tunable notional caps** (`max_position_size`, `per_asset_cap`, the two
  per-class caps, `portfolio_gross_cap`, `concentration_cap`). No document states
  a line for any of them, and bounding them would both invent a safety limit and
  freeze the Feedback Loop's only working dials.
- **`max_live_backtest_divergence`.** Same reason: no research document states a
  value for it.
- **`per_subclass_deployment_cap`.** Not exposed as a dial at all — see
  `risk-thresholds.ts` and `per-subclass-deployment-cap.test.ts`. Absence from the
  allow-list is a stronger guarantee than a bound would be.

## 10. Shared primitive types — `Direction` / `DateRange`

Added 2026-08-17 (#644) — both were used across ≥2 specs already, un-owned by
this registry, and hand-rolled or re-described at each use site instead of
named once.

- **`Direction = 'bullish' | 'bearish' | 'neutral'`** — **Owner:** Debate Engine.
  Canonical home is code, not this registry: `contracts/primitives.ts` (the
  wire model both `client/` and `server/` import, per CLAUDE.md's repo-layout
  note). **Consumers:** `analysts-spec.md` (`AnalystView.direction`),
  `debate-engine-spec.md` (`DebateResult.direction`, `AnalystContribution.
  stance_during_debate`/`final_position`, `DebateLog.direction`, §2 above), and
  `shared-sqlite-store-spec.md`'s `debate_log.direction` CHECK constraint,
  which hand-rolls the same three literals in SQL and must track this type if
  it ever changes. Not the same concept as the Feedback Loop's tighten/loosen
  `direction` column on `dial_adjustments` (`shared-sqlite-store-spec.md`) —
  same field name, unrelated domain, do not conflate.
- **`DateRange = { start: Date; end: Date }`** — **Owner:** cost-model/backtest,
  matching where the code lives: `server/tools/backtest/universe.ts`.
  **Consumers:** `cost-model-backtest-spec.md` (survivorship-free universe
  membership window), `stage2-validation-execution-spec.md` (historical replay
  window), `transport-layer-spec.md` (`PolygonClient.fetchAggregates(symbol,
  window: DateRange)`).

---

## OPEN GAPS (found in this pass — resolve before / during `/to-tickets`)

- **RESOLVED: OPEN-GAP-A — `MarketState.spread` and `.adv` have no clean source.** Resolved hybrid: MDS exposes a best-effort spread estimate (bid/ask where available, e.g. crypto ccxt; null otherwise) + an ADV helper (bars-volume aggregation); cost model fallback-models spread from volatility + per-asset-class model when MDS returns null, guaranteeing a non-zero spread term always. See market-data-service-spec.md Out of Scope + cost-model-backtest-spec.md §Spread sourcing.
- **RESOLVED (reversed 2026-07-21): OPEN-GAP-B — DoD #7 (dashboard/CLI) has no spec.** Originally resolved 2026-07-14 as a minimal read-only CLI. Reversed 2026-07-21 after `src/dashboard/` (now `server/apps/service-api/`) was built ahead of process (no map/spec) and grilled to a decision: the **Dashboard supersedes the CLI**, not complements it — one operator surface, not two. Charted in [dashboard-map.md](../wayfinder/dashboard-map.md) / specced in [dashboard-spec.md](../specs/dashboard-spec.md) (formerly `cli-map.md`/`cli-spec.md`, renamed and rewritten in place) — the **12th and final component**. Pure presentation layer, zero new writes: reads `audit_log` (Orchestrator), `OpenPosition` (Execution), `DebateLog` (Debate Engine), weights/attribution + `MetricsSuite` (Feedback Loop), verdict audit trail (Verdict), `getMark` (Market Data Service, for unrealized PnL). **Correction (#644):** this previously also listed `ClosedTrade` as a dashboard read source. `DashboardQueryStore` reads `closed_trades` too, but only in aggregate — `getDailyMetrics`/`getAttribution` fold it into `MetricsSuite`/attribution numbers — never as a per-trade listing; `dashboard-spec.md` has no `getClosedTrades` and the client has no trade-row UI. If a PnL-review table is wanted later, that is new scope, not a gap in what's already specced. Same one flagged scope reduction as before: "pending debates" shows completed `DebateLog` entries + a coarse Orchestrator tick-status line, not a live in-flight debate view (the Debate Engine's round state is deliberately not persisted, decision #10). `src/cli/` removed as part of this reversal. <!-- cite-exempt: historical — both cited paths on this line are statements about removed trees, and the sentences are only true because they no longer exist -->
- **RESOLVED: OPEN-GAP-C — DoD #8 (structured logs + trace IDs) + JSONB audit spine have no owner.** Resolved: the **Orchestrator** ([orchestrator-map.md](../wayfinder/orchestrator-map.md) / [orchestrator-spec.md](../specs/orchestrator-spec.md)) owns trace-ID generation/threading, the shared structured-`Logger` interface every stage logs through, and an `audit_log` table in the shared SQLite store (mining the JSONB *pattern*, not a separate JSONB/Supabase system).
- **RESOLVED: OPEN-GAP-D — Orchestrator uncharted.** Charted 2026-07-14. Owns: tick-loop + injected `Clock` (the seam cost-model-backtest-spec's "same code path" guarantee depends on), Signal production/scanning (~~fixed universe iteration, v1~~ — closes GAP-I's producer question; **amended 2026-08-07:** the Orchestrator still emits `Signal` per instrument per tick, but *which* instruments is no longer a static config list — it comes from an `ActiveUniverseProvider` fed by the Universe Selector, see [universe-selector-spec.md](universe-selector-spec.md) and map [#397](https://github.com/dd-jp/samurai-trading-system/issues/397)), trace-IDs/structured-logs/audit-spine (closes OPEN-GAP-C), dead-man's-switch heartbeat over Verdict's existing trade channel. Built on ADR-0001's now-resolved open questions (TypeScript core; debate substrate reimplemented, not LangGraph-dependent).

## Full sweep findings (2026-07-13/14 — read-only verification pass, ranked most-severe)

**HIGH — MVP-blocking or load-bearing, not yet resolved:**
- **GAP-E — `ExecutionInput` has no `MarketDataService` handle.** `CostModel.fill(request, marketState)` is called only by Execution's Simulated adapter, but `ExecutionInput` injects `clock/broker/store/costModel/config/mode` — no market-data source to assemble `MarketState.mid/spread/adv/volatility` from. Unlike Trader/Risk/Verdict, which all inject `MarketDataService`. **Fix:** add `marketData: MarketDataService` to `ExecutionInput`; the Simulated adapter builds `MarketState` from it before calling `CostModel.fill`.
- **GAP-F — Two incompatible `Fill` shapes.** Execution's `Fill` (`idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp`) has no `cost_breakdown`, but registry §4 mandates `Fill.cost_breakdown` for FL's live-vs-modeled divergence check, and the cost-model's `Fill` (`fill_price, filled_size, cost_breakdown, seed?`) uses different field names entirely. **Fix:** Execution's `Fill` is the persisted record (authoritative, sole-writer per §4) and must gain a `cost_breakdown?` field (optional/null on live fills where unavailable, populated on simulated fills from `CostModel.fill`'s output) — field names reconciled to Execution's (`price`/`qty`), not the cost model's internal naming.
- **GAP-G — MVP path (Alpaca) has no Market Data Service source.** MDS's `DataSource` port only names ccxt/Kraken + IBKR; no Alpaca `DataSource`, despite Alpaca being the ADR-0001 MVP execution path for SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD. **Fix:** add an Alpaca `DataSource` implementation to MDS (Alpaca serves both historical bars and streaming quotes for its execution universe).
- **FIXED: GAP-H — `DebateLog` is referenced (registry §1, FL's system-of-record) but never defined or written.** Fixed in `docs/specs/debate-engine-spec.md`: added the `DebateLog` type definition (alongside `DebateResult`/`AnalystContribution`), a "Debate log write" step in the round-termination lifecycle (written once, append-only, after resolution), and reworded the "State Persistence" module (+ its Out of Scope entry) so it no longer reads as blanket "No Persistence" — it now distinguishes ephemeral operational/round state (still not persisted, unchanged decision #10) from the completed `DebateLog` (IS persisted).
- **FIXED: GAP-I — Signal/scan/idea-generation producer unspecced (DoD #1).** Fixed in `docs/specs/analysts-spec.md`: added a "Signal Production (out of scope, flagged dependency)" note under Out of Scope (plus a matching line in the Dependencies list) naming the Orchestrator (OPEN-GAP-D) as the likely owner of universe scanning/scheduling that emits `Signal` per instrument per tick — not designed here, just flagged so it isn't lost. **Ownership settled 2026-08-07:** scanning is *not* the Orchestrator's after all — it belongs to the **Universe Selector** ([universe-selector-spec.md](universe-selector-spec.md), map [#397](https://github.com/dd-jp/samurai-trading-system/issues/397)), an out-of-session job that writes a watchlist; the Orchestrator keeps scheduling and per-tick `Signal` emission over whatever active list it is given.

**MEDIUM:**
- Funding/borrow accrual unowned in the LIVE path (cost-model only applies it in backtest mark-to-market; Risk's live `PortfolioView.equity` has no accrual term).
- **RESOLVED 2026-08-17 (#638).** PBO 0.05 kill-line exposed as tunable config in cost-model spec, when research/CONTEXT treat it as a fixed bright line — risked the one hard kill criterion being softened. Now config bounded by an in-code table that refuses a crossing at load and on every write; see §9.
- DoD reverse-gap: Market Data Service, Market Intelligence, and the entire cost-model/PBO/DSR apparatus (the research core — "expectancy > 0 before live money") have no DoD line item.

**LOW:** FL revalidation omits MinBTL (computes it in cost-model but doesn't surface it in `MetricsReport.revalidation`); no spec enforces the "paper across ≥1 volatility regime" graduation gate; trading-calendar/session source unspecced.

**Confirmed clean:** idempotency key, `ClosedTrade` fields, `decision_timestamp` threading, shared-store table non-collision, `debate_id`/`direction` DebateResult additions, all spot-checked research-constraint compliance (expectancy floor, √-law costs, PBO/DSR/walk-forward/MinBTL, full metrics suite, fractional-Kelly crypto-conservative, circuit breakers incl. volatility halt, point-in-time/no-lookahead/survivorship-free).

**Action:** GAP-E/F/G/H/I are real spec defects (not just backlog items) — fix in specs before `/to-tickets`, not after. See Propagation log below.

## ADR-0001 spec reconciliations (hybrid retarget — apply during propagation)

- **Execution / broker abstraction** — add the **Alpaca adapter** to the dual-target `BrokerAdapter` set (MVP). Bracket/OCO must hold on Alpaca.
- **cost-model/backtest** — the backtest/eval **executor is pybroker** (mine `eval` metrics + `strategy` walkforward split); the **transaction-cost model stays ours** and is injected into the eval path (pybroker's fill model isn't pessimistic enough for √-law impact).
- **DoD** — adopt the vision's 8-point Paper-MVP Definition of Done (compatible; see OPEN-GAP-B/C for the two unspecced points).

---

## Propagation log (this pass)

- [x] FL spec: replace inline `MetricsReport.daily` shape with `= MetricsSuite` (owned by validation library); note recompose (§5).
- [x] FL spec: `ClosedTrade` — reference execution-spec as definer; confirm adopted field list (§4).
- [x] Risk spec: confirm `PortfolioView` reads `filled_size × mark`, consumes `getIndicator` for volatility-halt (§3, §4).
- [x] Execution spec: add Alpaca `BrokerAdapter` to the dual-target set (ADR-0001).
- [x] cost-model spec: name pybroker as the eval executor; resolve OPEN-GAP-A spread/ADV sourcing.
- [ ] DoD traceability lens both directions (OPEN-GAP-B/C).

## Propagation log (spec-defect pass, 2026-07-14)

- [x] **GAP-E fixed** — execution-spec.md: `ExecutionInput` gains `marketData: MarketDataService`; Simulated-adapter description now states it builds `MarketState` from `marketData.getMark()`/`getIndicator()` before calling `CostModel.fill`; the "Out of Scope" MDS disclaimer and the Dependencies line no longer claim Execution has no MDS dependency.
- [x] **GAP-F fixed** — execution-spec.md: `Fill` gains an optional `cost_breakdown?: {spread_cost, commission, slippage, market_impact}`, populated on Simulated-adapter fills, undefined on live fills. cost-model-backtest-spec.md: `CostModel.fill`'s return type renamed `Fill` → `CostModelResult` (distinct from Execution's persisted `Fill`) with an explicit mapping note (`fill_price`→`price`, `filled_size`→`qty`, `cost_breakdown` passthrough); the one caller (Execution's Simulated adapter) updated to match.
- [x] **GAP-G fixed** — market-data-service-spec.md: added an Alpaca `DataSource` implementation (historical bars + streaming quotes/marks) covering the ADR-0001 MVP universe (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD), alongside ccxt and IBKR; updated user story 12, Dependencies, Resolved Decisions, and the pipeline integration diagram.
- [x] Debate Engine spec: add `DebateLog` type + write path; reword "State Persistence" (GAP-H).
- [x] Analysts spec: add Signal Production out-of-scope/dependency note pointing at Orchestrator (GAP-I).

## Full re-verification (2026-07-14, post-Orchestrator/CLI) — via advisor + fresh Explore sweep

The prior sweep above ran BEFORE the Orchestrator and CLI specs existed and before GAP-E/F/G/H/I fixes were re-checked. A second, full 12-spec sweep found:

- [x] **GAP-J fixed — `trace_id` unpropagated.** orchestrator-spec.md asserted trace_id threads through every stage's input envelope and log line, but none of the 10 stage specs (analysts, market-intelligence, debate-engine, trader, risk-manager, verdict, feedback-loop, market-data-service, execution, cost-model-backtest) defined the field. Fixed 2026-07-14 — per-spec breakdown:
  - **Added `trace_id: string` to the primary `*Input` struct** (with the standard comment `// cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data`):
    - analysts-spec.md: `AnalystInput`
    - trader-spec.md: `TraderInput`
    - risk-manager-spec.md: `RiskInput`
    - verdict-spec.md: `VerdictInput`
    - execution-spec.md: `ExecutionInput`
  - **Added `trace_id: string` to `AnalystView`** (debate-engine-spec.md and analysts-spec.md both define this identical shared type; debate-engine-spec.md has no separate wrapping input envelope — `AnalystView[]` *is* its primary input, per its own "Upstream contract" comment — so both copies were updated together to avoid the exact cross-spec type drift this registry exists to prevent).
    - debate-engine-spec.md: `AnalystView`
    - analysts-spec.md: `AnalystView` (kept identical to the debate-engine-spec.md copy)
  - **Added `trace_id` as a call parameter, not a struct field** (these two are pull/push query calls with positional args, not object-shaped `*Input` types):
    - market-intelligence-spec.md: `getContext(assetClass, timeWindow, trace_id)`. `subscribe(...)` was NOT given a `trace_id` param — push updates fire asynchronously outside any single tick's call, so there is no one tick to attribute them to.
    - feedback-loop-spec.md: `onTradeClose(trade, trace_id, input)` — NOT `runDailyCycle`/`FeedbackInput`. Chose the per-trade-close call because it correlates to one specific tick (the tick that processed the closing fill); `runDailyCycle`/`computeMetrics` run on a daily batch spanning many ticks/trace_ids, so no single trace_id applies there.
  - **Deliberately skipped (judgement call, both are shared query/library dependencies injected into stages, not themselves sequenced in the Orchestrator's `analysts → debate → trader → risk → verdict → execution` tick order):**
    - market-data-service-spec.md: `MarketDataService.getBars/getIndicator/getMark` already take a point-in-time `asOf` param; a `trace_id` would only serve MDS's own internal logging, and MDS is consumed identically by four different stages/traces per tick rather than owning one — no natural single input envelope to attach it to.
    - cost-model-backtest-spec.md: `CostModel.fill`/`capacityCeiling` are called only by Execution's Simulated adapter as a pure function of `FillRequest`/`MarketState`; Execution already carries `trace_id` on `ExecutionInput` and can log the correlation at the call site, so no propagation into the cost model itself is needed.
- [x] **GAP-K fixed — CLI `getTickStatus` vs. Orchestrator statelessness contradiction.** cli-spec.md's `TickStatus` hedged between "the Orchestrator's in-memory state" (unreadable — CLI is a separate process) "or a `current_tick` row" that orchestrator-spec.md never actually specced. Fixed: orchestrator-spec.md's Tick Runner module now defines a `current_tick` upserted-per-instrument row (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`), explicitly carved out as an exception to the "no unrecoverable state" decision (disposable/best-effort, not a system-of-record). cli-spec.md's `TickStatus` now sources from it directly, no hedge.
- **Re-checked, FALSE ALARMS (no action needed):** audit-trail ownership (Verdict logs its own decision per its own spec; the Orchestrator's `audit_log` table is the one persisted store, no double-ownership — cli-spec.md's "audit_log filtered to stage=verdict" is correct, not a papered-over conflict); GAP-F rename (fully applied, single-source field mapping); GAP-E/G (both confirmed present in current spec text, not just propagation-log checkmarks).

**All 12 specs now cross-verified against each other, including Orchestrator and CLI.**

---

## Live findings register (opened 2026-08-09)

The three dated `cross-verify-*.md` passes previously held findings with no living home; they sat in `docs/specs/` and were never drained. All 17 were re-verified on 2026-08-09 — 4 had been resolved, 13 were still live — and consolidated into [`../reviews/cross-verify-2026-08-09.md`](../reviews/cross-verify-2026-08-09.md). The passes themselves moved to `docs/reviews/`, preserved verbatim.

**This section is the register from now on.** New cross-spec findings land here; the dated pass record is the run log, not the tracker.

| ID | Sev | Finding | Issue |
|---|---|---|---|
| CV-20 | **AMENDED (resolved)** | The idempotency key hashed `(instrument, bar)` only. Once #616 made it stable within a bar and #668 put a mandatory flat-by-close exit into a bar an entry can also be taken in, the entry and the exit hashed identically and the exit — being second — was suppressed by all three dedup layers at once, carrying a position overnight against ADR-0014. The payload now carries `side: 'open' \| 'close'`. **The three layers are not independent:** `open_positions`'s primary key IS `idempotency_key`, so `findByKey`, the PK backstop and the broker `client_order_id` share one input and no single layer can be made smarter | [#686](https://github.com/dd-jp/samurai-trading-system/issues/686) |
| CV-21 | **MEDIUM — PARTLY BUILT 2026-08-17 by [#687](https://github.com/dd-jp/samurai-trading-system/issues/687)** (points 2/3/4 of the resolution; point 1 waits on the unbuilt decision gate — see the pass below). Design **SPECIFIED 2026-08-16** (see the pass below): the bar is to be inherited from `TickContext.decision_bar` and carried on `DebateResult`, with the Trader prohibited from deriving one from `clock.now()` | The Trader re-derives the decision bar from its own `clock.now()` rather than inheriting the debate's, so a debate straddling an hour boundary keys the intent into bar N+1 while `debate_id` says N — and bar N+1's real decision then collides with it and is suppressed. **The contract change landed 2026-08-17 (#687): `DebateResult.bar_timestamp` is required, and `decide.ts` inherits it instead of flooring a clock read.** What remains is point 1 — routing that one floored read from the Orchestrator's `TickContext.decision_bar` once the tick/decision split exists. (An earlier revision of this row claimed the change had landed when it had not; it has now, and the residue is named rather than the row closed) | [#687](https://github.com/dd-jp/samurai-trading-system/issues/687) |
| CV-15 | ~~**BLOCKING (live path)**~~ **RESOLVED 2026-08-17** | With ADR-0013 removing every human gate, the numeric thresholds are the only remaining control — and both specs exposed them as unclamped config, so a config edit was the whole distance to an arbitrary risk limit. Now bounded in code and **refused, never coerced**, at all four seams that can put a number into force — including the live `risk_thresholds` read, which is the path the Feedback Loop moves a dial on between two ticks. Decision recorded once in §9 | [#638](https://github.com/dd-jp/samurai-trading-system/issues/638) |
| CV-14 | HIGH | `feedback-loop-spec.md:91`'s `approvals: ApprovalChannel` does two jobs — gated loosening *and* breach alerts. Removing the gate must not remove the alert, the only way an operator learns the edge died | [#639](https://github.com/dd-jp/samurai-trading-system/issues/639) |
| CV-2 | ~~HIGH~~ **RESOLVED 2026-08-15** | `risk-manager-spec.md` states no behaviour on upstream read failure, in the stage billed "must be trusted absolutely under stress". **Premise partly wrong and worth recording:** `evaluate()` is synchronous and pure and performs no upstream reads at all — it receives `portfolio`/`breakers`/`correlation`/`cii` pre-computed — so the failure mode was never inside it. A read that FAILS already failed closed (the rejection aborts the instrument pass and places no order); the real gap was a read that SUCCEEDS with a stale value, which nothing checked. Now `computePortfolioView` throws `StaleMarkError` past `RiskConfig.max_mark_age` | [#640](https://github.com/dd-jp/samurai-trading-system/issues/640) |
| CV-6 | ~~MEDIUM~~ **RESOLVED 2026-08-15** | `stale_feed` gate described as live by `market-data-service-spec.md` and this registry §3; absent from `verdict-spec.md`. Ruled **implement, not delete** — `Mark.observed_at` exists to power it, and feed age is a failure the signal-age gate structurally cannot catch. Now `verdict-spec.md` gate 2 | [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) |
| CV-4, CV-5 | ~~MEDIUM~~ **RESOLVED 2026-08-17** | `risk-manager-spec.md`'s "fully mechanical, no LLM" / "fully deterministic" claims looked contradicted by the spec's own Risk Critic (ADR-0003, step 7). **Resolved per David's ruling on the issue: the "no LLM" claims are the true ones and stand.** `evaluate()` is a pure function that never constructs a prompt or calls a model; a critic verdict can only ever enter as pre-built data on `RiskInput.critic`, the same seam `cii`/`correlation` already use — confirmed by grep: no LLM/Nous import anywhere in `server/pipeline/risk-manager/`. What was actually wrong was step 7's and "Module: Risk Critic"'s framing, which read as though the pipeline performs the LLM pass itself; both are re-specified to state the seam explicitly. **Also checked while fixing this: no producer for that verdict is wired at all** — no producer source file exists (only a stale compiled `dist/risk-manager/critic-store.js` with no `.ts` behind it), and `direct-bind.ts:568` already carries a comment saying the step has never run in any environment (see [#513](https://github.com/dd-jp/samurai-trading-system/issues/513), left open — its cost/cadence/fail-open questions only bind if a producer is ever built). **Superseded on that last point 2026-09-01:** #513's questions were answered by [#955](https://github.com/dd-jp/samurai-trading-system/issues/955) and the producer built by [#957](https://github.com/dd-jp/samurai-trading-system/issues/957) (`risk-manager/critic.ts`). CV-4/CV-5 stay RESOLVED and the "no LLM" claims stay true: the producer runs outside `evaluate()`, which still constructs no prompt and calls no model | [#642](https://github.com/dd-jp/samurai-trading-system/issues/642) |
| CV-9, CV-10, CV-11 | ~~MEDIUM~~ **RESOLVED 2026-08-17** | Three stale/self-inconsistent passages in `trader-spec.md`. CV-9: the `direction`/`debate_id` "must be reconciled" language dropped — both are defined in `debate-engine-spec.md` and settled in this registry's §1/§2. CV-10: **not the direction the finding assumed.** [#224](https://github.com/dd-jp/samurai-trading-system/issues/224) deferred #74 on 2026-07-28; #74 shipped and closed 2026-08-06. `trader-spec.md`'s un-phased position-aware routing describes what's built; `orchestrator-spec.md`'s 2026-07-28 addendum was the stale half and is corrected to record that #74 landed. CV-11: the `flip` case dropped from the routing-test list — `OrderIntent.intent_type` is `'entry' \| 'scale_in' \| 'exit'`, no `flip`; a reversal is exit-then-fresh-entry, tested as two cases | [#643](https://github.com/dd-jp/samurai-trading-system/issues/643) |
| CV-7, CV-8, CV-13 | ~~LOW~~ **RESOLVED 2026-08-17** | Shared-type drift: `Direction` undefined at spec level (code has it) — now §10; `ClosedTrade` promised as a dashboard read that does not exist — registry's OPEN-GAP-B corrected, `dashboard-spec.md` was accurate all along; `AlpacaClient` name collision — code renamed to `AlpacaBrokerClient`/`AlpacaMarketDataClient`, no aliasing needed at either call site that imported both; `DateRange` consumed by three specs and defined by none — now §10; no transport↔`BrokerAdapter` cross-reference — one paragraph added to `transport-layer-spec.md`'s `AlpacaBrokerClient` module | [#644](https://github.com/dd-jp/samurai-trading-system/issues/644) |
| CV-1 | ~~LOW~~ **RESOLVED 2026-08-17** | `mode` unions omit `'paper'` in three specs while `execution-spec.md:103` includes it. Downgraded 2026-08-09 — ADR-0013 made breaker re-arm mode-independent, so this is type accuracy, not a safety fork. **One of the three was already moot:** [#736](https://github.com/dd-jp/samurai-trading-system/issues/736) removed `DailyCycleInput.mode` entirely (the loosen gate was its only reader), so `feedback-loop-spec.md` needed no change — it already documents the removal. `risk-manager-spec.md`'s `RiskInput.mode` and `verdict-spec.md`'s `VerdictInput.mode` both widened to `'live' \| 'paper' \| 'backtest'`, matching code that already carried the third value | [#644](https://github.com/dd-jp/samurai-trading-system/issues/644) |
| CV-19 | HIGH | [#627](https://github.com/dd-jp/samurai-trading-system/issues/627)'s client/server/contracts split left **~180 dead `src/…` path citations across 44 docs** — inline backticked paths no link checker validates, with line numbers drifted as well. ADR-0007's serialization argument cites two of them | [#645](https://github.com/dd-jp/samurai-trading-system/issues/645) |
| CV-12 | ~~LOW~~ **RESOLVED 2026-08-17** | `risk-manager-spec.md` stale "v1 static concentration buckets" in the CII module — corrected to name the dynamic pairwise-correlation matrix (Check Pipeline step 6) it was superseded by | [#644](https://github.com/dd-jp/samurai-trading-system/issues/644) |
| CV-17 | ~~LOW~~ **RESOLVED-ON-RATIONALE 2026-08-17, one question named open** | `TELEGRAM_ALLOWED_USER_IDS` validated at boot for a gate that cannot fire. **The suggested fix ("required only if an approval transport is ever re-armed") does not hold under the current code and was not applied as-is**: re-arming needs two code changes (`assertAutomationLevelSupported` no longer refusing a non-`auto` dial, and the still-unbuilt approval poll loop, #275), not a config flip, so there is no live conditional state to gate the requirement on today. `verdict-spec.md`'s "Boot-time validation" bullet is corrected to say what the check actually protects today: a constructor invariant of the one `TelegramBotApiClient`, required whenever `SAMURAI_ALERTS=telegram` because the same client carries real heartbeat/escalation alerting (CV-14), independent of HITL. **Left open, not decided here:** whether the allowlist requirement *should* be decoupled from the alerting client (e.g. a dedicated approval-only transport with its own validation) is a design question this pass answered "not now" on evidence, not one this LOW-severity text pass had standing to close permanently — a future ticket re-arming approval should re-examine it rather than assume this rationale still holds | [#644](https://github.com/dd-jp/samurai-trading-system/issues/644) |

**Closed in the same pass, not filed:** CV-16 (two specs still routing decisions to a human — fixed directly, since an accepted ADR makes them factually wrong). **Moot:** the 2026-07-26 `ApprovalChannel` authn finding — nothing authorises a decision any more, though CV-14 keeps the channel alive for alerting. **Re-affirmed clean:** `execution-spec.md:316`'s broker-cutover manual sign-off, which is an infrequent operator action outside the tick loop and survives ADR-0007 and ADR-0013 on its own stated reasoning.

---

## Cross-spec verification, 2026-08-16 — the intraday re-specification pass

Run per Standing Pipeline Rule 7 after map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703) closed and six specs were amended: `orchestrator`, `universe-selector` (re-specified modules), `trader`, `risk-manager`, `analysts`, `market-intelligence` (amended). `market-data-service-spec.md` needed no change — `:204` and `:208` already reserve indicator selection and timeframes as config.

**Two entries were required to be resolved by this pass rather than carried forward.** Both are resolved below — "resolved" meaning **the design question is settled**. CV-21's resolution is a specification that #687 must still implement; the calendar entry below is settled in code. The distinction is stated because conflating the two is what an earlier revision of this document did.

### CV-21 / [#687](https://github.com/dd-jp/samurai-trading-system/issues/687) — PARTLY BUILT (2026-08-17): the decision bar is inherited, never re-derived

> **Status, stated plainly because the heading previously read "RESOLVED", that was read as shipped, and it was not.** The design question was settled by this pass (the four numbered points below). **Points 2, 3 and 4 are now in the code**, shipped by #687: `DebateResult.bar_timestamp` is a required field, `buildDebateLog` projects it off the result rather than taking a second copy, `decide.ts` no longer imports `floorToBar`/`DEBATE_BAR_TIMEFRAME_MS` at all, and `decisionBarFor` returns `debate.bar_timestamp` — it takes no clock and computes nothing. There is exactly ONE place in the live path that floors a clock read onto the bar grid: `buildDebateStep`.
>
> **Point 1 is NOT built, because the thing it names does not exist yet.** There is still no `TickContext.decision_bar` and no tick/decision split in the code; until the Orchestrator's decision gate lands, the debate step's single floored read *is* the sole authority, and the gate's job when it lands is to replace that one `floorToBar(clock.now())` call with the inherited `ctx.decision_bar` — a one-line change at one call site, which is why #687 was implemented as one floor site rather than two agreeing ones. **This row stays open until that substitution is made**; what closed with #687 is the split between the debate's bar and the Trader's.

**Was:** HIGH (live path). The Trader re-derives the decision bar from its own `clock.now()` rather than inheriting the debate's, so a debate straddling an hour boundary keys the intent into bar N+1 while `debate_id` says N — and bar N+1's real decision then collides with it and is suppressed.

**Why this pass had to resolve it rather than record it.** The tick/decision split makes this **structural instead of incidental**. Previously the two derivations agreed except on a straddle; now the Orchestrator gates the whole expensive path on "is this a new debate bar", so there are two independent notions of the bar in the live path by construction — one deciding whether to run, one deciding how to key the result. **The failure mode is a suppressed entry, which presents as a healthy no-trade tick** — this system's signature failure ([#625](https://github.com/dd-jp/samurai-trading-system/issues/625), [#691](https://github.com/dd-jp/samurai-trading-system/issues/691)) and the reason this cannot ship as a known issue.

**Resolution — one source, passed down, never recomputed:**

1. **The Orchestrator's decision gate is the sole authority on the bar.** `orchestrator-spec.md` now carries `TickContext.decision_bar { id, open_time, timeframe_ms }` and states it is *the* single source.
2. **`DebateResult` must carry the bar it was decided on** — the contract change CV-21 named. Registry §1 already makes `debate_id` load-bearing for three consumers; the bar travels with it rather than beside it.
3. **The Trader consumes the inherited bar and must not call `clock.now()` to derive one.** Its clock stays injected for timestamps; deriving a *bar* from it is what is prohibited.
4. **The dedup key must be the same key [#617](https://github.com/dd-jp/samurai-trading-system/issues/617)'s fix uses.** A second notion of "new bar" introduced by the gate would reintroduce duplicate debates — the defect #617 already paid for.

**Verification is by mutation, not by inspection:** force the decision gate permanently open and assert the debate count per bar stays at one; force it permanently closed and assert the flatten still fires. An assertion that merely reads the field proves nothing about which value was used.

### Trading-calendar / session source — RESOLVED, and upgraded from LOW on the way

**Was:** listed under LOW as *"trading-calendar/session source unspecced."* **That severity was wrong the moment flat-by-close became an invariant**, and this pass records the upgrade rather than quietly fixing it — the calendar now resolves `sessionEnd`, which is what the mandatory flatten fires against. An unspecced source for a load-bearing invariant is not LOW.

**Resolution, now in `orchestrator-spec.md` as "The window is policy; the calendar is venue":**

- **`LseRegularHoursCalendar`'s 08:00–16:30 is venue truth and must not be narrowed** to the entry window. The same object resolves `sessionEnd` for [#657](https://github.com/dd-jp/samurai-trading-system/issues/657)'s flatten, so narrowing it to 14:30–15:45 would move the close to 15:45 and **delete every tick that could flatten** — the exact class of defect `2f22033` already fixed once.
- **The entry window is a separate policy predicate**, composed as `calendar.isOpen(t) && window(t)`, and the tick window must be the entry window **∪ the flatten tail**, asserted **unpinned** (a test pinning the tail to 16:25 passes while the composition is wrong).
- **`equityCalendarFor(config)` is pure and calendars are stateless**, which is why the component root's and the orchestrator root's separate instances agree. That property is now stated rather than relied on silently.

### New findings from this pass

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| CV-22 | **HIGH** | **OPEN-GAP-D's settled wording is now false.** It records the Orchestrator as emitting *"`Signal` per instrument per tick"*, and the tick/decision split makes that per instrument **per decision bar**. Left as-is, a reader implementing to OPEN-GAP-D rebuilds the 30×-redundant analyst path the split exists to remove | Fixed in place — see the amendment appended to OPEN-GAP-D below |
| CV-23 | **HIGH** | **`screening_instrument` crosses a boundary the routing invariant was built to police.** `universe-selector-spec.md` now carries two instrument identities per pool row; `AssetClassRoutingDataSource#routeFor` deliberately throws on unknown instruments. The invariant holds **only** if `screening_instrument` never reaches the routing map — which is an assertion, not an accident | Asserted in `universe-selector-spec.md` test seam 3: a `screening_instrument` symbol must not appear in a watchlist |
| CV-24 | **MEDIUM** | **`subclass` is a new shared dimension with no owner in this registry.** `trader-spec.md` keys `risk_fraction` on it, `risk-manager-spec.md` keys tiering on it, `universe-selector-spec.md` sources it from the pool file. Nothing states where it is defined or that an unknown value must fail loud | Owner: `contracts/` alongside `AssetClass`. Unknown subclass **fails loud**, never defaults — a default means full deployment |
| CV-25 | **MEDIUM** | **Crypto removal leaves live code with no product behind it.** `AssetClass`, `AlwaysOpenCalendar`, `sessionCalendars`, crypto config keys and `SMOKE_TEST_UNIVERSE`'s BTC-USD entry all remain. ADR-0014's amendment deliberately does **not** decide their removal | Operative rule, enforced at review: **no spec, gate, measurement or ticket may assume a crypto path exists.** The code question stays open and is not a blocker |
| CV-26 | **MEDIUM** | **`binding_constraint` gains `below_minimum_size`**, and it must be distinguishable in `risk_log` from a conviction rejection. Otherwise a full deployment envelope is indistinguishable from a healthy no-trade tick | Specified in `risk-manager-spec.md`, "The deployment envelope is the concurrency rule" |
| CV-27 | **HIGH** | **The mandatory flatten crosses Trader → Risk → Execution as an ordinary exit, and three separate mechanisms could block it**: a tripped breaker, an exposure cap, and the min-viable-size reject. Each is individually reasonable and each would hold a position overnight against ADR-0014's invariant | Resolved in `risk-manager-spec.md`: exits skip all entry gates (`:15`, reaffirmed), and min-viable-size is explicitly an **entry-path** gate |
| CV-28 | **MEDIUM** | **`current_tick`'s stage enum gains `'position_check'`**, which needs a table-rebuild migration exactly as `'invalidation'` did. A tick that ends at `position_check` is a **normal** outcome (~29 of 30 passes), so any alerting keyed on "tick did not reach verdict" would fire constantly | Specified in `orchestrator-spec.md`; flagged here because the migration and the alerting rule live in different specs |
| CV-29 | LOW | **The analyst LLM withdrawal orphans three decisions in `analysts-spec.md`** — the input-hash response cache, cheap/premium backtest tiers, and temperature-0 replay. They are not wrong; they now belong to the **debate** stage | Recorded in `analysts-spec.md`; no debate-engine-spec change made, since those decisions already exist there |

### Re-affirmed clean under the amended specs

- **`debate_id`'s three consumers** (registry §1) are unaffected by the tick/decision split — fewer debates, same contract per debate.
- **Execution as sole writer of `ClosedTrade`/`Fill`** (§4) is untouched; the flatten and the early exit both produce ordinary exits through the existing path rather than writing directly.
- **CV-20's `side: 'open' | 'close'` idempotency fix holds** and is *more* load-bearing now: the tick path can emit an exit in the same bar an entry was taken.
- **ADR-0018 D4's trial discipline survives the screener rewrite** — one axis is a sort with no free parameter, so the selector contributes **zero trials**.

### Still open, deliberately

- ~~**CV-15 / [#638](https://github.com/dd-jp/samurai-trading-system/issues/638)** (unclamped thresholds) remains **BLOCKING for live** and this pass does not clear it.~~ **Cleared 2026-08-17 by #638** — see §9. The per-subclass `risk_fraction` values noted here as "more config surface on the same unclamped path" are *not* on that path: `per_subclass_deployment_cap` is deliberately absent from the tunable allow-list entirely, which §9 records as the stronger guarantee.
- **CV-4/CV-5 / [#642](https://github.com/dd-jp/samurai-trading-system/issues/642)** (risk-manager "no LLM" vs its own binding LLM critic) is untouched — it predates the horizon change and is not resolved by it.
- **GAP-G's premise has changed** and should be re-read at triage: an Alpaca `DataSource` was needed for SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD, none of which is now a live instrument. Alpaca remains the **screening and paper** source, so the gap survives with a different justification rather than closing.

**Amendment to OPEN-GAP-D (2026-08-16), per CV-22:** the Orchestrator emits `Signal` per instrument **per decision bar**, not per tick. Ticks between decision bars run the cheap path — mark, bracket, early-exit check, flatten — and emit no `Signal`. The ownership settlement is otherwise unchanged: scanning belongs to the Universe Selector, scheduling and `Signal` emission to the Orchestrator.
