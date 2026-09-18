import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SaxoAssetType,
  SaxoInstrumentDetails,
  SaxoOpenApiClient,
} from '../../../pipeline/execution/index.js';
import {
  SaxoBrokerAdapter,
  SaxoHttpBrokerClient,
  SaxoTokenRefresher,
} from '../../../pipeline/execution/index.js';
import { LSE_ETP_POOL, tradeableUniverse } from '../../../providers/universe-pool/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import {
  BROKER_VENUE_ENV_VAR,
  buildSaxoBroker,
  buildSaxoTokenSource,
  buildSaxoVenueClient,
  resolveBrokerVenue,
  saxoTradeableUniverse,
} from './saxo-venue.js';

const silentLogger: Logger = { log: () => undefined };

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

  it('refuses with no funding read at all — Alpaca USD equity must not size a GBP book', async () => {
    await expect(buildSaxoBroker(saxoDeps(db, { accountState: undefined }))).rejects.toThrow(
      /accountFunding/,
    );
  });

  it('accepts a GBP-native funding read in place of a whole accountState (#1509)', async () => {
    const broker = await buildSaxoBroker(
      saxoDeps(db, {
        accountState: undefined,
        accountFunding: {
          readFunding: async () => ({ cash: 1_000, equity: 1_000, currency: 'GBP' }),
        },
      }),
    );

    expect(broker).toBeInstanceOf(SaxoBrokerAdapter);
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

describe('buildSaxoTokenSource', () => {
  const APP_CREDENTIALS = {
    SAXO_SIM_APP_KEY: 'app-key-fixture',
    SAXO_SIM_APP_SECRET: 'app-secret-fixture',
  };
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-venue-token-'));
    tokenPath = join(dir, 'sim.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function savedSession(): void {
    writeFileSync(
      tokenPath,
      JSON.stringify({
        environment: 'sim',
        accessToken: 'access-fixture',
        refreshToken: 'refresh-fixture',
        accessTokenExpiresAt: new Date(Date.now() + 1_200_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        obtainedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }

  it('prefers the saved login session over a pasted portal token', () => {
    savedSession();

    const source = buildSaxoTokenSource('sim', silentLogger, {
      env: { ...APP_CREDENTIALS, SAXO_SIM_ACCESS_TOKEN: 'pasted-fixture' },
      tokenPath,
    });

    expect(source).toBeInstanceOf(SaxoTokenRefresher);
    void source.stop();
  });

  it('does NOT fall back to the pasted token when the saved session is unusable — it reports the session lost', async () => {
    writeFileSync(tokenPath, '{"environment":"sim"}', { mode: 0o600 });

    const source = buildSaxoTokenSource('sim', silentLogger, {
      env: { ...APP_CREDENTIALS, SAXO_SIM_ACCESS_TOKEN: 'pasted-fixture' },
      tokenPath,
    });

    await expect(source.getAccessToken()).rejects.toThrow(/session is lost/);
    expect(source.sessionState()).toMatchObject({ status: 'lost' });
  });

  it('falls back to the pasted token only when no session was ever saved, and says it cannot be renewed', async () => {
    const logger = recordingLogger();

    const source = buildSaxoTokenSource('sim', logger, {
      env: { ...APP_CREDENTIALS, SAXO_SIM_ACCESS_TOKEN: 'pasted-fixture' },
      tokenPath,
    });

    expect(await source.getAccessToken()).toBe('pasted-fixture');
    expect(source.sessionState()).toEqual({ status: 'unrefreshable' });
    expect(logger.entries.map((entry) => entry.event)).toContain('saxo_session_unrefreshable');
  });

  it('refuses the boot with neither, naming the login command', () => {
    expect(() =>
      buildSaxoTokenSource('sim', silentLogger, { env: APP_CREDENTIALS, tokenPath }),
    ).toThrow(/npm run saxo:login -- --env sim/);
  });

  it('resolves the LIVE gateway from the live variables and the live file (#1523)', () => {
    const livePath = join(dir, 'live.json');
    writeFileSync(livePath, '{"environment":"live"}', { mode: 0o600 });

    const source = buildSaxoTokenSource('live', silentLogger, {
      env: { SAXO_LIVE_APP_KEY: 'k', SAXO_LIVE_APP_SECRET: 's' },
      tokenPath: livePath,
    });

    expect(source).toBeInstanceOf(SaxoTokenRefresher);
    void source.stop();
  });

  it('primes the session at boot and says so, without any request being made', () => {
    savedSession();
    const logger = recordingLogger();

    buildSaxoTokenSource('sim', logger, { env: APP_CREDENTIALS, tokenPath });

    expect(logger.entries.map((entry) => entry.event)).toContain('saxo_session_resumed');
  });

  it('reports an expired saved session at boot rather than on the first order', () => {
    writeFileSync(
      tokenPath,
      JSON.stringify({
        environment: 'sim',
        accessToken: 'access-fixture',
        refreshToken: 'refresh-fixture',
        accessTokenExpiresAt: new Date(Date.now() - 7_200_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        obtainedAt: new Date(Date.now() - 10_800_000).toISOString(),
      }),
      { mode: 0o600 },
    );
    const logger = recordingLogger();

    buildSaxoTokenSource('sim', logger, { env: APP_CREDENTIALS, tokenPath });

    const lost = logger.entries.find((entry) => entry.event === 'saxo_session_lost');
    expect(lost?.message).toMatch(/npm run saxo:login -- --env sim/);
  });

  it('refuses a saved session written for the OTHER gateway', async () => {
    writeFileSync(
      tokenPath,
      JSON.stringify({
        environment: 'live',
        accessToken: 'access-fixture',
        refreshToken: 'refresh-fixture',
        accessTokenExpiresAt: new Date(Date.now() + 1_200_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        obtainedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    const source = buildSaxoTokenSource('sim', silentLogger, {
      env: APP_CREDENTIALS,
      tokenPath,
    });

    expect(source.sessionState()).toMatchObject({
      status: 'lost',
      reason: expect.stringContaining('is for the live gateway, not sim'),
    });
    await expect(source.getAccessToken()).rejects.toThrow(/session is lost/);
  });

  it('is what the venue client authenticates with — no SAXO_SIM_ACCESS_TOKEN in the environment', () => {
    savedSession();
    const source = buildSaxoTokenSource('sim', silentLogger, {
      env: APP_CREDENTIALS,
      tokenPath,
    });
    const saved = process.env.SAXO_SIM_ACCESS_TOKEN;
    delete process.env.SAXO_SIM_ACCESS_TOKEN;

    try {
      expect(buildSaxoVenueClient(silentLogger, source)).toBeInstanceOf(SaxoHttpBrokerClient);
    } finally {
      if (saved !== undefined) process.env.SAXO_SIM_ACCESS_TOKEN = saved;
      void source.stop();
    }
  });
});
