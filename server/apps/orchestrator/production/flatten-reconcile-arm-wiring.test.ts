/**
 * The wiring proof for #1331 — an unresolved flatten's alert line names the
 * arm that raised it.
 *
 * `console-channels.test.ts` proves the channel writes whatever `trace_id`
 * the alert carries, and `reconcile.test.ts` proves the alert fires on both
 * unresolved branches. Neither can prove the property this file exists for:
 * that the ids the ROOT picks for its two arms' reconcile passes are
 * different, and that both passes reach that one shared channel instance
 * carrying them. `buildControlArmWiring` builds the control
 * arm's `executionDeps` by spreading the live arm's and overriding seven
 * fields; `flattenReconcileAlerts` is not one of them, and it is not going to
 * be — the channel is `SAMURAI_ALERTS`-selected at the root, so both arms
 * share the instance by design. The surface's own `trace_id` is therefore the
 * only thing in the line that separates a control-arm flatten (a simulated
 * broker's ambiguity, worth nothing operationally) from a live one (real
 * money at a real venue).
 *
 * Driven through `buildProductionOrchestrator(...).start()`, not through a
 * surface this file builds, and not through `buildProductionComponents`
 * either. `filled-zero-size-wiring.test.ts`'s reason applies and then some: a
 * test that calls `buildExecutionSurface(deps, RECONCILE_TRACE_ID)` itself is
 * asserting an id it supplied, so it is blind to the root choosing a
 * different one — which is exactly what the first round of #1331 shipped.
 * `start()` is also the only caller of the live arm's startup reconcile, and
 * the startup reconcile is the pass whose alert an operator reads after a
 * crash, so nothing short of booting it pins what that line actually says.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import { SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { PolymarketClient } from '../../../providers/market-intelligence/index.js';
import type { Logger } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type SharedStore } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-07-20T16:00:00Z');

/**
 * A venue that answers "no such order" to every flatten lookup. Paired with a
 * journal row already at `'submitted'` (acked once, `broker_order_ids` on
 * record) this is reconcile's genuine-ignorance branch: the row is left
 * untouched and the operator is alerted. Every other method throws, so an
 * unexpected call fails loudly rather than returning a silently-wrong stub —
 * `WedgingBroker`'s posture (filled-zero-size-wiring.test.ts).
 */
class AmnesiacFlattenBroker implements BrokerAdapter {
  async submitBracket(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async fetchNewFills(): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.resizeProtectiveLegs: no fill is ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.rearmProtectiveLegs: no partial flatten here');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    return null;
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

/**
 * A flatten the venue acked once and now denies — `reconcile()`'s
 * "previously acked" branch, which alerts and leaves the journal alone.
 * `resolveFlattenSubmitted` is what `executeExit` itself writes on a clean
 * ack, so this is the row shape a real crash leaves behind.
 */
async function seedAckedThenDeniedFlatten(store: ExecutionSharedStore, key: string): Promise<void> {
  await store.writeAheadFlatten({
    idempotency_key: key,
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'sell',
    size: 10,
    submitted_at: NOW,
    lot_held_quantities: [{ idempotency_key: `${key}-entry`, held: 10 }],
    exit_reason: 'flatten',
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
  });
  await store.resolveFlattenSubmitted(
    key,
    { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
    NOW,
  );
}

/** `filled-zero-size-wiring.test.ts`'s `StubConfig`, verbatim reasoning. */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

/**
 * `filled-zero-size-wiring.test.ts`'s stub config for the fields it also sets,
 * plus three this file needs because it boots the orchestrator rather than
 * driving one surface: `tradingCalendar`, `polymarketClient` and
 * `polymarketPollIntervalMs` (each commented at its site).
 */
function stubConfig(db: SharedStore, logger: Logger): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
    llmClient: {
      complete: async () => {
        throw new Error('unreachable: this wiring test never runs a debate');
      },
    } as unknown as LlmClient,
    alpacaBrokerClient: {
      submitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitLimitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitStopLimitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      cancelOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      getOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      listOrders: async () => [],
      listFills: async () => [],
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: async () => [],
      getLatestQuote: async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 }),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    } as unknown as ProductionConfig['accountState'],
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: makeWiringRiskConfig(),
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
    } as ProductionConfig['verdictConfig'],
    executionConfig: makeWiringExecutionConfig(),
    correlationConfig: makeWiringCorrelationConfig(),
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.3,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: makeWiringCostConfig(),
    ciiConsumerConfig: makeWiringCiiConsumerConfig(),
    // Always open, so `start()` reaches its startup reconcile the same way a
    // boot inside the session does.
    tradingCalendar: new AlwaysOpenCalendar(),
    // `production.test.ts`'s `offlinePolymarketClient`, for its reason: the
    // root builds the Polymarket agent unconditionally (its read APIs are
    // keyless) and `start()` fires `void refresh('startup')` at once, whose
    // rejection is swallowed into a `warn`. Without this the boot reaches
    // `gamma-api.polymarket.com` from a unit suite. The poll interval is
    // pushed past this test's life so the timer never fires a second one.
    polymarketClient: new PolymarketClient({
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
      fetchImpl: (async () => {
        throw new Error('offline: this wiring proof must not reach Polymarket');
      }) as unknown as typeof fetch,
    }),
    polymarketPollIntervalMs: 20 * 24 * 60 * 60 * 1_000,
  } as StubConfig;
}

