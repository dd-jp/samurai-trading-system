/**
 * Domain types & contracts for Execution — see docs/specs/execution-spec.md
 * ("Key Interfaces", "Module: Broker Abstraction") and
 * docs/specs/cross-spec-contracts.md §4/§5.
 *
 * Implementation ticket #82 — `execute()` on the entry/scale_in bracket path
 * plus the Simulated adapter. The interfaces here are deliberately narrower
 * than the spec's full shapes, in the same staged style as `TraderInput`
 * (#73) and `CostModel` (#87): fill ingestion / reconciliation (#83, #86)
 * and the real Alpaca adapter (#84) add their surfaces additively rather than
 * being declared here unimplemented.
 *
 * #85 added the ccxt + IBKR adapters against these shapes without widening
 * them: each exposes its fill feed (`fetchNewFills`) and, for ccxt, its OCO
 * emulation (`syncBrackets`) as adapter-local methods, exactly as the
 * Simulated adapter does. `BrokerAdapter` stays the one method `execute()`
 * calls until the ticket that drives the rest of the lifecycle (#83) arrives.
 *
 * `OpenPosition` / `OrderState` are NOT redefined here — they are cross-spec
 * types owned by src/shared/types.ts (registry §4).
 */

import type { CostModel } from '../cost-model-backtest/types.js';
import type { BarWindow, IndicatorSpec, MarketDataService } from '../market-data-service/types.js';
import type { Clock } from '../shared/clock.js';
import type { ClosedTrade, Fill, OpenPosition, OrderState } from '../shared/types.js';
import type { VerdictDecision } from '../verdict/types.js';

/**
 * The normalized abstract bracket Execution hands the adapter: entry +
 * attached stop + attached target, with one-cancels-other exit semantics
 * guaranteed at this boundary. How that guarantee is met is the adapter's
 * business and invisible above it — native bracket/OCA on Alpaca/IBKR (#84),
 * Execution-managed emulation on ccxt (#85), modelled deterministically by
 * the Simulated adapter.
 */
export interface NativeBracketRequest {
  /**
   * The broker-native idempotency handle: the venue itself rejects a
   * duplicate, which is the second of the two dedup layers (the local store
   * check in `execute()` is the first). Set to the OrderIntent's
   * `idempotency_key`.
   */
  client_order_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  size: number;
  /** Limit/entry price of the entry leg. */
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
}

/** The adapter's acknowledgement of an accepted bracket. */
export interface BrokerAck {
  client_order_id: string;
  /** Entry + attached legs (or the adapter's emulated ids). */
  broker_order_ids: string[];
  /** State as the venue reports it post-ack — normally 'submitted'. */
  order_state: OrderState;
}

/**
 * A fill normalized out of broker-native shape. #82 produces these in the
 * Simulated adapter but does not consume them: advancing the state machine
 * and persisting `Fill` rows is #83's `ingestFills()`.
 */
