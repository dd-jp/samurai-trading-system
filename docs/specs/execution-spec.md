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
- **Double idempotency** — local store dedup + broker client-order-id, keyed on ~~`hash(instrument + bar/timestamp)`~~ **sha256 over `{ instrument, bar, side }`, plus `arm` when the arm is not `'live'`** *(Amended 2026-09-10, [#1171](https://github.com/dd-jp/samurai-trading-system/issues/1171) — see `docs/specs/trader-spec.md`'s "The idempotency key, and why the arm is in the hash", the authority; `server/pipeline/trader/idempotency-key.ts` is the implementation)* *(Amended again 2026-09-10, [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) — **the mandatory flatten uses a second rule and no bar**: sha256 over `{ instrument, session_close, side: 'close' }`, plus `arm` when not `'live'`. Both dedup layers still see one key per obligation, which is the point: the flatten window now reaches past the close, and the bar coordinate would have handed the same close two keys and let `executeExit` sell a still-unswept lot into a short. The two key spaces cannot collide, since `session_close` and `bar` are different field names in the hashed JSON. `signal_decay` and `direction_flip` keep the bar coordinate)*.
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

8. As Execution, I want to dedup on the Trader-assigned `idempotency_key` ~~`= hash(instrument + bar/timestamp)`~~ **(= sha256 over `{ instrument, bar, side }`, plus `arm` when the arm is not `'live'` — amended 2026-09-10, [#1171](https://github.com/dd-jp/samurai-trading-system/issues/1171), see `trader-spec.md`'s "The idempotency key, and why the arm is in the hash")** against the shared store before submitting, so that a re-entry (crash-restart, retry) never opens a second order for the same instrument+bar(+side/+arm).
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
  | 'closed' | 'cancelled' | 'rejected' | 'expired' | 'abandoned';
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

**Amendment 2026-09-15 (#1411) — the flatten-adopt backstop exists; the noise it was to be traded against does not.** The sentence closing the #1122 amendment above is stale in both halves, and #1411 is closed won't-fix on the measurement rather than by building the detector it proposed. *There is a backstop*, built by #1214/#1500 after #1122 was written: `getUnresolvedFlattens` (sqlite-shared-store.ts) is bounded by nothing but resolution — `status = 'submitting' OR (status = 'submitted' AND fills_swept_at IS NULL)` — so an unresolved row is re-read by `reconcileFlatten` on every fill-sync poll forever, across restarts, and the benign `adopted` answer is the ONLY one of that function's flatten branches that does not post a `FlattenReconcileAlert`. It is reachable only inside two bounded windows: a working order under `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` (5min, then `cancelWedgedFlatten` pages) and a terminal row with unswept fills under `UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS` (30min, then `judgeTerminalUnsweptFlatten` pages); a terminal row that filled nothing resolves as `rejected` on the spot, and fills that sweep retire the row. So a flatten-adopt that is genuinely wrong either stops being unresolved or escalates within 30 minutes — through an operator page, which is a *stronger* signal than `FilledZeroSizeThrottle`'s log-only warning, not a weaker one. #1411's proposed option 1 is also unbuildable in the shape it names: it asks for a detector polling store state, and a flatten writes no `OpenPosition` row to poll. *And the noise is not there to reduce*: measured over every log in `logs/` (5,823 structured lines, 2026-09-02 to 2026-09-15), `kind: 'flatten'`, `action: 'adopted'` divergences are **22 lines across 22 distinct flatten episodes — 0.38%, exactly one line per episode, zero repeats**, the per-episode dedup in `runPoll` (`lastReconcileAction`, #921) already having collapsed the poll's re-reads. The bracket case #1122 demoted measured 618/2102 = 29.4% (`filled-zero-size-throttle.ts`). Demoting to `debug` would trade the sole surviving record that a flatten was reconciled at all against roughly one line per flatten, so the level stays `info`.

**Amendment 2026-09-09 (#1186) — the `FilledZeroSizeThrottle` backstop above watches; nothing retired.** The amendment just above names `FilledZeroSizeThrottle` as the visibility backstop for a lot adopted `filled`/`partially_filled` whose `filled_size` never moves off zero, but visibility was the whole mechanism — the lot itself stayed open forever, in flight to no one (not `pending`/`submitted`, so the bracket pass never revisits it) and not covered by the residual-protection sweep (#549, keyed on a flatten-redistribution column this lot's history never touches) or the terminal-row sweep (#1088, which only sweeps rows already terminal). `wedged-zero-fill-sweep.ts` closes that gap: `reconcile()` now also retires a `filled`/`partially_filled`, `filled_size === 0` lot to the new `'abandoned'` terminal state (added to `OrderState` above) once it has been open past a 24h bounded window, store-evidence-only — decided entirely from `open_positions`, never a broker call. This is a bookkeeping close of the store's own record, not a claim that the venue holds no position: `order_state` is `filled`/`partially_filled` because the venue reported it, and `filled_size = 0` means only that this store's `Fill` rows disagree with that report (a real fill can go permanently unrecorded — #1096's now-fixed since-floor bug, #1302's still-live unresolved-price-unit refusal). `findUnrecordedVenuePositions`, run immediately after this sweep on every pass, is the mechanism that actually reconciles the venue's book against the store's, and is the backstop that would surface a real position in that instrument on the very next pass. `open_positions.abandon_reason` (migration 0056) records why. Auto-retire rather than an operator alert: the action itself has no live-money consequence to get wrong (it only ever rewrites `open_positions`, never touches the venue, and the venue-exposure question is already `findUnrecordedVenuePositions`'s job independent of this sweep) and the persisted reason column is a more durable record than a transient alert would be. `'abandoned'` is deliberately excluded from what the terminal-row sweep (#1088) deletes — an abandoned row's `decision_timestamp` is already past that sweep's own age cutoff (the same 24h window) the moment it is written, so leaving it sweepable would hard-delete `abandon_reason` on the very next reconcile pass instead of keeping it as the durable record this amendment exists to produce.

### Module: Order State Machine & Partial Fills

- States as `OrderState` above; every transition persisted (durable, inspectable).
- **Partial fills:** entry lingers in `partially_filled`; the armed stop/target legs are (re)sized to cumulative *filled* quantity. Persist `requested_size` AND `filled_size` + `avg_fill_price` + `fees`. R and exposure downstream read the filled fields.
- **Round-trip to flat** (protective leg fully fills, or an `exit` fully fills) → state `closed` → emit `ClosedTrade`.
- **"Fully" is float-tolerant, by a relative epsilon (1e-12 of the lot).** Both sides of the comparison are float64 sums of decimal fill quantities, and two sums of the same true total differ unless the tranches share a summation order (0.3+0.3+0.4 is exactly 1; 0.7+0.2+0.1 is 0.9999999999999999). An exact `>=` therefore leaves a fully-exited lot open forever — no `ClosedTrade`, and a phantom position holding Risk's exposure caps. The epsilon is orders below any venue's lot granularity, so it absorbs float noise only. See [ADR-0005](../adr/0005-money-math-precision.md).

**Amendment 2026-09-10 (#1214) — a partial-flatten residual is CLOSED, not re-armed, on a venue that cannot arm entry-less legs.** The partial-fill line above ("the armed stop/target legs are (re)sized to cumulative filled quantity") assumes every venue can express a protective pair with no entry attached. Saxo cannot — every LSE pool line reports `IsOcoOrderSupported: false` (doc 43) — so `SaxoBrokerAdapter.rearmProtectiveLegs` refuses with a typed `ProtectiveRearmUnsupportedError`, and both consumers of that seam (`maybeRearmResidual`, residual-protection.ts; `sweepOne`, residual-protection-sweep.ts) used to log, page and retry a call that can never succeed. David's 2026-09-08 decision on #1214 (option 2) replaces the re-arm on that refusal with a re-flatten: the lot is one the system has already decided to close (both call sites are gated on an ingested exit or a flatten naming the lot, and `executeExit` cancels the protective legs BEFORE it flattens), so finishing the exit is the action that matches the intent. `residual-reflatten.ts` owns it, under four constraints that are part of the decision: BOUNDED (`MAX_RESIDUAL_REFLATTEN_ATTEMPTS`, walked over durable `<lot key>:residual-reflatten-N` journal keys so a restart cannot reset the count — an unbounded re-flatten is a market-order loop); SESSION-GATED (`ExecutionInput.sessionCalendars`, the same pair the flatten window resolves against, so no market order is fired into a shut venue); NON-COLLIDING with the daily flat-by-close cadence; and NEVER-THROWING, `maybeRearmResidual`'s existing contract. `BrokerAdapter.rearmProtectiveLegs` is unchanged for adapters that support it.

The non-collision constraint is enforced at the STORE, not by either caller's own read of `getUnresolvedFlattens()` (the 2026-09-09 review of PR #1494 found that read was one-directional — `executeExit` sizes from `getOpenPositions()` minus `getExitFillSizes`, neither of which moves for a submitted-but-unfilled flatten, so it could not see a re-flatten already working the lot). `SqliteExecutionStore.writeAheadFlatten` refuses — in the same synchronous better-sqlite3 transaction as its INSERT, so the check-and-insert window is unreachable rather than merely narrow — any flatten whose arm and instrument already carry an unresolved row, throwing `UnresolvedFlattenForInstrumentError`. `executeExit` returns `deduped` over it (placed above its cancel loop, so a refusal destroys no protective legs), `reflattenResidual` a stand-down. Both callers' pre-reads are advisory: they buy a named skip and a log line, not the guarantee. Two consequences: #867's full-held-quantity marks ARE re-flattened (an absent exit fill records nothing about which path owns the lot, and `resolveExitRetryKey`'s chain hangs off the ORDER's per-bar key, not the lot's), and mandatory flat-by-close on an instrument DEFERS while any flatten on it is unresolved, including a sibling lot's.

An unresolved row must therefore always resolve, and there are now three ways it does. `fills_swept_at` (`ingestFills()`) retires a flatten that produced fills. `reconcileFlatten` settles one to `'error'` when the venue reports a `TERMINAL_ORDER_STATES` state having filled nothing — without it a rejected re-flatten would name its instrument forever, wedging both key walks and the daily flatten. The `filled_qty === 0` half is load-bearing: a partially-filled-then-cancelled flatten still has fills owing, which `resumeFlatten`'s worklist side effect recovers.

**The third way in is round 2's, and it is the only one that is not proof.** The 2026-09-10 second review of PR #1494 found a row shape neither of the above reaches: an ACKED (`'submitted'`) flatten that `resumeFlatten` answers `null` for. That answer is not evidence the write-ahead never landed (it provably did), so the branch recorded it and left the journal alone — forever, across restarts and trading days, with no operator path short of editing SQLite by hand. `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` (`reconcile.ts`, 5 min = `DEFAULT_TRADER_CONFIG.flatten_before_close_ms`) bounds it. **The bound is on the row's AGE alone (`now - row.submitted_at`) — nothing counts observations** — so the row is forced to `'error'` on the FIRST `resumeFlatten` null that lands once the age is past: one unanswered check against an old row, not a measured run of denials, and a row left unpolled for the whole bound is forced on its very first answer. The reason string, the alert and the constant's docblock all say that and no more; claiming the venue "denied it on every pass" would describe observations that were never made. The value is derived so that a row already blocking when the flatten window opens is terminal by the bell, leaving the whole post-bell grace to submit the replacement, and `reconcile()` runs on every fill-sync poll with no calendar gate. Two consequences are deliberate and argued at the constant: a fill arriving after the forcing still attributes correctly (`getFlattenAttribution` does not filter on status), and forcing the row terminal RE-ARMS both key walks (`resolveReflattenKey`, `resolveExitRetryKey`) — a second market order can go out on a held quantity whose first flatten may still be live, which is #516's hazard accepted knowingly against an instrument that could otherwise never be flattened again. The row shape where the adapter *throws* is deliberately NOT age-bounded: ignorance is not evidence, and an adapter that cannot ask the venue cannot submit a replacement either.

**What that re-arm risks, stated at its worst rather than as "a bad fill."** If the original flatten actually FILLED at the venue and was simply never confirmed (the adapter answered `null` past the age bound), and the re-armed second flatten then fills too, the first fill attributes correctly and closes the lot in the store; the second fill's `redistributeOneFlatten` then resolves to a lot key `getOpenPositions()` no longer returns, so `ingestFills`'s per-position loop never reads it, the quantity is **silently dropped**, and `markFlattenFillsSwept` retires the row anyway. End state: the store shows flat while the venue holds a **reverse** position (short, where the close was a sell), with no `ClosedTrade` and no exit fill recorded, surfaced only by `findUnrecordedVenuePositions` at `reconcileDivergenceLevel: 'info'` — not a warning, not a page. That silent-drop gap is pre-existing (#429/#1122) and is **not fixed by #1214**; what the age bound adds is reachability. It was tracked as [#1506](https://github.com/dd-jp/samurai-trading-system/issues/1506), and the amendment below is what closed it.

**Amendment 2026-09-14 (#1506) — the second fill is booked, and the reverse-position shape warns.** Two changes, one per half of the paragraph above.

The drop: `redistributeOneFlatten` now compares each split's lot key against the poll's own `positions` snapshot, and for a key absent from it books the split directly through `applyLotAdvance` (fills only — no `position_update`, no `closed_trade`) and posts `UnattributedFlattenFillAlertChannel` beside an `error` line. Absence from the snapshot is proof the lot is TERMINAL, not that it has yet to open: `lot_idempotency_keys` is fixed at the flatten's own write-ahead, which necessarily predates any later lot, so no future snapshot will name it and the "the feed re-offers it next poll" argument the neighbouring early return rests on does not carry here. `hasFill` on the split's own derived id is the dedup, and it is load-bearing rather than defensive — the condition recurs on EVERY poll after any ordinary flatten (`fetchNewFills` is inclusive of `since`, `getFlattenAttribution` does not filter on `swept_at`), so the persisted row is what makes this fire once per fill instead of once per poll. Failure to persist does not throw — the splits are already in `byLot` and `byLot.delete` must still run — but it is not swallowed either: it is recorded as a `'lot-advance'` `ContainedFailure` under the lot's own key, which holds the `markFlattenFillsSwept` gate. That gate is the only recovery there is, because "the next poll recomputes the split" does not hold here: `since` is the earliest `opened_at` over the OPEN lots, and once no surviving open lot predates the flatten fill the adapter's `filledAt < since` drops it with no recovery path, so a retired journal row would lose the fill permanently. The split is also subject to #842's `timestamp <= now` no-lookahead filter, exactly as `advanceLot`'s own booking is.

**Two limits, stated rather than implied.** The lot's `ClosedTrade` was written when it went flat and `applyLotAdvance` refuses a second one, so realized PnL for that lot stays SHORT of this sale — no correction is available through this port, which is why the channel pages rather than merely recording. And `getExitFillSizes` for that key now exceeds `filled_size`, making derived held quantity negative; every live caller (`execute.ts`'s held-lot sizing, `carried-lot-alert.ts`, the Trader's own reader) gates on `getOpenPositions()` first, so no consumer reaches a terminal key — but a future one that does must not read the difference as available quantity.

**The last-open-lot case is NOT covered by that fix**, and this is the seam between the two halves. `ingestFills` returns at its own `positions.length === 0` guard before redistribution runs, so when the closed lot was the last open lot the split is never computed at all. There, `findUnrecordedVenuePositions` is the only surface — which is the second change: `reconcileDivergenceLevel` (fill-sync.ts) now returns `warn` for `action: 'unrecorded'` alongside `undetermined`, instead of `info`. Its docblock had grouped `unrecorded` with `rejected` as "carries no backstop either"; having no backstop detector is the argument for raising the level, not for leaving it quiet, and a `rejected` divergence describes an order the venue refused — no position exists, so nothing is exposed. Two honest limits on that half too: `warn` is a LOG level and nothing escalates off it (an `AlertChannelSlots` channel raised by `findUnrecordedVenuePositions` itself is follow-up work, not done here), and `runPoll`'s per-episode dedup keys unrecorded rows on `instrument`, so the line fires once per episode and stays quiet while the exposure persists.

**Both remainders above are unowned, and belong on [#1413](https://github.com/dd-jp/samurai-trading-system/issues/1413)'s live-ramp checklist** — the last-open-lot shape (nothing computes the split at all) and `warn` escalating to nothing. Neither is fixed here, and the execution layer has no other surface for either.

The #525 page is not weakened. Only a live closing order on the lot suppresses it — a fresh submit, or one of this lot's own `:residual-reflatten-N` keys still working; someone ELSE's flatten, every failure and every exhausted budget still reach `ResidualExposureAlertChannel`. Suppression is bounded by the venue: flattens go out `DurationType: 'DayOrder'`, so one that never fills expires at session close, which is a `TERMINAL_ORDER_STATES` state with `filled_qty === 0`, which resolves the row on the next fill-sync poll (≤15s, no calendar gate) and lets the walk advance to `attempts_exhausted` — and that pages. Round 2 closes the one hole in that argument: it holds only while the venue keeps ANSWERING about the order, and a venue that answers `null` instead never reports the expiry. `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` bounds that case too, so the suppression is bounded on both branches rather than on the well-behaved one alone.

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

- No implementation yet. Injected-clock / injected-dependency patterns mirror Verdict (injected `ApprovalChannel`), Risk, and the Trader. Deterministic-output assertions (no LLM mock) mirror Trader/Risk/Verdict. The Simulated `BrokerAdapter` is the execution analogue of Verdict's no-op `ApprovalChannel` and Risk's mocked `PortfolioView`.

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
- **Idempotent Order**: "submitted multiple times … results in exactly one fill." — two-layer dedup on ~~`hash(instrument + bar/timestamp)`~~ **sha256 over `{ instrument, bar, side }`, plus `arm` when the arm is not `'live'`** *(amended 2026-09-10, [#1171](https://github.com/dd-jp/samurai-trading-system/issues/1171) — see `trader-spec.md`'s "The idempotency key, and why the arm is in the hash")*.
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
- **Idempotency & crash-restart** — two-layer dedup on ~~`hash(instrument + bar/timestamp)`~~ **sha256 over `{ instrument, bar, side }`, plus `arm` when the arm is not `'live'`** *(amended 2026-09-10, [#1171](https://github.com/dd-jp/samurai-trading-system/issues/1171) — see `trader-spec.md`'s "The idempotency key, and why the arm is in the hash")*; write-ahead + broker-source-of-truth reconciliation.
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