describe("an unresolved flatten's alert names the arm that raised it (#1331)", () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATIONS THIS KILLS:
   *
   * 1. Put the constant back — `trace_id: 'reconcile'` in
   *    `LoggingFlattenReconcileAlertChannel` (console-channels.ts), or thread
   *    a fixed string instead of `input.trace_id` in
   *    `postFlattenReconcileAlert` (reconcile.ts). Either leaves both arms'
   *    lines identical here, and the second leaves `console-channels.test.ts`
   *    green as well.
   * 2. Mislabel the LIVE arm at the composition root — give the surface
   *    `start()` reconciles on `CONTROL_RECONCILE_TRACE_ID`, or let `start()`
   *    build a fresh surface under some other id. Before #1331's review round
   *    that mutation left the whole 5762-test suite green: a real venue's
   *    unresolved flatten reading `control-arm-reconcile`, which is precisely
   *    the misreading this ticket exists to prevent.
   *
   * Mutation 2 is why this boots the orchestrator instead of calling
   * `reconcile()` on a surface built here or read off `ProductionComponents`.
   * Either shortcut asserts against an object this file chose; only `start()`
   * exercises the id the live arm's startup reconcile really runs under.
   *
   * The literals are asserted directly, NOT via `RECONCILE_TRACE_ID` /
   * `CONTROL_RECONCILE_TRACE_ID`: asserting the constants against themselves
   * would stay green under a mutation of either constant's value while the
   * log line moved. Neither is imported here — the two observed lines are the
   * whole proof.
   */
  it("start() logs each arm's unresolved flatten under its own trace id", async () => {
    const logger = recordingLogger();

    // Seeded before the boot: the startup reconcile runs inside `start()`,
    // before the tick loop, so a row written afterwards would never be swept.
    // Each arm gets its own row — same handle, different `arm` column, which
    // is what `getUnresolvedFlattens()` filters on (migration 0050, #1124).
    // A row seeded on the live arm alone would never reach the control arm's
    // sweep at all, and the two arms' lines are the whole point here.
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live',
    );
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control',
    );

    const orchestrator = buildProductionOrchestrator({
      ...stubConfig(db, logger),
      broker: new AmnesiacFlattenBroker(),
    });
    await orchestrator.start();
    await orchestrator.stop();

    const alerts = logger.entries.filter((entry) => entry.event === 'flatten_reconcile_unresolved');
    expect(alerts).toHaveLength(2);
    expect(
      alerts.map((entry) => ({
        trace_id: entry.trace_id,
        idempotency_key: (entry.payload as { idempotency_key?: string } | undefined)
          ?.idempotency_key,
      })),
    ).toEqual([
      { trace_id: 'reconcile', idempotency_key: 'flatten-live' },
      { trace_id: 'control-arm-reconcile', idempotency_key: 'flatten-control' },
    ]);
  });
});
