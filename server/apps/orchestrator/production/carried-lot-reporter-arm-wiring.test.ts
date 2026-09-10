/**
 * The wiring proof for #1501 — the composition root binds the CORRECT arm
 * literal, and the correct store, to each of the two carried-lot reporters.
 *
 * `carried-lot-alert.test.ts` proves `buildCarriedLotReporter` copies
 * `deps.arm` onto the alert and the durable log line once handed one; it
 * cannot prove the property this file exists for, because it builds the
 * reporter itself and never touches `production.ts`'s two call sites. Those
 * two sites (control arm first, live arm second — #1321's documented
 * ordering) are near-identical copy-paste: `arm: 'control'` bound to
 * `controlArmWiring.store` a few lines above `arm: 'live'` bound to
 * `executionStore`. Swap either literal, or bind it to the other arm's
 * store, and every existing test still passes — `carried-lot-alert.test.ts`
 * never sees `production.ts`, and nothing else in this codebase calls
 * `reportCarriedLots` at all.
 *
 * `residual-and-overfill-arm-wiring.test.ts`'s `startFillSync` spy,
 * verbatim technique: capture the two `FillSyncDeps` objects the two
 * `startFillSync` calls receive, then invoke a captured closure directly
 * rather than waiting on the poll's own timer. What is under test is which
 * STORE and which ARM LITERAL each `reportCarriedLots` closure closed over,
 * and calling it directly on the object `production.ts` actually built is
 * still the root — only the timer-driven call is skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { LseRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import { PolymarketClient } from '../../../providers/market-intelligence/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const { startFillSyncSpy } = vi.hoisted(() => ({ startFillSyncSpy: vi.fn() }));

vi.mock('../fill-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fill-sync.js')>();
  startFillSyncSpy.mockImplementation(actual.startFillSync);
  return { ...actual, startFillSync: startFillSyncSpy };
});

/** A Wednesday inside British Summer Time, past LSE close (16:30) and past `DEFAULT_TRADER_CONFIG`'s 5-minute grace. */
const NOW = new Date('2026-08-19T16:40:00+01:00');
const OPENED_AT = new Date('2026-08-19T14:00:00+01:00');

/** `flatten-reconcile-arm-wiring.test.ts`'s broker, verbatim reasoning: this proof never enters a lot or flattens one. */
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
 * A lot carried past the missed close, written directly into one arm's
 * store. Different instrument per arm, the same technique
 * `flatten-guard-arm-wiring.test.ts` uses for `getUnresolvedFlattens`: a
 * store bound to the wrong arm then reports the WRONG instrument (or none),
 * rather than merely a same-shaped one.
 */
async function seedCarriedLot(
  store: ExecutionSharedStore,
  instrument: string,
  key: string,
): Promise<void> {
  const position: OpenPosition = {
    idempotency_key: key,
    debate_id: 'debate-1',
    instrument,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 10,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: [`${key}:entry`],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
  };
  await store.writeAheadPosition(position);
}

/** `flatten-reconcile-arm-wiring.test.ts`'s `StubConfig`, verbatim reasoning. */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, logger: Logger): StubConfig {
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
    verdictConfig: makeWiringVerdictConfig(),
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
    // Pinned so `equityCalendarFor(config)` resolves to a calendar with a
    // real close — `findCarriedLots` reports nothing against a calendar that
    // never closes (`AlwaysOpenCalendar`'s `sessionEnd` is null).
    tradingCalendar: new LseRegularHoursCalendar(),
    polymarketClient: new PolymarketClient({
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
      fetchImpl: (async () => {
        throw new Error('offline: this wiring proof must not reach Polymarket');
      }) as unknown as typeof fetch,
    }),
    polymarketPollIntervalMs: 20 * 24 * 60 * 60 * 1_000,
  } as StubConfig;
}

describe("each arm's carried-lot reporter watches its own book, under its own name (#1501)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    startFillSyncSpy.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS: swap the two `arm:` literals, or the two
   * `getOpenPositions`/`getExitFillSizes` bindings, between the control-arm
   * and live-arm `buildCarriedLotReporter(...)` calls in `production.ts`.
   * `carried-lot-alert.test.ts` cannot see this — it never calls
   * `buildProductionOrchestrator`, and `tsc` cannot catch it either: both
   * literals typecheck as `TradingArm` and both stores typecheck as the
   * store the parameter wants.
   */
  it("binds each reporter's `arm` literal to the store it actually reads", async () => {
    await seedCarriedLot(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'AAPL',
      'live-lot',
    );
    await seedCarriedLot(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'TSLA',
      'control-lot',
    );

    const logger = recordingLogger();
    const orchestrator = buildProductionOrchestrator({
      ...stubConfig(db, logger),
      broker: new AmnesiacFlattenBroker(),
    });
    await orchestrator.start();

    expect(startFillSyncSpy).toHaveBeenCalledTimes(2);
    // #1321's documented ordering: control arm's `startFillSync` call first.
    const controlReport = startFillSyncSpy.mock.calls[0]?.[0]
      .reportCarriedLots as () => Promise<void>;
    const liveReport = startFillSyncSpy.mock.calls[1]?.[0].reportCarriedLots as () => Promise<void>;

    logger.entries.length = 0;
    await controlReport();
    await liveReport();
    await orchestrator.stop();

    const lines = logger.entries.filter(
      (entry) => entry.event === 'lot_carried_past_session_close',
    );
    expect(
      lines.map((entry) => (entry.payload as { instrument?: string; arm?: string }).instrument),
    ).toEqual(['TSLA', 'AAPL']);
    expect(
      lines.map((entry) => (entry.payload as { instrument?: string; arm?: string }).arm),
    ).toEqual(['control', 'live']);
  });
});
