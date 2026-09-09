/**
 * #1400 — the composition root reaches the Saxo adapter, and only when it is
 * told to.
 *
 * Every case here drives `startFromEnvironment` itself, the function the
 * shipped entrypoint calls. A test that composed its own wiring would prove
 * nothing about what ships — which is the exact shape of the defect this
 * ticket reports: `SaxoBrokerAdapter` was built, tested, and constructed by
 * nothing.
 *
 * There are NO Saxo credentials on this host, so the venue is driven against a
 * fixture gateway shaped by docs/research/43-saxo-openapi-order-idempotency.md
 * and docs/research/44-saxo-data-surface.md. A real SIM boot is unproven.
 */

import type {
  SaxoAssetType,
  SaxoInstrumentDetails,
  SaxoOpenApiClient,
  SaxoOrderRequest,
} from '../../pipeline/execution/index.js';
import { AlpacaBrokerAdapter, SaxoBrokerAdapter } from '../../pipeline/execution/index.js';
import type { LseMarkClient } from '../../providers/market-data-service/index.js';
import { MiArchiveStore } from '../../providers/market-intelligence/index.js';
import type { SharedStore } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { startFromEnvironment, startingProfileForMode } from './index.js';
import { paperStartingProfile } from './paper-profile.js';
import { BROKER_VENUE_ENV_VAR, saxoTradeableUniverse } from './production/saxo-venue.js';
import type { ProductionConfig, ProductionOrchestrator } from './production.js';

const NOW = new Date('2026-09-09T10:00:00.000Z');

/**
 * VERIFIED on SIM 2026-09-08 (doc 44 §2.1): every line this pool can trade
 * today is a GBX-quoted, GBP-settled ETP with `PriceToContractFactor` 0.01.
 */
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

/**
 * A pence-quoting vendor stand-in. The real LSE vendor is still an open owner
 * decision (#895), so nothing on this branch can boot the mark side for real —
 * which is why the ticket's "no refusal that traces to missing wiring" is
 * asserted about the BROKER seam here, not about a priced tick.
 */
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

function offlineInjections(db: SharedStore): Partial<ProductionConfig> {
  return {
    db,
    logger: { log: () => undefined },
    miArchive: new MiArchiveStore(':memory:'),
    llmClient: {
      complete: async () => ({ text: '{}' }),
    } as unknown as NonNullable<ProductionConfig['llmClient']>,
    // Both MI vendors reach the live network from the composition root's own
    // boot-time refresh; the suite's network guard is what catches it.
    gdeltClient: {
      fetchLatestBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
      fetchBatch: async () => ({ file_url: 'offline', published_at: NOW, rows: [] }),
    } as unknown as NonNullable<ProductionConfig['gdeltClient']>,
    polymarketClient: {
      fetchEventMarket: async () => undefined,
      fetchPriceHistory: async () => [],
    },
    /**
     * REQUIRED by the Saxo venue, not a convenience: Saxo's OpenAPI surface
     * carries no balances endpoint, so without this the venue refuses rather
     * than size a GBP book off Alpaca's USD account (#949).
     */
    accountState: {
      getAccountState: async () => ({
        equity: 1_000,
        cash: 1_000,
        buying_power: 1_000,
        currency: 'GBP',
        as_of: NOW,
      }),
    } as unknown as NonNullable<ProductionConfig['accountState']>,
  };
}

describe('startFromEnvironment (broker venue selection, #1400)', () => {
  const savedVenue = process.env[BROKER_VENUE_ENV_VAR];
  const savedAlerts = process.env.SAMURAI_ALERTS;
  const savedMode = process.env.SAMURAI_MODE;
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    process.env.SAMURAI_ALERTS = 'log-only';
    process.env.SAMURAI_MODE = 'paper';
  });

  afterEach(() => {
    db.close();
    if (savedVenue === undefined) delete process.env[BROKER_VENUE_ENV_VAR];
    else process.env[BROKER_VENUE_ENV_VAR] = savedVenue;
    if (savedAlerts === undefined) delete process.env.SAMURAI_ALERTS;
    else process.env.SAMURAI_ALERTS = savedAlerts;
    if (savedMode === undefined) delete process.env.SAMURAI_MODE;
    else process.env.SAMURAI_MODE = savedMode;
  });

  async function bootSaxo(gateway: SaxoOpenApiClient): Promise<ProductionOrchestrator> {
    process.env[BROKER_VENUE_ENV_VAR] = 'saxo';
    return await startFromEnvironment({
      ...startingProfileForMode('paper', undefined, 'saxo'),
      ...offlineInjections(db),
      lseMarkClient: fixtureLseMarkClient(),
      saxoBrokerClient: gateway,
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
    expect(orchestrator.universe.map((instrument) => instrument.asset)).not.toContain('SPY');
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
    // The book prices in GBP; the line quotes in pence. Unscaled pence is not
    // reachable from here — 31.15 leaves as 3115, not as 31.15.
    expect(order?.OrderPrice).toBeCloseTo(3115, 6);
    expect(order?.Orders?.map((leg) => leg.OrderPrice)).toEqual([2900, 3300]);
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
    // The universe the profile shipped before #1400, unredirected: this is
    // what goes red if the venue ever defaults to anything but Alpaca.
    expect(orchestrator.universe).toEqual(paperStartingProfile('paper').universe);
    expect(orchestrator.universe).not.toEqual(saxoTradeableUniverse());
  });
});
