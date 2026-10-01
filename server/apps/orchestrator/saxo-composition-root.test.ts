import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type {
  SaxoAssetType,
  SaxoInstrumentDetails,
  SaxoOpenApiClient,
  SaxoOrderRequest,
} from '../../pipeline/execution/index.js';
import { AlpacaBrokerAdapter, SaxoBrokerAdapter } from '../../pipeline/execution/index.js';
import type { LseMarkClient } from '../../providers/market-data-service/index.js';
import { timeframeToMs } from '../../providers/market-data-service/index.js';
import { MiArchiveStore } from '../../providers/market-intelligence/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { startFromEnvironment, startingProfileForMode } from './index.js';
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD, paperStartingProfile } from './paper-profile.js';
import type { AccountFundingSource } from './production/account-state.js';
import { BROKER_VENUE_ENV_VAR, saxoTradeableUniverse } from './production/saxo-venue.js';
import type { ProductionConfig, ProductionOrchestrator } from './production.js';
import { buildTrendingCloses, ConstantResponseLlmClient } from './smoke-run.js';

const NOW = new Date('2026-09-09T10:00:00.000Z');

function penceDetails(uic: number, assetType: SaxoAssetType): SaxoInstrumentDetails {
  return {
    Uic: uic,
    AssetType: assetType,
    CurrencyCode: 'GBP',
    PriceCurrency: 'GBX',
    PriceToContractFactor: 0.01,
  };
}

interface FixtureGateway extends SaxoOpenApiClient {
  readonly placed: SaxoOrderRequest[];
}

function fixtureSaxoGateway(): FixtureGateway {
  const placed: SaxoOrderRequest[] = [];
  return {
    placed,
    getInstrumentDetails: async (uic, assetType) => penceDetails(uic, assetType),
    placeOrder: async (request) => {
      placed.push(request);
      return {
        OrderId: `${placed.length}00`,
        ExternalReference: request.ExternalReference,
        Orders: (request.Orders ?? []).map((leg, index) => ({
          OrderId: `${placed.length}0${index + 1}`,
          ExternalReference: leg.ExternalReference,
        })),
      };
    },
    cancelOrder: async () => undefined,
    listOpenOrders: async () => [],
    listOrderActivities: async () => [],
    listNetPositions: async () => [],
  };
}

function fixtureLseMarkClient(): LseMarkClient {
  return {
    vendor: 'fixture-lse',
    getBars: async (_symbol, _timeframe, asOf, limit) => ({
      currency: 'GBX',
      candles: Array.from({ length: limit }, (_, index) => ({
        open_time: new Date(asOf.getTime() - (limit - index) * 60_000),
        open: 3115,
        high: 3120,
        low: 3110,
        close: 3115,
        volume: 10_000,
      })),
    }),
    getLatestQuote: async () => ({
      currency: 'GBX',
      price: 3115,
      bid: 3114,
      ask: 3116,
      observed_at: NOW,
    }),
  };
}

const PENCE_PER_SERIES_UNIT = 20;

const MARK_PRICE_UNITS = 160;

function trendingLseMarkClient(now: Date): LseMarkClient {
  return {
    vendor: 'fixture-lse-trending',
    getBars: async (_symbol, timeframe, asOf, limit) => {
      const stepMs = timeframeToMs(timeframe);
      return {
        currency: 'GBX',
        candles: buildTrendingCloses(limit, MARK_PRICE_UNITS - 1).map((close, index) => ({
          open_time: new Date(asOf.getTime() - (limit - index) * stepMs),
          open: close * PENCE_PER_SERIES_UNIT,
          high: (close + 2) * PENCE_PER_SERIES_UNIT,
          low: (close - 2) * PENCE_PER_SERIES_UNIT,
          close: close * PENCE_PER_SERIES_UNIT,
          volume: 10_000,
        })),
      };
    },
    getLatestQuote: async () => ({
      currency: 'GBX',
      price: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT,
      bid: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT - 5,
      ask: MARK_PRICE_UNITS * PENCE_PER_SERIES_UNIT + 5,
      observed_at: now,
    }),
  };
}

