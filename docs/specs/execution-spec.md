# Execution Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Verdict has said `go` — but a `go` is a decision, not a fill. Something has to turn one broker-agnostic bracket (entry + stop + target) into real, broker-native multi-leg orders on Alpaca (paper) or Saxo (live equities, ADR-0015), watch those orders through partial fills and cancellations that may play out over days, and write every fill back to the shared store the rest of the system trusts as the record of what actually happened. Do it naively and the system breaks in the ways that lose real money: a crash mid-submit double-fills; a partial fill leaves a protective stop sized to phantom quantity; a broker rate-limit crashes the actor instead of backing off; the store drifts out of sync with the broker and Risk sizes against a position that no longer exists.

**Execution** is the thin actor at the tail of the pipeline (NOT one of the 6 pipeline stages — Verdict is the last stage; Execution is what Verdict triggers). It is deliberately mechanical: it does not reason about whether to trade — Verdict already cleared that. Its whole job is to place the cleared bracket *exactly once*, behind the mandatory broker abstraction, and to keep the shared store a faithful, crash-safe mirror of the broker so that Risk (exposure/drawdown), the Feedback Loop (outcomes), and the Trader (position awareness) all read reality.

## Solution

Execution is a **thin, mechanical actor** (no LLM, no trade re-evaluation) with **two surfaces**, because a bracket's lifecycle is asynchronous and outlives any single call:

1. **`execute(verdictDecision) → ExecutionResult`** — the primary seam. Dedupe on the idempotency key → expand the abstract bracket to broker-native multi-leg orders via the injected `BrokerAdapter` → write-ahead the order/position state → submit → persist the acknowledged state → return. It records; it does not block until "filled".
2. **`ingestFills()` / `reconcile()`** — the secondary surface. It ingests later fills (live WebSocket/poll; deterministic callbacks from the Simulated adapter in replay), advances the order state machine, sizes protective legs to *filled* quantity, and on round-trip-to-flat emits a `ClosedTrade` into the shared store — the record the Feedback Loop and Risk consume.

