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
import { ProtectiveRearmUnsupportedError } from '../../../pipeline/execution/protective-rearm-unsupported.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import { UsEquityRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import type { Fill, Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, toBrokerFillId } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { buildExecutionSurface } from './direct-bind.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
} from './wiring-config-fixtures.js';

const SHUT_INSTANT = new Date('2026-07-20T02:00:00Z');
const OPEN_INSTANT = new Date('2026-07-20T15:00:00Z');
const OPENED_AT = new Date('2026-07-17T14:00:00Z');
const LOT = 'key-1';

class SaxoShapedBroker implements BrokerAdapter {
  readonly flattenCalls: Array<{ clientOrderId: string; size: number }> = [];

  async submitBracket(): Promise<BrokerAck> {
    throw new Error('SaxoShapedBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async fetchNewFills(): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('SaxoShapedBroker.resizeProtectiveLegs: no new fill is ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new ProtectiveRearmUnsupportedError(
      'saxo',
      'IsOcoOrderSupported false on every pool line',
    );
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    return null;
  }
  async submitFlatten(
    _instrument: string,
    _side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.flattenCalls.push({ clientOrderId, size });
    return {
      client_order_id: clientOrderId,
      broker_order_ids: [clientOrderId],
      order_state: 'submitted',
    };
  }
  async cancel(): Promise<void> {
    throw new Error('SaxoShapedBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function seedMarkedResidual(store: ExecutionSharedStore): Promise<void> {
  const position: OpenPosition = {
    idempotency_key: LOT,
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    order_state: 'partially_filled',
    broker_order_ids: [`${LOT}:entry`],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
  };
  await store.writeAheadPosition(position);
  const entry: Fill = {
    idempotency_key: LOT,
    broker_fill_id: toBrokerFillId('e1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-07-17T15:00:00Z'),
  };
  const exit: Fill = {
    idempotency_key: LOT,
    broker_fill_id: toBrokerFillId('x1'),
    leg: 'exit',
    price: 104,
    qty: 4,
    fee: 0.4,
    timestamp: new Date('2026-07-17T15:30:00Z'),
  };
  await store.applyLotAdvance({
    idempotency_key: LOT,
    fills: [entry, exit],
    position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
  });
  await store.markResidualUnprotected(LOT, OPENED_AT);
}

type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, logger: Logger): StubConfig {
  return {
    db,
    clock: new SimulatedClock(SHUT_INSTANT),
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
      getLatestQuote: async () => ({ t: SHUT_INSTANT.toISOString(), ap: 100, bp: 99 }),
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
      max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
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
    tradingCalendar: new UsEquityRegularHoursCalendar(),
  } as StubConfig;
}

describe("the residual re-flatten reads the root's own session calendar (#1214)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('stands the re-flatten down outside the session and submits it inside, off one composition', async () => {
    const logger = recordingLogger();
    const broker = new SaxoShapedBroker();
    const config = stubConfig(db, logger);
    const clock = config.clock as SimulatedClock;
    const components = buildProductionComponents({ ...config, broker });
    await seedMarkedResidual(components.executionStore);

    const surface = buildExecutionSurface(components.executionDeps, 'trace-1214-wiring');

    await surface.sweepResidualProtection();
    expect(broker.flattenCalls).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ idempotency_key: LOT, reason: 'venue_shut' }),
      }),
    );

    clock.advanceTo(OPEN_INSTANT);
    await surface.sweepResidualProtection();
    expect(broker.flattenCalls).toEqual([
      { clientOrderId: `${LOT}:residual-reflatten-1`, size: 6 },
    ]);
  });
});