function offlineInjections(db: StoreHandle): Partial<ProductionConfig> {
  return {
    db,
    logger: { log: () => undefined },
    miArchive: new MiArchiveStore(':memory:'),
    llmClient: {
      complete: async () => ({ text: '{}' }),
    } as unknown as NonNullable<ProductionConfig['llmClient']>,
    gdeltClient: {
      fetchLatestBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
      fetchBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
    } as unknown as NonNullable<ProductionConfig['gdeltClient']>,
    polymarketClient: {
      fetchEventMarket: async () => undefined,
      fetchPriceHistory: async () => [],
    },
    accountState: {
      getAccountState: async () => ({
        cash: 1_400,
        peak_equity: 1_400,
        daily_basis: {
          crypto: { known: false, reason: 'crypto is out of scope' },
          stocks: { known: true, open_equity: 1_400, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 1_400, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    },
  };
}

// CPU-heavy: 2-4.5 s per case under coverage at load 25
describe('startFromEnvironment (broker venue selection, #1400)', { timeout: 15_000 }, () => {
  const savedVenue = process.env[BROKER_VENUE_ENV_VAR];
  const savedAlerts = process.env.SAMURAI_ALERTS;
  const savedMode = process.env.SAMURAI_MODE;
  let db: StoreHandle;
  let started: ProductionOrchestrator | undefined;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    started = undefined;
    process.env.SAMURAI_ALERTS = 'log-only';
    process.env.SAMURAI_MODE = 'paper';
  });

  afterEach(async () => {
    await started?.stop();
    db.close();
    if (savedVenue === undefined) delete process.env[BROKER_VENUE_ENV_VAR];
    else process.env[BROKER_VENUE_ENV_VAR] = savedVenue;
    if (savedAlerts === undefined) delete process.env.SAMURAI_ALERTS;
    else process.env.SAMURAI_ALERTS = savedAlerts;
    if (savedMode === undefined) delete process.env.SAMURAI_MODE;
    else process.env.SAMURAI_MODE = savedMode;
  });

  async function bootSaxo(
    gateway: SaxoOpenApiClient,
    logs?: LogEntry[],
    overrides: Partial<ProductionConfig> = {},
  ): Promise<ProductionOrchestrator> {
    process.env[BROKER_VENUE_ENV_VAR] = 'saxo';
    return await startFromEnvironment({
      ...startingProfileForMode('paper', undefined, 'saxo'),
      ...offlineInjections(db),
      ...(logs === undefined ? {} : { logger: { log: (entry: LogEntry) => logs.push(entry) } }),
      lseMarkClient: fixtureLseMarkClient(),
      saxoBrokerClient: gateway,
      ...overrides,
    });
  }

  it('constructs the SAXO adapter under SAMURAI_BROKER=saxo, not the Alpaca one', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(orchestrator.broker).toBeInstanceOf(SaxoBrokerAdapter);
    expect(orchestrator.broker).not.toBeInstanceOf(AlpacaBrokerAdapter);
  });

  it('gives that adapter the LSE ETP pool as its universe, not the Alpaca default', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(orchestrator.universe).toEqual(saxoTradeableUniverse());
    expect(orchestrator.universe.map((instrument) => instrument.asset)).toEqual([
      '3LUS',
      'LQQ3',
      'LCO3',
      '3KOR',
      '3KWE',
    ]);
  });

  it("routes a bracket to the venue in the LINE's quote unit, not the book's (#1302)", async () => {
    const gateway = fixtureSaxoGateway();
    const orchestrator = await bootSaxo(gateway);
    const instrument = orchestrator.universe[0]?.asset ?? '';

    await orchestrator.broker.submitBracket({
      client_order_id: 'k-1400',
      instrument,
      asset_class: 'stocks',
      side: 'buy',
      size: 10,
      entry: 31.15,
      stop: 29,
      target: 33,
      time_in_force: 'day',
    });

    expect(gateway.placed).toHaveLength(1);
    const order = gateway.placed[0];
    expect(order?.Uic).toBeGreaterThan(0);
    expect(order?.OrderPrice).toBeCloseTo(3115, 6);
    expect(order?.Orders?.map((leg) => leg.OrderPrice)).toEqual([2900, 3300]);
  });

  it('starts and stops the Saxo-wired orchestrator without a wiring refusal', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());
    started = orchestrator;

    await expect(orchestrator.start()).resolves.toBeDefined();
  });

  it('reaches the sixth stage and places the bracket, the 64-character idempotency key fitting the venue reference (#1510)', async () => {
    const clock = new SimulatedClock(NOW);
    const gateway = fixtureSaxoGateway();
    const profile = startingProfileForMode('paper', undefined, 'saxo');
    const orchestrator = await bootSaxo(gateway, undefined, {
      clock,
      llmClient: new ConstantResponseLlmClient(),
      lseMarkClient: trendingLseMarkClient(NOW),
      traderConfig: { ...profile.traderConfig, conviction_floor: 0.45 },
    });
    started = orchestrator;
    const instrument = orchestrator.universe[0]?.asset ?? '';
    const bar = floorToBar(NOW, DEBATE_BAR_TIMEFRAME_MS);

    const outcome = await orchestrator.tickRunner.runInstrument(
      { asset: instrument, asset_class: 'stocks' },
      {
        clock,
        trace_id: 'trace-1400-saxo',
        logger: { log: () => undefined },
        auditLog: orchestrator.persistence.auditLog,
        currentTickStore: orchestrator.persistence.currentTickStore,
        decision_bar: {
          id: `${bar.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`,
          open_time: bar,
          timeframe_ms: DEBATE_BAR_TIMEFRAME_MS,
        },
      },
    );

    expect(
      orchestrator.persistence.auditLog.getByTraceId('trace-1400-saxo').map((row) => row.stage),
    ).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(outcome.final_stage).toBe('execution');
    expect(outcome.verdict_status).toBe('go');

    expect(outcome.execution_result?.status).not.toBe('error');

    expect(gateway.placed).not.toHaveLength(0);
    const order = gateway.placed[0];
    expect(order?.ExternalReference?.length).toBeLessThanOrEqual(43);
  });

  const LSE_FLATTEN_TAIL = new Date('2026-09-09T15:27:00.000Z');
  const US_FLATTEN_TAIL = new Date('2026-09-09T19:57:00.000Z');

  it('records each line’s resolved quote unit at boot, so a 100x factor is auditable', async () => {
    const logs: LogEntry[] = [];
    await bootSaxo(fixtureSaxoGateway(), logs);

    const built = logs.find((entry) => entry.event === 'saxo_venue_built');
    expect(built).toBeDefined();
    expect(built?.payload).toMatchObject({ venue: 'saxo', mode: 'paper', environment: 'sim' });
    const lines = (built?.payload as { lines?: unknown[] } | undefined)?.lines;
    expect(lines).toHaveLength(saxoTradeableUniverse().length);
    expect(lines?.[0]).toMatchObject({
      asset: '3LUS',
      asset_type: 'Etn',
      currency: 'GBP',
      price_currency: 'GBX',
      price_to_contract_factor: 0.01,
    });
    for (const line of lines ?? []) {
      expect(typeof (line as { uic?: unknown }).uic).toBe('number');
      expect((line as { price_to_contract_factor?: unknown }).price_to_contract_factor).toBe(0.01);
    }
    const rendered = JSON.stringify(built);
    expect(rendered).not.toContain('gateway.saxobank.com');
    expect(rendered.toLowerCase()).not.toContain('token');
  });

  it('gates and flattens the Saxo run on the LSE close, not the US close', async () => {
    const orchestrator = await bootSaxo(fixtureSaxoGateway());

    expect(
      orchestrator.scheduler.nextTick({ now: () => LSE_FLATTEN_TAIL }).instruments,
    ).not.toEqual([]);
    expect(orchestrator.scheduler.nextTick({ now: () => US_FLATTEN_TAIL }).instruments).toEqual([]);
  });

  it('sizes the Saxo run against the GBP book, never the USD-converted ceiling', async () => {
    const profile = startingProfileForMode('paper', undefined, 'saxo');

    expect(profile.capitalCeilingUsd).toBe(LIVE_BOOK_GBP);
    expect(
      'capitalCeilingUsdPerGbp' in profile && profile.capitalCeilingUsdPerGbp !== undefined,
    ).toBe(false);
    expect(startingProfileForMode('paper').capitalCeilingUsd).toBe(LIVE_BOOK_SIZING_USD);
  });

  it('arms long_only_instruments with the Saxo tradeable set, and only on the Saxo path', () => {
    const saxoProfile = paperStartingProfile('paper', saxoTradeableUniverse(), 'GBP');

    expect(saxoProfile.riskConfig.long_only_instruments).toEqual(
      new Set(saxoTradeableUniverse().map((instrument) => instrument.asset)),
    );

    expect(paperStartingProfile('paper').riskConfig.long_only_instruments).toBeUndefined();
  });

  it('refuses a Saxo boot whose INJECTED accountFunding answers a foreign currency', async () => {
    const eurFunding: AccountFundingSource = {
      readFunding: async () => ({ cash: 1_000, equity: 1_000, currency: 'EUR' }),
    };

    await expect(
      bootSaxo(fixtureSaxoGateway(), undefined, { accountFunding: eurFunding }),
    ).rejects.toThrow(/EUR/);
  });

  it('leaves the Alpaca paper path in place when the venue is not configured', async () => {
    delete process.env[BROKER_VENUE_ENV_VAR];

    const orchestrator = await startFromEnvironment({
      ...startingProfileForMode('paper'),
      ...offlineInjections(db),
      alpacaBrokerClient: {} as unknown as NonNullable<ProductionConfig['alpacaBrokerClient']>,
      alpacaDataClient: {} as unknown as NonNullable<ProductionConfig['alpacaDataClient']>,
    });

    expect(orchestrator.broker).toBeInstanceOf(AlpacaBrokerAdapter);
    expect(orchestrator.universe).toEqual(paperStartingProfile('paper').universe);
    expect(orchestrator.universe).not.toEqual(saxoTradeableUniverse());
  });
});