The **broker abstraction** is a `BrokerAdapter` interface over a normalized bracket: Alpaca (paper, US equities), Saxo (`saxo-adapter.ts`, `SaxoBrokerAdapter implements BrokerAdapter` — built, #1032/#1212/#1222/#1215), and a deterministic Simulated adapter all implement it, so nothing above the adapter knows which broker (or whether it is live, paper, or backtest). Saxo is the *designated* live-equities venue (ADR-0015's 2026-08-30 amendment) but is not yet wired at the composition root: `production.ts` defaults `config.broker` to `new AlpacaBrokerAdapter(...)` and nothing outside its own tests constructs `SaxoBrokerAdapter` — the mode branch that would select it live is unbuilt. **Idempotency** is enforced twice — a local shared-store check and a broker-native client-order-id — so submit-N-times yields exactly one fill. **Crash-restart safety** comes from write-ahead persistence plus reconciliation against the broker as source of truth. Same code path live / paper / backtest — only the injected adapter differs; the Simulated adapter fills against the injected clock and injected cost model.

Key architectural decisions:
- **Thin actor, gate-vs-actor split** — Verdict decides, Execution acts; no LLM, no re-evaluation.
- **Two surfaces** — `execute()` (submit + record) and `ingestFills()/reconcile()` (advance state, close trades) — because exit legs fill asynchronously, days later for stocks.
- **`BrokerAdapter` over a normalized bracket** — atomic bracket with one-cancels-other exit semantics guaranteed at the boundary; native on Alpaca's bracket order and, on Saxo, via an IfDone master + related orders whose OCO cancel-on-fill is venue-verified — what the venue does to the related legs when the master `DayOrder` *expires* unfilled rather than being cancelled is UNVERIFIED (#1215).
- **Double idempotency** — local store dedup + broker client-order-id, keyed on `hash(instrument + bar/timestamp)`.
- **Write-ahead + broker-source-of-truth reconciliation** — crash-restart never double-submits and never loses a position.
- **Partial fills first-class** — protective legs size to filled qty; persist requested AND filled.
- **Three record types** — `OpenPosition`, `Fill`, `ClosedTrade` — Execution is their sole writer.
- **One code path live/paper/backtest** — deterministic Simulated adapter over injected clock + cost model.

## User Stories

### Acting on a Go & Output

1. As Execution, I want to consume a Verdict `go` (`VerdictDecision` carrying the `OrderIntent`), so that I place only trades the pipeline has fully cleared.
2. As Execution, I want to never re-evaluate the trade (no LLM, no risk re-check beyond the mechanical idempotency dedup), so that the gate-vs-actor separation holds and Execution stays thin.
3. As Execution, I want to return an `ExecutionResult` recording what I submitted and the resulting order state, so that the caller and audit log have a complete record of the action.
4. As Execution, I want to route each `intent_type` (`entry`/`scale_in` → open a bracketed lot; `exit` → flatten), so that the Trader's position-lifecycle vocabulary is honoured.

### Broker Abstraction & Bracket Expansion

5. As Execution, I want to hand the injected `BrokerAdapter` a normalized bracket and let it map to broker-native multi-leg orders, so that no code above the adapter knows which broker (or whether live/paper/backtest).
6. As Execution, I want the abstract bracket to guarantee atomic entry + one-cancels-other (OCO) protective exit semantics at the boundary, so that when the stop or target fills the sibling is cancelled — native on Alpaca's bracket order; on Saxo, the venue holds the state machine and cancels the related legs on an explicit cancel of the IfDone master (verified), while the unfilled-`DayOrder`-expiry branch is unverified (#1215).
7. As the system, I want swapping the paper broker for the live one to be an adapter/config change, not a rewrite, so that broker choice stays isolated. *(Amendment 2026-09-09 (#1178): the config side of this swap is not yet built — `production.ts` has no mode branch selecting `SaxoBrokerAdapter`; today the swap would be a code change at the composition root, not a config change.)*

### Idempotency & Crash-Restart

8. As Execution, I want to dedup on the Trader-assigned `idempotency_key = hash(instrument + bar/timestamp)` against the shared store before submitting, so that a re-entry (crash-restart, retry) never opens a second order for the same instrument+bar.
9. As Execution, I want to pass the idempotency key as the broker client-order-id, so that even a duplicate submit the local check missed is deduped by the venue itself.
10. As Execution, I want to write the intended order to the store (state `pending`) BEFORE calling the broker, so that a crash between decision and broker-ack is recoverable.
11. As Execution, I want on restart to reconcile in-flight (`pending`/`submitted`) orders against the broker by client-order-id, correcting the store to match the broker (source of truth) and logging any mismatch, so that open positions are never lost or double-counted (CONTEXT.md crash-restart invariant).

### Order State, Partial Fills & Resilience

12. As Execution, I want an explicit order state machine (`pending → submitted → partially_filled → filled → closed`, terminal `cancelled`/`rejected`/`expired`) persisted at every transition, so that the trade's status is always durable and inspectable.
13. As Execution, I want protective stop/target legs sized to the *filled* quantity of the entry, so that a partial fill never leaves an over- or under-sized protective bracket.
14. As Execution, I want to persist BOTH requested and filled size (plus avg_fill_price and fees), so that downstream exposure and R are computed on reality, not intent.
15. As Execution, I want transient broker errors (network/5xx/timeout) retried with bounded exponential backoff + jitter, and non-transient rejections (insufficient funds, bad instrument, min-size) marked terminal `rejected` with no retry, so that I recover from blips without hammering on genuine failures.
16. As Execution, I want a per-adapter token-bucket throttle and backoff on broker rate-limit (429/pacing) responses, so that broker rate limits are absorbed as resilience events — distinct from the LLM/Claude usage hard-stop (CONTEXT.md invariant 6), which does not apply to this LLM-free actor.

### Fill Recording & Trade Close

17. As Execution, I want to write one `Fill` row per (partial) fill (leg-tagged entry/stop/target/exit), so that every fill is logged (CONTEXT.md invariant 4) and the accounting view can reconstruct realized PnL.
18. As Execution, I want to maintain an `OpenPosition` record (instrument, asset_class, side, filled size, avg entry, live bracket stop/target, order state, broker ids, `idempotency_key`, `debate_id`), so that the Trader can be position-aware and Risk can compute exposure.
19. As Execution, I want to emit a `ClosedTrade` on round-trip-to-flat carrying the entry bracket (entry, stop, filled_size), realized PnL net of fees, `debate_id`, `idempotency_key`, and open/close timestamps, so that the Feedback Loop can compute `R = realized PnL ÷ (|entry − stop| × filled_size)` and label the setup store — even if the close happens days later.
20. As Execution, I want each `entry`/`scale_in` tracked as its own lot with its own bracket and `debate_id` (v1), so that the Feedback Loop's single-entry-bracket R assumption holds; blended-average-position accounting is deferred (v2).

### Determinism & Backtest

21. As the system, I want Execution to run the same code path live / paper / backtest, differing only in the injected `BrokerAdapter`, so that backtests and paper trading exercise real execution behaviour.
22. As the system, I want the Simulated adapter to fill deterministically against the injected clock and the injected cost model (transaction-cost + market-impact), so that replayed fills are reproducible and costs are honest (research docs 00/01/02).
23. As Execution, I want reconciliation and fill-ingestion driven by the injected clock, so that a backtest advances the bracket lifecycle in simulated time with no lookahead.

## Implementation Decisions

### Module: Execution Core

**Responsibilities**
- `execute()`: dedupe → expand bracket via the adapter → write-ahead → submit → persist ack state → return `ExecutionResult`.
- `ingestFills()/reconcile()`: advance the state machine on new fills, size protective legs to filled qty, emit `ClosedTrade` on flat, correct the store against the broker on mismatch.
- Route `intent_type` (entry/scale_in/exit); enforce idempotency; own crash-restart reconciliation.

**Key Interfaces**

```typescript
// Primary test seam. Deterministic given the injected adapter + clock + store.
interface Execution {
  execute(verdict: VerdictDecision): Promise<ExecutionResult>;   // acts only on status: 'go'
  ingestFills(): Promise<void>;   // advance state machine on new fills (live poll/WS or sim callback)
  reconcile(): Promise<ReconcileReport>;   // store ↔ broker; broker is source of truth
}

interface ExecutionInput {          // injected dependencies (constructor / DI)
  trace_id: string;                 // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  clock: Clock;                     // wall-clock live, simulated T in replay
  broker: BrokerAdapter;            // Alpaca (paper) | Saxo (live equities) | Simulated
  store: SharedStore;               // sole writer of positions/fills/closed-trades
  costModel: CostModel;             // consumed by the Simulated adapter only (separate component)
  marketData: MarketDataService;    // consumed by the Simulated adapter to assemble MarketState
                                     // for CostModel.fill (same injection pattern as Trader/Risk/Verdict)
  config: ExecutionConfig;          // retry/backoff, throttle, poll/reconcile cadence
  mode: 'live' | 'paper' | 'backtest';
}

interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  broker_order_ids: string[] | null;   // entry + attached legs (or emulated ids)
  order_state: OrderState;             // state after execute() returns (usually 'submitted')
  reason: string | null;               // rejection / error / dedup detail
  timestamp: Date;
}

type OrderState =
  | 'pending' | 'submitted' | 'partially_filled' | 'filled'
  | 'closed' | 'cancelled' | 'rejected' | 'expired';
```

### Module: Broker Abstraction (`BrokerAdapter`)

- **One interface, three implementations** — **Alpaca** (paper, US equities), **Saxo** (`saxo-adapter.ts`, `SaxoBrokerAdapter` — designated the live-equities venue by ADR-0015's 2026-08-30 amendment; built, but not yet constructed anywhere outside its own tests — `production.ts` still defaults `config.broker` to `AlpacaBrokerAdapter` unconditionally), **Simulated** (backtest/paper). Execution passes a **normalized bracket**; the adapter maps it to native multi-leg orders and normalizes broker fills/positions/order-state back to the shared types.
- **Contract guaranteed at the boundary:** atomic bracket = entry order + attached stop + attached target with **one-cancels-other** semantics. Adapters fulfil it however they can:
  - **Alpaca:** native bracket order (entry + take-profit + stop-loss legs with OCO exit) — native bracket support means the atomic bracket + OCO guarantee holds without Execution-managed emulation.
  - **Saxo:** native IfDone master (limit entry) with two related orders (`StopIfTraded` stop, `Limit` target); the venue holds the state machine and cancels the related orders with the master on an explicit cancel — verified for that path (doc 43); what happens to the related legs when the `DayOrder` master expires unfilled rather than being cancelled is unverified (#1215), so the OCO guarantee is not yet proven end-to-end on this adapter.
  - **Simulated:** models the same lifecycle deterministically.
- **Client order id = idempotency key** (or a deterministic derivation respecting venue id constraints).

```typescript
interface BrokerAdapter {
  submitBracket(order: NativeBracketRequest): Promise<BrokerAck>;   // entry + attached OCO exit
  submitFlatten(instrument: string, side: 'buy' | 'sell', size: number,
                clientOrderId: string): Promise<BrokerAck>;         // exit intent
  cancel(clientOrderId: string): Promise<void>;
  getOrder(clientOrderId: string): Promise<NormalizedOrder | null>; // reconciliation lookup
  getOpenPositions(): Promise<NormalizedPosition[]>;                // reconciliation snapshot
  fetchNewFills(since: Date): Promise<NormalizedFill[]>;            // poll; live adapters may also push
}
```

### Module: Idempotency & Crash-Restart

- **Two-layer dedup:** (1) local — `store.findByKey(idempotency_key)` returns an existing order/fill → `execute()` returns `deduped` without touching the broker; (2) broker — client-order-id makes a slipped-through duplicate a venue-side no-op.
- **Write-ahead:** persist the order (`pending`, keyed by `idempotency_key`) before the broker call; update to `submitted` on ack.
- **Restart reconciliation:** on startup, for every non-terminal store record, `broker.getOrder(clientOrderId)` decides truth — landed → adopt broker state; never placed → resubmit or mark `rejected`; store shows a position the broker doesn't (or vice-versa) → **correct the store to the broker and log/alert** the divergence. This is where a post-crash double-submit is actually prevented.

**Amendment 2026-09-09 (#1122) — "log/alert" is not uniform for a landed bracket adopt.** The line above reads as though every corrected divergence is operator-visible. At the default `SAMURAI_LOG_LEVEL=info`, one class isn't: a bracket lot whose broker state lands `filled`/`partially_filled` is corrected but logged at `debug` (`reconcileDivergenceLevel()`, fill-sync.ts) and dropped — this was the deliberate noise reduction #1122 shipped, not a regression. Neither `runPoll` nor `runStartupReconcile` emits a summary line counting demoted divergences, so nothing else surfaces the correction either. The wedge signal for this class is `FilledZeroSizeThrottle` (filled-zero-size-throttle.ts, #1087): it watches `OpenPosition` rows at `filled`/`partially_filled` with `filled_size === 0`, which is exactly the shape a mis-adopted or stuck bracket produces, so a correction that goes wrong still becomes visible — just through that detector, not through this module's log line. This backstop covers only bracket-lot adopts (the only case that lands on an `OpenPosition`); flatten-adopt noise reduction is deferred and has no backstop yet — tracked as #1411.

### Module: Order State Machine & Partial Fills

- States as `OrderState` above; every transition persisted (durable, inspectable).
- **Partial fills:** entry lingers in `partially_filled`; the armed stop/target legs are (re)sized to cumulative *filled* quantity. Persist `requested_size` AND `filled_size` + `avg_fill_price` + `fees`. R and exposure downstream read the filled fields.
- **Round-trip to flat** (protective leg fully fills, or an `exit` fully fills) → state `closed` → emit `ClosedTrade`.
- **"Fully" is float-tolerant, by a relative epsilon (1e-12 of the lot).** Both sides of the comparison are float64 sums of decimal fill quantities, and two sums of the same true total differ unless the tranches share a summation order (0.3+0.3+0.4 is exactly 1; 0.7+0.2+0.1 is 0.9999999999999999). An exact `>=` therefore leaves a fully-exited lot open forever — no `ClosedTrade`, and a phantom position holding Risk's exposure caps. The epsilon is orders below any venue's lot granularity, so it absorbs float noise only. See [ADR-0005](../adr/0005-money-math-precision.md).

### Module: Resilience (retries / rate limits)

- **Retry classifier:** transient (network, timeout, 5xx, rate-limit) → bounded exponential backoff + jitter; non-transient (rejected: funds/instrument/min-size/permission) → terminal `rejected`, no retry.
- **Throttle:** per-adapter token bucket sized to venue limits; back off on 429/pacing.
- **Rate-limit boundary (reconciles CONTEXT.md invariant 6):** broker rate limits are resilience events on this LLM-free actor — throttle + retry, do NOT halt the system. The invariant-6 / CLAUDE.md HARD STOP is about *LLM/Claude usage* limits on the LLM-bearing stages, not broker HTTP 429s. Persistent broker errors *do* feed the operational latency/error halt (Risk's kill-switch path) — a halt-new-entries signal, separate from the LLM hard stop.

### Module: Trade-Record Schema (shared store — Execution is sole writer)

Three record types. **This schema is the load-bearing cross-spec deliverable** — verified field-by-field against every consumer (Risk `PortfolioView`, Feedback Loop `onTradeClose` + setup labelling, Trader position-awareness).

```typescript
// Live open state — Trader position-awareness + Risk exposure.
interface OpenPosition {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in';   // exits close a lot; they don't create one
  requested_size: number;
  filled_size: number;                  // cumulative; downstream reads THIS
  avg_entry_price: number;
  stop: number;                         // live protective legs (resized on partial fill)
  target: number;
  order_state: OrderState;
  broker_order_ids: string[];
  opened_at: Date;
  decision_timestamp: Date;             // the bar/decision time (from OrderIntent)
}

// One row per (partial) fill — every fill logged (CONTEXT.md #4).
interface Fill {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  // Populated only for fills produced by the Simulated adapter, mapped from
  // CostModel.fill's CostModelResult (see cost-model-backtest-spec.md) onto
  // this record's price/qty terminology. Undefined/null on real broker fills,
  // where a cost breakdown isn't available. Powers FL's live-vs-modeled cost
  // divergence check (cross-spec-contracts.md §4, GAP-F).
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
}

// Emitted on round-trip-to-flat — the Feedback Loop / Risk realized record.
// NOTE: feedback-loop-spec references `ClosedTrade` but never defines it. Defined HERE.
interface ClosedTrade {
  idempotency_key: string;
  debate_id: string;                    // attribution + setup-store join key
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  entry: number;                        // avg entry (from fills)
  stop: number;                         // initial protective stop → initial risk
  filled_size: number;                  // → initial risk = |entry − stop| × filled_size
  realized_pnl_net: number;             // net of fees
  fees_total: number;
  opened_at: Date;
  closed_at: Date;
  close_reason: 'stop' | 'target' | 'exit';
}
```

Consumers and the fields they bind:
- **Feedback Loop `onTradeClose(ClosedTrade)`:** `entry`, `stop`, `filled_size`, `realized_pnl_net`, `debate_id`, `idempotency_key` → `R = realized_pnl_net ÷ (|entry − stop| × filled_size)`; setup-store label joined by `idempotency_key`/`debate_id`.
- **Feedback Loop live-vs-modeled cost divergence check:** reads `Fill.cost_breakdown` where present (Simulated-adapter fills) and compares it against the cost breakdown attributable to real broker fills (fee/slippage attribution) for the same instrument/regime — `undefined` on a live fill simply means no modeled breakdown to compare that fill against.
- **Risk `PortfolioView`:** `OpenPosition.filled_size` × current mark (mark from Market Data Service) for exposure; `asset_class` for the crypto/stocks bucket; `ClosedTrade.realized_pnl_net` + win/loss for `consecutive_losses` / `daily_pnl_pct`.
- **Trader position-awareness:** `OpenPosition` instrument/side/filled_size/avg_entry.

### Module: Scale-In Policy (v1)

- Each `entry`/`scale_in` = its own lot (own bracket, own `debate_id`, own `ClosedTrade`/R). Preserves the Feedback Loop's single-entry-bracket R assumption without blended-average accounting (deferred to v2).

### Module: Determinism & Backtest

- Same code path live/paper/backtest; only the injected `BrokerAdapter` differs.
- **Simulated adapter:** deterministic fills against the injected clock + injected cost model (spread + commission + √-size market impact — a separate component Execution *consumes*, does not build). Before calling `CostModel.fill(request, marketState)`, the adapter builds `MarketState{mid, spread, adv, volatility, asset_class, timestamp}` from the injected `MarketDataService` — `marketData.getMark()` for `mid`/`timestamp`/`asset_class` and `marketData.getIndicator()` for `volatility` (and the MDS spread-estimate/ADV helper for `spread`/`adv`, per cross-spec §OPEN-GAP-A). Emits the same normalized fills/positions as live adapters, so `ingestFills()`/`reconcile()` are exercised identically.
- Paper = live market data + Alpaca paper adapter, for the live-equivalent arm. Backtest = historical data + Simulated adapter + simulated clock advancing the bracket lifecycle. No lookahead: fills only at/after simulated T. *(Amendment (#1178): this previously read as though Simulated served backtest alone, which undersold the "three implementations" line above. A second, Simulated-adapter arm — falsifier arm 2, the mandated matched control (`CONTEXT.md`, #636) — is wired unconditionally into every paper and live run alongside the Alpaca/Saxo arm, not gated on mode; see the control-arm composition in `server/apps/orchestrator/production.ts`, "A SIMULATED venue, never the live one." So paper mode runs both: Alpaca paper adapter for the arm under test, Simulated for the parallel control.)*

## Testing Decisions

### What Makes a Good Test

- Test at `execute(verdict)` with an injected **mock/simulated `BrokerAdapter`** + mock clock + in-memory store; assert on `ExecutionResult` and the persisted records.
- Test the lifecycle across the two surfaces: `execute()` then drive fills through the Simulated adapter and `ingestFills()`; assert the state machine transitions and the emitted `ClosedTrade`.
- No LLM to mock — assert deterministic outputs. Determinism test: same verdict + same simulated fills → same records (incl. idempotency key) across runs.

### Modules to Test

**Idempotency & Crash-Restart** — duplicate `execute()` on the same key → one order, second returns `deduped`; write-ahead `pending` exists before broker ack; restart reconciliation adopts broker truth and corrects/logs store-vs-broker mismatch (both directions).

**Bracket Expansion & OCO** — adapter maps the abstract bracket to native legs; when stop fills the target is cancelled (and vice-versa), across Alpaca-style and Saxo-style mocks — identical observable semantics.

**Partial Fills** — protective legs resize to cumulative filled qty; `requested_size` and `filled_size` both persisted; R inputs use filled + avg entry.

**Resilience** — transient error retries with backoff then succeeds; non-transient → terminal `rejected`, no retry; 429 → throttle/backoff, not a halt.

**Trade Records** — `OpenPosition`/`Fill`/`ClosedTrade` written with the fields each consumer binds; `ClosedTrade` on stop / target / exit close; `R` computable from the record; scale-in produces per-lot closed trades.

**Determinism & Backtest** — Simulated adapter fills reproducibly against clock + cost model; same input → same records; no fill before simulated T.

### Prior Art

- No implementation yet. Injected-clock / mode-flag / injected-dependency patterns mirror Verdict (injected `ApprovalChannel`), Risk, and the Trader. Deterministic-output assertions (no LLM mock) mirror Trader/Risk/Verdict. The Simulated `BrokerAdapter` is the execution analogue of Verdict's no-op `ApprovalChannel` and Risk's mocked `PortfolioView`.

## Out of Scope

**Verdict gating (Stage 5)** — Execution trusts a `go` and acts; it does not re-decide (beyond the mechanical idempotency re-check). No LLM, no risk re-evaluation.

**The transaction-cost / market-impact model** — a separate uncharted component. Execution *consumes* it in the Simulated adapter (same treatment as the backtest harness in feedback-loop-spec); it does not design it.

**Market Data Service** — a separate uncharted-elsewhere component; Execution only *consumes* it (via the injected `marketData: MarketDataService`, used by the Simulated adapter to build `MarketState` for `CostModel.fill` — see GAP-E) and does not design or own it. Execution supplies fills/positions/realized PnL, not marks.

**Portfolio-accounting view / metrics / R computation** — owned by Risk (Stage 4) and the Feedback Loop (Stage 6). Execution supplies the raw `Fill`/`ClosedTrade`/`OpenPosition` records they read.

**Trade-channel notifications** — Verdict owns the Telegram/Discord trade channel (verdict-spec story 14) and posts fills/no-gos. Execution only writes fills to the store; who-posts is a light wiring concern.

**Kill-switch / circuit-breaker decisions** — Risk/Verdict decide to halt; Execution obeys (places no new orders while halted). **Forced liquidation** may be exposed as an Execution capability (`submitFlatten`), but *deciding* to flatten (emergency module / kill-switch) is out of scope (risk-manager-spec defers forced liquidation to "a separate emergency module or Execution").

**Blended-average position accounting** — v1 is per-lot; blended-average scale-in accounting is deferred to v2.

**Exact values** — retry/backoff counts, throttle rates, reconciliation/poll cadence are config, tuned in paper trading.

## Further Notes

### Integration with Pipeline

```
… → Risk Manager → Verdict → Execution → Broker (Alpaca/Saxo/Simulated — Saxo built, not yet wired live at the composition root)
                            (this spec: thin actor)
Execution → shared store (OpenPosition / Fill / ClosedTrade)
   ├─→ portfolio-accounting view → Risk (exposure, drawdown, consecutive losses)
   ├─→ Feedback Loop (onTradeClose: R-label setup store; realized metrics)
   └─→ Trader (position-awareness)
Broker ── source of truth ──> reconcile() corrects the store
```

### Domain Glossary Alignment

Per CONTEXT.md:
- **Broker Abstraction Layer**: "hides which broker the strategy is talking to … Strategy sees orders/fills/positions. Broker code sees API calls. Never mix them." — the `BrokerAdapter` boundary.
- **Idempotent Order**: "submitted multiple times … results in exactly one fill." — two-layer dedup on `hash(instrument + bar/timestamp)`.
- **Shared State Store**: "open positions (reconciled against the broker as source of truth) … Execution writes fills." — this spec is that writer + reconciler.
- Invariants satisfied: #4 (every fill logged — `Fill` rows), #5 (crash-restart must not lose positions — write-ahead + reconcile).

### Broker-Adapter Cutover Process (Shadow Measurement, #177 resolution)

WorldMonitor's CONCEPTS.md documents a Shadow Measurement pattern — run a candidate read path against real traffic while still serving from the incumbent. #177 scoped it to the `BrokerAdapter` swaps only (Alpaca → ccxt for crypto, Alpaca → IBKR for stocks), not the paper→live capital graduation decision, which stays governed by [[live-money-graduation]] (no fixed date, promising paper metrics, human judgment). *(Amendment 2026-09-09 (#1178): both named targets are gone. Crypto left Samurai's scope entirely — ADR-0015's 2026-08-16 amendment — so there is no crypto cutover to shadow-measure. IBKR was disqualified on cost (#906). The live equities venue that actually shipped, Saxo, was not reached through this mechanism either: it was picked by direct decision (map #905, ADR-0015's 2026-08-30 amendment), not by shadow-run divergence metrics — there has been no Alpaca→Saxo shadow-measurement cutover. The pattern below remains available for a future broker swap; it currently has no live target.)*

- **Independent per asset class.** Crypto's Alpaca→ccxt and stocks' Alpaca→IBKR shadow-runs and cutover decisions are two separate gates on their own schedules — no coupling, matching the separate long-term brokers. *(This bullet previously justified the split by "crypto/stocks' already-separate tick cadences (5s/30s)". There is no such split in code: the tick loop runs one shared interval — `DEFAULT_TICK_INTERVAL_MS` is 60s and the paper profile sets `tickIntervalMs: 2 * 60_000` (2 min, ADR-0014's tick/decision split; it was 15 min under [ADR-0008](../adr/0008-llm-spend-cap.md) when this note was written). Per-asset-class cadence gating is [#397](https://github.com/dd-jp/samurai-trading-system/issues/397), unbuilt. The 5s/30s figures are Market Intelligence **latency budgets**, a different quantity. The argument stands on the brokers alone. **Moot as of #1178: with crypto out of scope there is only one asset class left, so there is nothing left to be independent of.**)*
- **Mechanism, two-phase:**
  1. **Offline replay** — replay captured real orders from the shared-store audit log (`Fill`/`ClosedTrade` rows) against the candidate adapter's sandbox first, as a cheap first pass.
  2. **Live dual-submit** — dual-submit real-time orders to both the incumbent adapter (live) and the candidate adapter's paper/sandbox endpoint, logging fill-price and latency divergence. The candidate's response is measured only — never acted on or fed back into the strategy.
- **Cutover gate: metrics-informed, manual sign-off — not automatic.** Divergence metrics unlock a manual decision to cut over rather than triggering it automatically. Exact tolerance thresholds (fill-price bps, latency p99) are unpinned config, tuned once real shadow-run data exists. *(The original rationale — "mirroring the human-in-the-loop posture of the paper→live rule" — no longer holds: [ADR-0007](../adr/0007-fully-automatic-execution.md) removed the human from the trade path in paper and live. This decision survives it unchanged, because a broker swap is an infrequent operator action outside the tick loop, not a per-trade gate inside it — which is the specific thing ADR-0007 rejected. It rests on [[live-money-graduation]] now, not on Verdict's dial.)*

### Research Alignment (docs 00/01/02)

- One code path live/paper/backtest with a deterministic Simulated adapter over the injected cost model = the honest measurement harness (Stage 1) and paper-vs-live cost comparison (Stage 3). Persisting requested vs filled size + fees keeps realized-cost accounting truthful, so expectancy/PBO downstream are computed on reality.

### Future Extensions

- Blended-average position accounting for scale-ins (v2).
- Smart order routing / execution algos (TWAP/VWAP, iceberg) beyond simple bracket placement.
- Multi-venue / best-execution routing once more than one crypto venue is live.
- Live push (WebSocket) fill ingestion optimisation over polling.

## Resolved Decisions (Sources)

Wayfinder decisions live in [docs/wayfinder/execution-map.md](../wayfinder/execution-map.md) (charted locally). Decisions synthesized here:

- **Role & surfaces** — thin actor, gate-vs-actor split; `execute()` primary seam + `ingestFills()/reconcile()` secondary surface for the async bracket lifecycle.
- **Broker abstraction** — `BrokerAdapter` over a normalized bracket; Alpaca (paper), Saxo (designated live equities, ADR-0015, built but not yet wired at the composition root), Simulated; atomic OCO bracket guaranteed at the boundary — native on Alpaca; native on Saxo for the explicit-cancel path, unverified for the master-expiry path (#1215).
- **Idempotency & crash-restart** — two-layer dedup on `hash(instrument + bar/timestamp)`; write-ahead + broker-source-of-truth reconciliation.
- **State machine & partial fills** — explicit persisted states; protective legs sized to filled qty; requested AND filled persisted.
- **Resilience** — retry classifier + backoff; token-bucket throttle; broker rate-limit ≠ LLM hard stop.
- **Trade records** — `OpenPosition` / `Fill` / `ClosedTrade`; Execution sole writer.
- **Scale-in** — per-lot (v1).
- **Determinism** — one code path; deterministic Simulated adapter over injected clock + cost model.

**Cross-spec additions (for the all-specs verification pass):**
1. **`ClosedTrade` is defined here** (feedback-loop-spec references but never defines it) — FL must adopt `entry`, `stop`, `filled_size`, `realized_pnl_net`, `debate_id`, `idempotency_key`, `asset_class`, `side`, `opened_at`, `closed_at`.
2. **Trade record persists the entry bracket + `debate_id`** (already required by FL/Trader) — Execution is the writer that fulfils it; `debate_id` flows Trader → `OrderIntent.metadata` → Verdict → Execution → records.
3. **Downstream reads `filled_size`/`avg_entry_price`, never requested size**, for partially-filled positions (Risk exposure, FL R).
4. **Broker is source-of-truth for the position store** — Execution owns the reconciliation routine.

**Dependencies:** the shared SQLite store (also read by Trader/Risk/FL); the transaction-cost/market-impact model (uncharted — consumed by the Simulated adapter); the Market Data Service (injected as `marketData: MarketDataService` — consumed by the Simulated adapter to assemble `MarketState` for `CostModel.fill`, same injection pattern as Trader/Risk/Verdict); the broker credentials/config (ops: trade-only, withdrawals disabled, IP-whitelisted per CONTEXT.md invariant 3).
