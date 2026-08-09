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

- **`direction: 'bullish' | 'bearish' | 'neutral'`** — structural, so a no-LLM Trader maps to order `side` without parsing free-text.
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
- **`Mark.observed_at`** = data-observation timestamp (not request time). Powers Verdict's OPTIONAL `no_go_reason: 'stale_feed'` gate (supplements, does not replace, `decision_timestamp` signal-age gate).
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

- **The pipeline is SEVEN stages**, not six: `analysts → debate → trader → invalidation → risk → verdict → execution`. `TickStage` and `current_tick.stage` both gain `'invalidation'`; the latter's SQL `CHECK` over six names requires a table-rebuild migration.
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
- **Narrowing rule — load-bearing:** the stage's outcome union has three statuses (`evaluated` / `no_conditions` / `unavailable`) and only `evaluated` carries an `InvalidationResult`. The other two both arrive at Risk as `undefined`. **Risk cannot and must not distinguish them**; that distinction survives in `invalidation_log` and the warn/alert path only. It is a prompt-safety property, not a convenience — see devils-advocate-spec.md.
- **`invalidation_log` retrieval is by `(instrument, bar_timestamp)`, NOT by any generated id**, because a replay mints fresh `trace_id`/`debate_id` values and cannot bridge to live rows. `bar_timestamp` must be **floored to the instrument's bar boundary**. Note this is a live defect on the `debate_log` write path too, which stores `clock.now()` unfloored.

---

## OPEN GAPS (found in this pass — resolve before / during `/to-tickets`)