export interface NormalizedFill {
  client_order_id: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  /**
   * Populated only by the Simulated adapter, mapped from `CostModel.fill`'s
   * `CostModelResult` (cross-spec GAP-F). Real broker fills have no modeled
   * breakdown, so it is absent there.
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
}

/**
 * The broker boundary — nothing above it knows which venue, or whether the
 * mode is live, paper or backtest. #83 adds the two methods its lifecycle
 * calls; `submitFlatten`/`cancel`/`getOrder`/`getOpenPositions` still arrive
 * with the tickets that call them (#86 reconciliation, the exit path).
 */
export interface BrokerAdapter {
  submitBracket(order: NativeBracketRequest): Promise<BrokerAck>;
  /**
   * The venue's fill feed. Inclusive of `since` and never dated before it,
   * so a backtest cannot see a fill ahead of simulated T. Re-offering an
   * already-returned fill is expected — `ingestFills()` dedups on
   * `broker_fill_id`.
   */
  fetchNewFills(since: Date): Promise<NormalizedFill[]>;
  /**
   * Size the protective legs to the entry's CUMULATIVE filled quantity — an
   * over-sized stop protects phantom quantity, an under-sized one leaves part
   * of the lot naked (execution-spec.md story 13).
   *
   * On this seam because `OpenPosition` carries no leg-quantity field:
   * resizing is a venue-side act, not a persistence one. Adapters whose venue
   * keeps attached legs in step with the entry itself (Alpaca/IBKR native
   * brackets) satisfy it by doing nothing.
   */
  resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void>;
}

/**
 * Execution's writer seam over the shared store, of which it is the sole
 * writer (cross-spec §4).
 *
 * `findByKey` is intentionally identical to the read-only `PositionStore`
 * that Verdict (#79) declared for its dedup gate, so one concrete store
 * satisfies both seams. Verdict's file is left alone: it consumes this store
 * read-only and has no reason to depend on the writer surface.
 */
export interface SharedStore {
  /** True if an order or fill already exists under this idempotency key. */
  findByKey(idempotency_key: string): Promise<boolean>;
  /**
   * Write-ahead: persist the intended lot at `pending` BEFORE the broker
   * call, so a crash between decision and broker-ack is recoverable (#86
   * reconciles those orphans against the broker).
   */
  writeAheadPosition(position: OpenPosition): Promise<void>;
  /** Persist the post-ack transition (`pending` → `submitted`). */
  updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
  /**
   * Lots whose lifecycle is still running — what `ingestFills()` advances.
   * Terminal records (`closed`/`cancelled`/`rejected`/`expired`) are excluded:
   * a fill against a closed lot is not ours to act on, and this is what makes
   * a re-poll after close a no-op.
   */
  getOpenPositions(): Promise<OpenPosition[]>;
  /**
   * True if this `broker_fill_id` was already ingested. The fill feed is
   * inclusive of `since`, so every poll re-offers the fills it already
   * delivered; without this the same fill is counted twice and the lot's
   * `filled_size` runs away from the broker's.
   */
  hasFill(broker_fill_id: string): Promise<boolean>;
  /** One row per (partial) fill — CONTEXT.md invariant #4. */
  writeFill(fill: Fill): Promise<void>;
  /**
   * Every `Fill` recorded against a lot, in ingestion order. Realized size,
   * avg price and PnL are reconstructed from these rather than a running
   * total, so a re-poll converges instead of drifting.
   */
  getFills(idempotency_key: string): Promise<Fill[]>;
  /** Persist a fill-driven advance of the lot (partial or complete). */
  updatePositionFill(
    idempotency_key: string,
    update: { filled_size: number; avg_entry_price: number; order_state: OrderState },
  ): Promise<void>;
  /** The realized record, written once on round-trip-to-flat. */
  writeClosedTrade(trade: ClosedTrade): Promise<void>;
}

/**
 * Cadence/retry/throttle knobs from the spec's full `ExecutionConfig` are
 * absent: they belong to polling, reconciliation and resilience, none of
 * which #82 performs. The Simulated adapter raises no transient errors, so
 * there is no backoff for `execute()` to read.
 */
export interface ExecutionConfig {
  /** Market context the Simulated adapter prices fills against. */
  simulated: SimulatedAdapterConfig;
}

/**
 * How the Simulated adapter sources the two `MarketState` fields that aren't
 * a plain mark lookup. Config, not constants — exact values are tuned in
 * paper trading (execution-spec.md "Out of Scope: Exact values").
 */
export interface SimulatedAdapterConfig {
  /** Indicator read for `MarketState.volatility` (e.g. ATR at the bar). */
  volatility_indicator: IndicatorSpec;
  /** Bars window aggregated into `MarketState.adv` (the liquidity proxy). */
  adv_window: BarWindow;
}

/** Injected dependencies (constructor / DI). */
export interface ExecutionInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  broker: BrokerAdapter;
  /** Execution is the sole writer of positions/fills/closed-trades. */
  store: SharedStore;
  /** Consumed by the Simulated adapter only — real adapters never call it. */
  costModel: CostModel;
  /** Consumed by the Simulated adapter to assemble `MarketState`. */
  marketData: MarketDataService;
  config: ExecutionConfig;
  mode: 'live' | 'paper' | 'backtest';
}

export interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  /** Entry + attached legs; null when nothing reached the broker. */
  broker_order_ids: string[] | null;
  /**
   * State of the lot after `execute()` returns — usually 'submitted'. Null
   * when this call wrote no record and so has no state to report: a dedup
   * (the prior call owns the lot), a refused exit, or a non-`go`. Reporting
   * a state here would be fabricating one.
   */
  order_state: OrderState | null;
  /** Rejection / error / dedup detail. */
  reason: string | null;
  timestamp: Date;
}

/**
 * The primary test seam. Deterministic given the injected adapter + clock +
 * store.
 *
 * `reconcile()` — the other half of the spec's secondary surface — is #86's
 * (store ↔ broker, broker as source of truth) and is not declared until it
 * exists. #83 is `ingestFills()` only: it advances lots from the venue's own
 * fill feed and never second-guesses the store against the broker.
 */
export interface Execution {
  /** Acts only on a `go`; records the submission, does not block until filled. */
  execute(verdict: VerdictDecision): Promise<ExecutionResult>;
  /**
   * Advance every live lot on the fills that have landed since it opened:
   * persist each new `Fill`, resize the protective legs to cumulative filled
   * quantity, and emit a `ClosedTrade` on round-trip-to-flat. Idempotent —
   * polling it twice ingests each fill once and closes each lot once.
   */
  ingestFills(): Promise<void>;
}
