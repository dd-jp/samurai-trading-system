import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TRADER_CONFIG } from '../../pipeline/trader/index.js';
import { FixtureDataSource } from '../../providers/market-data-service/index.js';
import {
  GdeltGkgClient,
  MiArchiveStore,
  PolymarketClient,
} from '../../providers/market-intelligence/index.js';
import { TokenBucket } from '../../shared/index.js';
import { openSharedStore, sharedStorePath } from '../../shared/store/index.js';
import {
  assertStorePathMatchesMode,
  BENCHMARK_INSTRUMENTS,
  DEFAULT_UNIVERSE,
  missingCredentialEnvVars,
  paperStartingProfile,
  SMOKE_TEST_UNIVERSE,
  startFromEnvironment,
  startingProfileForMode,
} from './index.js';
import type { Logger } from './types.js';

const offlineGdeltClient = new GdeltGkgClient({
  rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  fetchImpl: (async () => {
    throw new Error('offline: the test suite must not reach GDELT');
  }) as unknown as typeof fetch,
});

const offlinePolymarketClient = new PolymarketClient({
  rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  fetchImpl: (async () => {
    throw new Error('offline: the test suite must not reach Polymarket');
  }) as unknown as typeof fetch,
});

const offlineBarSource = new FixtureDataSource(
  [],
  { price: 100, observed_at: new Date('2026-08-04T10:00:00Z'), source: 'fixture' },
  'stocks',
);

const realFetch = globalThis.fetch;
let reachedGdelt: string | undefined;
const escapedToNetwork = new Set<string>();

function alpacaUnauthorized(): Response {
  return new Response('{"message":"unauthorized"}', {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

beforeAll(() => {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat offline fence dispatching by host (GDELT record-and-throw, Alpaca canned-401, default-deny) — each branch's own comment explains that host's rationale, and splitting them would scatter one fence across multiple functions and break that comment-to-branch adjacency
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input);
    if (url.includes('gdeltproject.org')) {
      reachedGdelt = url;
      throw new Error('offline: the test suite must not reach GDELT');
    }
    const host = hostOf(url);
    if (host === 'alpaca.markets' || host.endsWith('.alpaca.markets')) {
      return alpacaUnauthorized();
    }

    const escaped = host === '' ? '<unparseable URL>' : host;
    escapedToNetwork.add(escaped);
    throw new Error(`offline: the test suite must not reach ${escaped}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (reachedGdelt !== undefined) {
    throw new Error(
      `startup.test.ts reached ${reachedGdelt} — a startFromEnvironment call is missing ` +
        '`gdeltClient: offlineGdeltClient`.',
    );
  }
  if (escapedToNetwork.size > 0) {
    throw new Error(
      `startup.test.ts tried to reach ${[...escapedToNetwork].join(', ')} — a unit suite must ` +
        'not depend on a third party being reachable. Stub the client, or answer the host in ' +
        'the fence above the way Alpaca is answered (#701).',
    );
  }
});

function resolvedUnexpectedly(): never {
  throw new Error('startFromEnvironment resolved, but this test requires it to reject');
}

const MUTATED_ENV_VARS = [
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'NOUS_API_KEY',
  'NOUS_BASE_URL',
  'SAMURAI_SENTIMENT',
  'NODE_ENV',
  'SAMURAI_MODE',
  'SAMURAI_ALERTS',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_HEARTBEAT_CHAT_ID',
  'SAMURAI_LIVE_MAX_CAPITAL_USD',
  'ALPACA_LIVE_API_KEY',
  'ALPACA_LIVE_API_SECRET',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    savedEnv.set(name, process.env[name]);
  }
  process.env.SAMURAI_ALERTS = 'log-only';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;
});

afterEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const STAGE_CONFIGS = {
  traderConfig: DEFAULT_TRADER_CONFIG as never,
  riskConfig: {} as never,
  verdictConfig: {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
  } as never,
  executionConfig: {} as never,
  correlationConfig: {} as never,
  breakerConfig: {
    daily_loss_pct: 0.05,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.3,
    max_consecutive_losses: 5,
    volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
    auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
  } as never,
  costConfig: {} as never,
  ciiConsumerConfig: { pollIntervalMs: 60_000 } as never,
  universe: SMOKE_TEST_UNIVERSE,
};

describe('startFromEnvironment — real construction path', () => {
  it('assembles and starts the whole orchestrator from credentials alone', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';

    const orchestrator = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    });

    try {
      expect(orchestrator.tickRunner).toBeDefined();
      expect(orchestrator.broker).toBeDefined();
    } finally {
      await orchestrator.stop();
    }
  });

  it('the startup log line reports the universe the orchestrator actually holds, not a fresh read of injected.universe', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    let reads = 0;
    const injected = {
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
      logger,
      get universe() {
        reads += 1;
        return [{ asset: `U${reads}`, asset_class: 'stocks' as const }];
      },
    };

    const orchestrator = await startFromEnvironment(injected);

    try {
      const started = entries.find((entry) => entry.message === 'orchestrator started');
      expect(started?.payload).toMatchObject({
        universe: orchestrator.universe.map((i) => i.asset),
      });
    } finally {
      await orchestrator.stop();
    }
  });

  it('refuses to start on a book holding pre-#686 idempotency keys', async () => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';

    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO open_positions (
         idempotency_key, debate_id, instrument, asset_class, side, intent_type,
         requested_size, filled_size, avg_entry_price, stop, target, order_state,
         broker_order_ids, opened_at, decision_timestamp, key_scheme
       ) VALUES ('pre-686', 'd', '3USL', 'stocks', 'buy', 'entry',
         1, 1, 100, 95, 110, 'filled', '[]', '2026-08-14T09:00:00.000Z',
         '2026-08-14T09:00:00.000Z', 1)`,
    ).run();

    const error = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db,
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('Refusing to start');
    expect(error.message).toContain('pre-686');
  });

  it('fails with an actionable message when Alpaca credentials are absent', async () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;

    const error = await startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('ALPACA_API_KEY');
    expect(error.message).toContain('.env.local');
  });

  it('names every missing credential in one message, not one per attempt', () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    delete process.env.NOUS_API_KEY;
    delete process.env.NOUS_BASE_URL;

    const error = startFromEnvironment({
      ...STAGE_CONFIGS,
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    return error.then((e) => {
      expect(e.message).toContain('ALPACA_API_KEY');
      expect(e.message).toContain('ALPACA_API_SECRET');
      expect(e.message).toContain('NOUS_API_KEY');
    });
  });
});