- **RESOLVED: OPEN-GAP-A — `MarketState.spread` and `.adv` have no clean source.** Resolved hybrid: MDS exposes a best-effort spread estimate (bid/ask where available, e.g. crypto ccxt; null otherwise) + an ADV helper (bars-volume aggregation); cost model fallback-models spread from volatility + per-asset-class model when MDS returns null, guaranteeing a non-zero spread term always. See market-data-service-spec.md Out of Scope + cost-model-backtest-spec.md §Spread sourcing.
- **RESOLVED (reversed 2026-07-21): OPEN-GAP-B — DoD #7 (dashboard/CLI) has no spec.** Originally resolved 2026-07-14 as a minimal read-only CLI. Reversed 2026-07-21 after `server/apps/service-api/` (now `server/apps/service-api/`) was built ahead of process (no map/spec) and grilled to a decision: the **Dashboard supersedes the CLI**, not complements it — one operator surface, not two. Charted in [dashboard-map.md](../wayfinder/dashboard-map.md) / specced in [dashboard-spec.md](../specs/dashboard-spec.md) (formerly `cli-map.md`/`cli-spec.md`, renamed and rewritten in place) — the **12th and final component**. Pure presentation layer, zero new writes: reads `audit_log` (Orchestrator), `OpenPosition`/`ClosedTrade` (Execution), `DebateLog` (Debate Engine), weights/attribution + `MetricsSuite` (Feedback Loop), verdict audit trail (Verdict), `getMark` (Market Data Service, for unrealized PnL). Same one flagged scope reduction as before: "pending debates" shows completed `DebateLog` entries + a coarse Orchestrator tick-status line, not a live in-flight debate view (the Debate Engine's round state is deliberately not persisted, decision #10). `src/cli/` removed as part of this reversal.
- **RESOLVED: OPEN-GAP-C — DoD #8 (structured logs + trace IDs) + JSONB audit spine have no owner.** Resolved: the **Orchestrator** ([orchestrator-map.md](../wayfinder/orchestrator-map.md) / [orchestrator-spec.md](../specs/orchestrator-spec.md)) owns trace-ID generation/threading, the shared structured-`Logger` interface every stage logs through, and an `audit_log` table in the shared SQLite store (mining the JSONB *pattern*, not a separate JSONB/Supabase system).
- **RESOLVED: OPEN-GAP-D — Orchestrator uncharted.** Charted 2026-07-14. Owns: tick-loop + injected `Clock` (the seam cost-model-backtest-spec's "same code path" guarantee depends on), Signal production/scanning (~~fixed universe iteration, v1~~ — closes GAP-I's producer question; **amended 2026-08-07:** the Orchestrator still emits `Signal` per instrument per tick, but *which* instruments is no longer a static config list — it comes from an `ActiveUniverseProvider` fed by the Universe Selector, see [universe-selector-spec.md](universe-selector-spec.md) and map [#397](../../issues/397)), trace-IDs/structured-logs/audit-spine (closes OPEN-GAP-C), dead-man's-switch heartbeat over Verdict's existing trade channel. Built on ADR-0001's now-resolved open questions (TypeScript core; debate substrate reimplemented, not LangGraph-dependent).

## Full sweep findings (2026-07-13/14 — read-only verification pass, ranked most-severe)

**HIGH — MVP-blocking or load-bearing, not yet resolved:**
- **GAP-E — `ExecutionInput` has no `MarketDataService` handle.** `CostModel.fill(request, marketState)` is called only by Execution's Simulated adapter, but `ExecutionInput` injects `clock/broker/store/costModel/config/mode` — no market-data source to assemble `MarketState.mid/spread/adv/volatility` from. Unlike Trader/Risk/Verdict, which all inject `MarketDataService`. **Fix:** add `marketData: MarketDataService` to `ExecutionInput`; the Simulated adapter builds `MarketState` from it before calling `CostModel.fill`.
- **GAP-F — Two incompatible `Fill` shapes.** Execution's `Fill` (`idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp`) has no `cost_breakdown`, but registry §4 mandates `Fill.cost_breakdown` for FL's live-vs-modeled divergence check, and the cost-model's `Fill` (`fill_price, filled_size, cost_breakdown, seed?`) uses different field names entirely. **Fix:** Execution's `Fill` is the persisted record (authoritative, sole-writer per §4) and must gain a `cost_breakdown?` field (optional/null on live fills where unavailable, populated on simulated fills from `CostModel.fill`'s output) — field names reconciled to Execution's (`price`/`qty`), not the cost model's internal naming.
- **GAP-G — MVP path (Alpaca) has no Market Data Service source.** MDS's `DataSource` port only names ccxt/Kraken + IBKR; no Alpaca `DataSource`, despite Alpaca being the ADR-0001 MVP execution path for SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD. **Fix:** add an Alpaca `DataSource` implementation to MDS (Alpaca serves both historical bars and streaming quotes for its execution universe).
- **FIXED: GAP-H — `DebateLog` is referenced (registry §1, FL's system-of-record) but never defined or written.** Fixed in `docs/specs/debate-engine-spec.md`: added the `DebateLog` type definition (alongside `DebateResult`/`AnalystContribution`), a "Debate log write" step in the round-termination lifecycle (written once, append-only, after resolution), and reworded the "State Persistence" module (+ its Out of Scope entry) so it no longer reads as blanket "No Persistence" — it now distinguishes ephemeral operational/round state (still not persisted, unchanged decision #10) from the completed `DebateLog` (IS persisted).
- **FIXED: GAP-I — Signal/scan/idea-generation producer unspecced (DoD #1).** Fixed in `docs/specs/analysts-spec.md`: added a "Signal Production (out of scope, flagged dependency)" note under Out of Scope (plus a matching line in the Dependencies list) naming the Orchestrator (OPEN-GAP-D) as the likely owner of universe scanning/scheduling that emits `Signal` per instrument per tick — not designed here, just flagged so it isn't lost. **Ownership settled 2026-08-07:** scanning is *not* the Orchestrator's after all — it belongs to the **Universe Selector** ([universe-selector-spec.md](universe-selector-spec.md), map [#397](../../issues/397)), an out-of-session job that writes a watchlist; the Orchestrator keeps scheduling and per-tick `Signal` emission over whatever active list it is given.

**MEDIUM:**
- Funding/borrow accrual unowned in the LIVE path (cost-model only applies it in backtest mark-to-market; Risk's live `PortfolioView.equity` has no accrual term).
- PBO 0.05 kill-line exposed as tunable config in cost-model spec, when research/CONTEXT treat it as a fixed bright line — risks the one hard kill criterion being softened.
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
| CV-15 | **BLOCKING (live path)** | With ADR-0013 removing every human gate, the numeric thresholds are the only remaining control — and both `risk-manager-spec.md` and `cost-model-backtest-spec.md` still expose them as unclamped config. A config edit is now the whole distance to an arbitrary risk limit | [#638](../../issues/638) |
| CV-14 | HIGH | `feedback-loop-spec.md:91`'s `approvals: ApprovalChannel` does two jobs — gated loosening *and* breach alerts. Removing the gate must not remove the alert, the only way an operator learns the edge died | [#639](../../issues/639) |
| CV-2 | HIGH | `risk-manager-spec.md` states no behaviour on upstream read failure, in the stage billed "must be trusted absolutely under stress" | [#640](../../issues/640) |
| CV-6 | MEDIUM | `stale_feed` gate described as live by `market-data-service-spec.md` and this registry §3; absent from `verdict-spec.md` | [#641](../../issues/641) |
| CV-4, CV-5 | MEDIUM | `risk-manager-spec.md:11`/`:77` claim "fully mechanical, no LLM" / "fully deterministic" while the spec's own Risk Critic (ADR-0003) makes a binding LLM call | [#642](../../issues/642) |
| CV-9, CV-10, CV-11 | MEDIUM | Three stale/self-inconsistent passages in `trader-spec.md`: fields "must be reconciled" that already were; position-aware branching as MVP when [#224](../../issues/224) deferred it; a `flip` routing case tested but absent from `intent_type` | [#643](../../issues/643) |
| CV-7, CV-8, CV-13 | LOW | Shared-type drift: `Direction` undefined at spec level (code has it); `ClosedTrade` promised as a dashboard read that does not exist; `AlpacaClient` name collision; `DateRange` consumed by three specs and defined by none; no transport↔`BrokerAdapter` cross-reference | [#644](../../issues/644) |
| CV-1 | LOW | `mode` unions omit `'paper'` in three specs while `execution-spec.md:103` includes it. Downgraded 2026-08-09 — ADR-0013 made breaker re-arm mode-independent, so this is type accuracy, not a safety fork | [#644](../../issues/644) |
| CV-19 | HIGH | [#627](../../issues/627)'s client/server/contracts split left **~180 dead `src/…` path citations across 44 docs** — inline backticked paths no link checker validates, with line numbers drifted as well. ADR-0007's serialization argument cites two of them | [#645](../../issues/645) |
| CV-12, CV-17 | LOW | `risk-manager-spec.md` stale "v1 static concentration buckets"; `TELEGRAM_ALLOWED_USER_IDS` validated at boot for a gate that cannot fire | [#644](../../issues/644) |

**Closed in the same pass, not filed:** CV-16 (two specs still routing decisions to a human — fixed directly, since an accepted ADR makes them factually wrong). **Moot:** the 2026-07-26 `ApprovalChannel` authn finding — nothing authorises a decision any more, though CV-14 keeps the channel alive for alerting. **Re-affirmed clean:** `execution-spec.md:316`'s broker-cutover manual sign-off, which is an infrequent operator action outside the tick loop and survives ADR-0007 and ADR-0013 on its own stated reasoning.
