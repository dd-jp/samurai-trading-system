/**
 * #1400 — the composition root's Saxo venue seam. Every case here is about
 * the seam being REACHABLE and REFUSING correctly; the adapter's own order
 * semantics are `saxo-adapter.test.ts`'s.
 */
import type {
  SaxoAssetType,
  SaxoInstrumentDetails,
  SaxoOpenApiClient,
} from '../../../pipeline/execution/index.js';
import { SaxoBrokerAdapter } from '../../../pipeline/execution/index.js';
import { LSE_ETP_POOL, tradeableUniverse } from '../../../providers/universe-pool/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import {
  BROKER_VENUE_ENV_VAR,
  buildSaxoBroker,
  resolveBrokerVenue,
  saxoTradeableUniverse,
} from './saxo-venue.js';

const silentLogger: Logger = { log: () => undefined };

/** Every checked-in sterling line quotes in pence with a 0.01 factor (doc 44 §2.1). */
function penceDetails(uic: number, assetType: SaxoAssetType): SaxoInstrumentDetails {
  return {
    Uic: uic,
    AssetType: assetType,
    CurrencyCode: 'GBP',
    PriceCurrency: 'GBX',
    PriceToContractFactor: 0.01,
  };
}

function fixtureClient(
  details: (uic: number, assetType: SaxoAssetType) => SaxoInstrumentDetails = penceDetails,
): SaxoOpenApiClient {
  return {
    getInstrumentDetails: async (uic, assetType) => details(uic, assetType),
    placeOrder: async () => ({ OrderId: 'order-1' }),
    cancelOrder: async () => undefined,
    listOpenOrders: async () => [],
    listOrderActivities: async () => [],
    listNetPositions: async () => [],
  };
}

function saxoDeps(db: StoreHandle, overrides: Record<string, unknown> = {}): never {
  return {
    mode: 'paper',
    universe: saxoTradeableUniverse(),
    accountState: {},
    db,
    logger: silentLogger,
    legResizeAlerts: { postLegResizeUnverifiedAlert: async () => undefined },
    dormantLegsAlerts: { postDormantLegsUnresolvedAlert: async () => undefined },
    priceUnitAlerts: { postUnresolvedPriceUnitAlert: async () => undefined },
    client: fixtureClient(),
    ...overrides,
  } as never;
}

describe('resolveBrokerVenue', () => {
  it('defaults to alpaca when the variable is absent — Saxo is never reachable by omission', () => {
    expect(resolveBrokerVenue({})).toBe('alpaca');
  });

  it('selects saxo only on an exact, untrimmed match', () => {
    expect(resolveBrokerVenue({ [BROKER_VENUE_ENV_VAR]: 'saxo' })).toBe('saxo');
    for (const raw of ['Saxo', 'SAXO', ' saxo', 'saxo ', 'saxobank']) {
      expect(() => resolveBrokerVenue({ [BROKER_VENUE_ENV_VAR]: raw })).toThrow(
        new RegExp(BROKER_VENUE_ENV_VAR),
      );
    }
  });

  it('refuses an unrecognised venue rather than falling back to alpaca', () => {
    expect(() => resolveBrokerVenue({ [BROKER_VENUE_ENV_VAR]: 'ibkr' })).toThrow(/ibkr/);
  });
});

describe('saxoTradeableUniverse', () => {
  it("is EXACTLY the pool's tradeable set (#1220), never a second copy of the rule", () => {
    const universe = saxoTradeableUniverse();

    expect(universe.length).toBeGreaterThan(0);
    expect(universe.map((instrument) => instrument.asset)).toEqual(
      tradeableUniverse().map((row) => row.lse_ticker),
    );
    for (const instrument of universe) {
      expect(instrument.asset_class).toBe('stocks');
    }
    // Never a US screening proxy: those are what the analysts read, never what is routed.
    expect(universe.map((instrument) => instrument.asset)).not.toContain('QQQ');
  });

  it('carries only the MEASURED D5 subclass, so an unmeasured row cannot arm the envelope', () => {
    for (const instrument of saxoTradeableUniverse()) {
      const row = LSE_ETP_POOL.find((candidate) => candidate.lse_ticker === instrument.asset);
      expect(instrument.subclass).toBe(
        row?.subclass_envelope_measured === true ? row.subclass : undefined,
      );
    }
  });

  it('names only lines Saxo actually lists, so every instrument can resolve to a Uic', () => {
    for (const instrument of saxoTradeableUniverse()) {
      const row = LSE_ETP_POOL.find((candidate) => candidate.lse_ticker === instrument.asset);
      expect(row?.provenance.saxo.line ?? null).not.toBeNull();
    }
  });
});

describe('buildSaxoBroker', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  it('constructs the SAXO adapter, not the Alpaca one', async () => {
    const broker = await buildSaxoBroker(saxoDeps(db));

    expect(broker).toBeInstanceOf(SaxoBrokerAdapter);
  });

  it('refuses SAMURAI_MODE=live — the live-money gates are open and no live token may be read', async () => {
    await expect(buildSaxoBroker(saxoDeps(db, { mode: 'live' }))).rejects.toThrow(/live/i);
  });

  it('refuses without an injected accountState — Alpaca USD equity must not size a GBP book', async () => {
    await expect(buildSaxoBroker(saxoDeps(db, { accountState: undefined }))).rejects.toThrow(
      /accountState/,
    );
  });

  it('refuses a universe holding an instrument the Saxo venue does not trade', async () => {
    const universe: UniverseInstrument[] = [
      ...saxoTradeableUniverse(),
      { asset: 'SPY', asset_class: 'stocks' },
    ];

    await expect(buildSaxoBroker(saxoDeps(db, { universe }))).rejects.toThrow(/SPY/);
  });

  it('refuses an empty universe rather than constructing an adapter that trades nothing', async () => {
    await expect(buildSaxoBroker(saxoDeps(db, { universe: [] }))).rejects.toThrow(/universe/i);
  });

  it('refuses a line whose venue quote unit contradicts its factor (#1302) — unscaled pence never reach sizing', async () => {
    const unscaled = fixtureClient((uic, assetType) => ({
      Uic: uic,
      AssetType: assetType,
      CurrencyCode: 'GBP',
      PriceCurrency: 'GBX',
      PriceToContractFactor: 1,
    }));

    await expect(buildSaxoBroker(saxoDeps(db, { client: unscaled }))).rejects.toThrow(
      /PriceToContractFactor/,
    );
  });
});