describe('startFromEnvironment — the shipped paper profile', () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
    process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    process.env.NOUS_API_KEY = 'dummy-nous-not-a-credential';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';
  });

  it('boots to a running tick loop and logs `orchestrator started`', async () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
      logger,
    });

    try {
      const started = entries.find((entry) => entry.message === 'orchestrator started');
      expect(started).toBeDefined();
      expect(started?.payload).toMatchObject({
        mode: 'paper',
        universe: DEFAULT_UNIVERSE.map((instrument) => instrument.asset),
      });

      const inertClassWarn = entries.find((entry) =>
        entry.message.includes('no instruments configured for asset class'),
      );
      expect(inertClassWarn?.payload).toMatchObject({ asset_class: 'crypto' });
    } finally {
      await orchestrator.stop();
    }
  });

  it('opens the file named after the TRADING MODE, whatever NODE_ENV says (#330)', async () => {
    process.env.NODE_ENV = 'staging';
    process.env.SAMURAI_MODE = 'paper';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-startup-')));
    const cwd = process.cwd();
    process.chdir(sandbox);

    let orchestrator: Awaited<ReturnType<typeof startFromEnvironment>> | undefined;

    try {
      orchestrator = await startFromEnvironment({
        ...paperStartingProfile('paper'),
        logger,
        gdeltClient: offlineGdeltClient,
        polymarketClient: offlinePolymarketClient,
      });

      expect(existsSync(join(sandbox, 'data/samurai-paper.sqlite'))).toBe(true);
      expect(existsSync(join(sandbox, 'data/samurai-staging.sqlite'))).toBe(false);
      expect(entries.find((entry) => entry.message.includes('#330'))).toBeUndefined();
    } finally {
      await orchestrator?.stop();
      process.chdir(cwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not warn about a store handle it did not resolve', () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    return startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
      logger,
    }).then(async (orchestrator) => {
      try {
        expect(entries.filter((entry) => entry.message.includes('#330'))).toEqual([]);
      } finally {
        await orchestrator.stop();
      }
    });
  });

  it('refuses to boot at all when SAMURAI_ALERTS is unset (#322)', async () => {
    delete process.env.SAMURAI_ALERTS;

    const error = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('SAMURAI_ALERTS');
  });

  it('names every missing Telegram variable when the unattended mode is selected', async () => {
    const sentinel = '1234567:AA-not-a-real-bot-token-sentinel';
    process.env.SAMURAI_ALERTS = 'telegram';
    process.env.TELEGRAM_BOT_TOKEN = sentinel;

    const error = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).toContain('TELEGRAM_CHAT_ID');
    expect(error.message).toMatch(
      /required credential\(s\) are not set \([^)]*TELEGRAM_HEARTBEAT_CHAT_ID[^)]*\)/,
    );
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('boots with the real push transport under SAMURAI_ALERTS=telegram', async () => {
    process.env.SAMURAI_ALERTS = 'telegram';
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-token-not-a-credential';
    process.env.TELEGRAM_CHAT_ID = '-1001234567890';
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = '-1009876543210';

    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile('paper'),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
      logger,
    });

    try {
      expect(entries.some((e) => e.message.includes('SAMURAI_ALERTS=telegram'))).toBe(true);
      expect(entries.some((e) => e.message === 'orchestrator started')).toBe(true);
      expect(entries.some((e) => e.message.includes('SAMURAI_ALERTS=log-only'))).toBe(false);
      expect(JSON.stringify(entries)).not.toContain('dummy-token-not-a-credential');

      const fetchStub = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: {} }),
      });
      vi.stubGlobal('fetch', fetchStub);
      try {
        await orchestrator.heartbeat.emit({ now: () => new Date('2026-08-04T10:00:00Z') });

        expect(fetchStub).toHaveBeenCalledTimes(1);
        const [, init] = fetchStub.mock.calls[0] as [string, { body: string }];
        expect(JSON.parse(init.body)).toMatchObject({ chat_id: '-1009876543210' });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      await orchestrator.stop();
    }
  });

  it('refuses to boot the shipped PAPER profile into live mode', () => {
    expect(() => paperStartingProfile('live')).toThrow(/live/i);
  });

  it('never reads the live key pair on a paper boot', () => {
    process.env.SAMURAI_MODE = 'paper';
    process.env.ALPACA_LIVE_API_KEY = '';
    process.env.ALPACA_LIVE_API_SECRET = 'not-a-key';
    process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = 'nonsense';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).not.toContain(
      'ALPACA_LIVE_API_KEY',
    );
    expect(() => paperStartingProfile('paper')).not.toThrow();
    expect(startingProfileForMode('paper')).toMatchObject({ mode: 'paper' });
  });
});

describe('startFromEnvironment — the live profile (#511)', () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
    process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    process.env.ALPACA_LIVE_API_KEY = 'dummy-live-key-not-a-credential';
    process.env.ALPACA_LIVE_API_SECRET = 'dummy-live-secret-not-a-credential';
    process.env.NOUS_API_KEY = 'dummy-nous-not-a-credential';
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.SAMURAI_SENTIMENT = 'off';
    process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = '2000';
  });

  it('boots a live-configured orchestrator pointed at the live Alpaca host', async () => {
    const entries: Parameters<Logger['log']>[0][] = [];
    const logger: Logger = { log: (entry) => entries.push(entry) };

    const orchestrator = await startFromEnvironment({
      ...startingProfileForMode('live', logger),
      universe: DEFAULT_UNIVERSE.filter(
        (instrument) => !BENCHMARK_INSTRUMENTS.has(instrument.asset.toUpperCase()),
      ),
      db: openSharedStore(':memory:'),
      miArchive: new MiArchiveStore(),
      gdeltClient: offlineGdeltClient,
      polymarketClient: offlinePolymarketClient,
      dataSource: offlineBarSource,
      logger,
    });

    try {
      const started = entries.find((entry) => entry.message === 'orchestrator started');
      expect(started?.payload).toMatchObject({ mode: 'live' });

      const brokerLine = entries.find((entry) =>
        entry.message.includes('LIVE Alpaca broker client'),
      );
      expect(brokerLine?.level).toBe('warn');
      expect(brokerLine?.payload).toMatchObject({
        mode: 'live',
        environment: 'live',
        baseUrl: 'https://api.alpaca.markets',
      });

      const profileWarn = entries.find((entry) => entry.message.includes('LIVE STARTING PROFILE'));
      expect(profileWarn?.level).toBe('warn');
      expect(profileWarn?.payload).toMatchObject({ capital_ceiling_usd: 2_000 });

      expect(JSON.stringify(entries)).not.toContain('dummy-live-key-not-a-credential');
      expect(JSON.stringify(entries)).not.toContain('dummy-live-secret-not-a-credential');
    } finally {
      await orchestrator.stop();
    }
  });

  it(
    'the REAL default live entrypoint no longer carries a benchmark instrument (#1006) — ' +
      "`startingProfileForMode('live')` resolves to `DEFAULT_UNIVERSE`, and #1006 removed " +
      "'SPY' from it, so the collision the #989 guard refuses on cannot be reached by " +
      'the default entrypoint an operator gets from `SAMURAI_MODE=live` alone. This ' +
      'asserts the universe, not the guard: the guard itself is proved by the test below, ' +
      'which puts a benchmark symbol back',
    () => {
      const { universe } = startingProfileForMode('live');

      expect(
        (universe ?? DEFAULT_UNIVERSE).filter((instrument) =>
          BENCHMARK_INSTRUMENTS.has(instrument.asset.toUpperCase()),
        ),
      ).toEqual([]);
    },
  );

  it(
    'still refuses to boot live when a BENCHMARK_INSTRUMENTS symbol IS configured (#989) — ' +
      '#1006 removed the collision from the default universe, it did not remove the guard, ' +
      'and an operator who re-adds a benchmark symbol by hand must still be stopped before ' +
      'two writers target the same bars row under different calendars',
    async () => {
      const error = await startFromEnvironment({
        ...startingProfileForMode('live'),
        universe: [...DEFAULT_UNIVERSE, { asset: 'SPY', asset_class: 'stocks' }],
        db: openSharedStore(':memory:'),
        miArchive: new MiArchiveStore(),
        gdeltClient: offlineGdeltClient,
        polymarketClient: offlinePolymarketClient,
      }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

      expect(error.message).toMatch(/collides with the outside-benchmark path/);
    },
  );

  it.each(['', '  ', '0', '-500', 'abc'])(
    'refuses to boot live with a capital ceiling of %j',
    (ceiling) => {
      process.env.SAMURAI_LIVE_MAX_CAPITAL_USD = ceiling;

      expect(() => startingProfileForMode('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
    },
  );

  it('refuses to boot live with the ceiling unset', () => {
    delete process.env.SAMURAI_LIVE_MAX_CAPITAL_USD;

    expect(() => startingProfileForMode('live')).toThrow('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });

  it.each(['ALPACA_LIVE_API_KEY', 'ALPACA_LIVE_API_SECRET'])(
    'refuses to boot live when %s is absent, with no fallback to the paper pair',
    async (name) => {
      delete process.env[name];

      const error = await startFromEnvironment({
        ...startingProfileForMode('live'),
        db: openSharedStore(':memory:'),
        miArchive: new MiArchiveStore(),
        gdeltClient: offlineGdeltClient,
        polymarketClient: offlinePolymarketClient,
        dataSource: offlineBarSource,
      }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

      expect(error.message).toContain(name);
      expect(missingCredentialEnvVars({}, 'log-only', 'live', 'alpaca')).toContain(name);
    },
  );

  it('keeps live state in its own store file, so a live run cannot inherit paper positions', () => {
    process.env.SAMURAI_MODE = 'live';
    expect(sharedStorePath()).toContain('samurai-live.sqlite');

    process.env.SAMURAI_MODE = 'paper';
    expect(sharedStorePath()).toContain('samurai-paper.sqlite');

    expect(() =>
      assertStorePathMatchesMode({ dbPath: 'data/samurai-paper.sqlite', mode: 'live' }),
    ).toThrow(/samurai-paper.sqlite/);
  });
});
