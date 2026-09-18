import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaxoTokenSource } from '../../pipeline/execution/index.js';
import type { LogEntry } from '../../shared/index.js';
import {
  assertStorePathMatchesMode,
  buildShutdownHandler,
  credentialRequirements,
  installFaultHandlers,
  missingCredentialEnvVars,
  paperStartingProfile,
  REQUIRED_INJECTED_CONFIG,
  runEntrypointLogRetention,
  startFromEnvironment,
  storePathEncodesTradingMode,
  withSaxoSessionStop,
} from './index.js';
import type { ProductionOrchestrator } from './production.js';

vi.mock('../../pipeline/execution/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pipeline/execution/index.js')>();
  return { ...actual, savedSessionExists: vi.fn(() => false) };
});

function resolvedUnexpectedly(): never {
  throw new Error('startFromEnvironment resolved, but this test requires it to reject');
}

describe('startFromEnvironment', () => {
  it('refuses to start with nothing wired, naming every missing dependency', async () => {
    await expect(startFromEnvironment()).rejects.toThrow(/cannot start/i);

    const error = await startFromEnvironment().then(
      resolvedUnexpectedly,
      (e: unknown) => e as Error,
    );
    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(error.message).toContain(key);
    }
  });

  it('names only the dependencies that are actually missing', async () => {
    const error = await startFromEnvironment({
      llmClient: {} as never,
      traderConfig: {} as never,
    }).then(resolvedUnexpectedly, (e: unknown) => e as Error);

    expect(error.message).not.toMatch(/\bllmClient\b/);
    expect(error.message).not.toMatch(/\btraderConfig\b/);
    expect(error.message).toContain('riskConfig');
  });

  it('rejects an unrecognised SAMURAI_MODE rather than casting it through', async () => {
    const previous = process.env.SAMURAI_MODE;
    process.env.SAMURAI_MODE = 'papper';
    try {
      const wired = Object.fromEntries(REQUIRED_INJECTED_CONFIG.map((key) => [key, {}])) as Record<
        string,
        unknown
      >;
      await expect(startFromEnvironment(wired as never)).rejects.toThrow(/SAMURAI_MODE/);
    } finally {
      if (previous === undefined) delete process.env.SAMURAI_MODE;
      else process.env.SAMURAI_MODE = previous;
    }
  });

  it('does NOT trim SAMURAI_MODE — trailing whitespace is refused, never silently cast to a real mode (#355)', async () => {
    const previous = process.env.SAMURAI_MODE;
    process.env.SAMURAI_MODE = 'live ';
    try {
      const wired = Object.fromEntries(REQUIRED_INJECTED_CONFIG.map((key) => [key, {}])) as Record<
        string,
        unknown
      >;
      await expect(startFromEnvironment(wired as never)).rejects.toThrow(/SAMURAI_MODE/);
    } finally {
      if (previous === undefined) delete process.env.SAMURAI_MODE;
      else process.env.SAMURAI_MODE = previous;
    }
  });

  it('lists every transport and stage config as a required injection', () => {
    expect(REQUIRED_INJECTED_CONFIG).toContain('riskConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('verdictConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('executionConfig');
    expect(new Set(REQUIRED_INJECTED_CONFIG).size).toBe(REQUIRED_INJECTED_CONFIG.length);

    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaBrokerClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaDataClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('accountState');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('volatility');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('heartbeatChannel');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('approvals');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('orphanAlerts');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('ciiScoreProvider');

    expect(
      [...REQUIRED_INJECTED_CONFIG]
        .filter((key) => key !== 'universe')
        .every((key) => key.endsWith('Config')),
    ).toBe(true);
    expect(REQUIRED_INJECTED_CONFIG).toContain('universe');
  });

  it('does not still claim the trade-channel/HITL transports are unimplemented (#323)', async () => {
    const error = await startFromEnvironment().then(
      resolvedUnexpectedly,
      (e: unknown) => e as Error,
    );

    expect(error.message).not.toMatch(/still have no implementation/i);
    expect(error.message).toContain('TelegramBotApiClient');
    expect(error.message).toContain('paperStartingProfile');
  });

  it('is satisfied by the checked-in paper profile', () => {
    const profile = paperStartingProfile('paper');

    expect(REQUIRED_INJECTED_CONFIG.filter((key) => profile[key] === undefined)).toEqual([]);
  });

  it('does NOT default to the paper profile — an unwired caller still fails', async () => {
    await expect(startFromEnvironment()).rejects.toThrow(/required dependencies are not wired/i);
  });
});

describe('missingCredentialEnvVars', () => {
  const CREDENTIALS = [
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
    'NOUS_API_KEY',
    'NOUS_BASE_URL',
    'NOUS_DEBATE_API_KEY',
    'NOUS_SENTIMENT_API_KEY',
    'SAXO_SIM_ACCESS_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_HEARTBEAT_CHAT_ID',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of CREDENTIALS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of CREDENTIALS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('names every missing credential at once, not one per run', () => {
    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'NOUS_API_KEY',
      'NOUS_BASE_URL',
    ]);
  });

  it('treats an empty value as missing, matching the tracked .env placeholders', () => {
    process.env.ALPACA_API_KEY = '';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['ALPACA_API_KEY']);
  });

  it('treats a whitespace-only value as missing too', () => {
    process.env.ALPACA_API_KEY = ' ';
    process.env.ALPACA_API_SECRET = '\n';
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
    ]);
  });

  it('accepts a per-role Nous key in place of the shared one', () => {
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_BASE_URL = 'set';
    process.env.NOUS_DEBATE_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([]);
  });

  it('still reports the shared key when no per-role key is set either', () => {
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['NOUS_API_KEY']);
  });

  it('does not let a per-role key substitute for the base URL', () => {
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_SENTIMENT_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['NOUS_BASE_URL']);
  });

  it('does not demand credentials for clients the caller injected', () => {
    expect(
      missingCredentialEnvVars(
        {
          alpacaBrokerClient: {} as never,
          dataSource: {} as never,
          llmClient: {} as never,
        },
        'log-only',
        'paper',
        'alpaca',
      ),
    ).toEqual([]);
  });

  it('still demands Alpaca keys when only the broker ADAPTER is overridden', () => {
    expect(
      missingCredentialEnvVars(
        { broker: {} as never, llmClient: {} as never },
        'log-only',
        'paper',
        'alpaca',
      ),
    ).toEqual(['ALPACA_API_KEY', 'ALPACA_API_SECRET']);
  });

  it('does not demand Alpaca keys for a Saxo run that builds its own funding read (#1509)', () => {
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';
    process.env.SAXO_SIM_ACCESS_TOKEN = 'set';

    expect(
      missingCredentialEnvVars({ dataSource: {} as never }, 'log-only', 'paper', 'saxo'),
    ).toEqual([]);
  });

  it('demands Alpaca keys again when an injected Saxo client suppresses that read', () => {
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(
      missingCredentialEnvVars(
        { saxoBrokerClient: {} as never, dataSource: {} as never },
        'log-only',
        'paper',
        'saxo',
      ),
    ).toEqual(['ALPACA_API_KEY', 'ALPACA_API_SECRET']);
  });

  it('swaps the pasted Saxo token for the app credentials once a saved session exists', () => {
    const context = {
      injected: {},
      alertsMode: 'log-only' as const,
      mode: 'paper' as const,
      venue: 'saxo' as const,
    };
    const required = (savedSaxoSession: boolean): string[] =>
      credentialRequirements()
        .filter((requirement) => !requirement.unusedByThisRun({ ...context, savedSaxoSession }))
        .flatMap((requirement) => [...requirement.vars])
        .filter((name) => name.startsWith('SAXO_'));

    expect(required(false)).toEqual(['SAXO_SIM_ACCESS_TOKEN']);
    expect(required(true)).toEqual(['SAXO_SIM_APP_KEY', 'SAXO_SIM_APP_SECRET']);
  });

  it('never returns a credential VALUE, only its variable name', () => {
    process.env.ALPACA_API_KEY = 'super-secret-key';
    process.env.TELEGRAM_BOT_TOKEN = 'super-secret-bot-token';

    expect(missingCredentialEnvVars({}, 'telegram', 'paper', 'alpaca').join(' ')).not.toContain(
      'super-secret-key',
    );
    expect(missingCredentialEnvVars({}, 'telegram', 'paper', 'alpaca').join(' ')).not.toContain(
      'super-secret-bot-token',
    );
  });

  it('demands the Telegram variables only under the unattended alerts mode (#322)', () => {
    expect(missingCredentialEnvVars({}, 'telegram', 'paper', 'alpaca')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'NOUS_API_KEY',
      'NOUS_BASE_URL',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_HEARTBEAT_CHAT_ID',
    ]);
    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).not.toContain(
      'TELEGRAM_BOT_TOKEN',
    );
    expect(missingCredentialEnvVars({}, undefined, 'paper', 'alpaca')).not.toContain(
      'TELEGRAM_BOT_TOKEN',
    );
  });

  it('drops the heartbeat chat id when the caller injected its own heartbeat channel (#342)', () => {
    expect(
      missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram', 'paper', 'alpaca'),
    ).not.toContain('TELEGRAM_HEARTBEAT_CHAT_ID');
    expect(
      missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram', 'paper', 'alpaca'),
    ).toContain('TELEGRAM_CHAT_ID');
  });
});

describe('storePathEncodesTradingMode', () => {
  it('is false for every NODE_ENV-keyed filename in use today', () => {
    for (const env of ['development', 'test', 'staging', 'production']) {
      expect(storePathEncodesTradingMode(`data/samurai-${env}.sqlite`, 'paper')).toBe(false);
      expect(storePathEncodesTradingMode(`data/samurai-${env}.sqlite`, 'live')).toBe(false);
    }
  });

  it('is true for the mode-keyed filenames #168 specifies', () => {
    expect(storePathEncodesTradingMode('data/samurai-paper.sqlite', 'paper')).toBe(true);
    expect(storePathEncodesTradingMode('data/samurai-live.sqlite', 'live')).toBe(true);
    expect(storePathEncodesTradingMode('data/samurai-backtest.sqlite', 'backtest')).toBe(true);
  });

  it('does not confuse one mode-keyed file for another', () => {
    expect(storePathEncodesTradingMode('data/samurai-paper.sqlite', 'live')).toBe(false);
    expect(storePathEncodesTradingMode('data/samurai-live.sqlite', 'paper')).toBe(false);
  });

  it('reads the filename only, not the directories above it', () => {
    expect(
      storePathEncodesTradingMode('/home/me/live/data/samurai-production.sqlite', 'live'),
    ).toBe(false);
  });
});

describe('assertStorePathMatchesMode', () => {
  it('passes for the mode-keyed path #330 made the norm', () => {
    expect(() =>
      assertStorePathMatchesMode({ dbPath: 'data/samurai-paper.sqlite', mode: 'paper' }),
    ).not.toThrow();
    expect(() =>
      assertStorePathMatchesMode({ dbPath: 'data/samurai-live.sqlite', mode: 'live' }),
    ).not.toThrow();
  });

  it('REFUSES when the file is another mode — the injected-mode hazard #330 named', () => {
    expect(() =>
      assertStorePathMatchesMode({ dbPath: 'data/samurai-paper.sqlite', mode: 'live' }),
    ).toThrow(/cannot start/i);
  });

  it('names the mode and the file, and tells the operator which variable to set', () => {
    const error = (() => {
      try {
        assertStorePathMatchesMode({ dbPath: '/home/me/data/samurai-paper.sqlite', mode: 'live' });
      } catch (thrown) {
        return thrown as Error;
      }
      throw new Error('expected a refusal');
    })();

    expect(error.message).toContain("'live'");
    expect(error.message).toContain('samurai-paper.sqlite');
    expect(error.message).toContain('SAMURAI_MODE=live');
    expect(error.message).not.toContain('/home/me');
  });
});

describe('buildShutdownHandler', () => {
  function spyEffects() {
    const exits: number[] = [];
    const errors: string[] = [];
    return {
      exits,
      errors,
      effects: {
        exit: (code: number) => {
          exits.push(code);
        },
        stderr: (message: string) => {
          errors.push(message);
        },
      },
    };
  }

  it('exits 0 only after the drain resolves, never before', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { exits, effects } = spyEffects();

    buildShutdownHandler({ stop: () => drained }, effects)();
    await Promise.resolve();

    expect(exits).toEqual([]);

    release();
    await drained;
    await Promise.resolve();
    expect(exits).toEqual([0]);
  });

  it('still exits — with a non-zero code — when the drain rejects', async () => {
    const { exits, errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(new Error('tick blew up')) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([1]);
    expect(errors.join('')).toMatch(/tick blew up/);
  });

  it('reports the failed drain by message only, never the thrown object', async () => {
    const secretive = Object.assign(new Error('drain failed'), { apiKey: 'sk-live-must-not-leak' });
    const { errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(secretive) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.join('')).toMatch(/drain failed/);
    expect(errors.join('')).not.toMatch(/sk-live-must-not-leak/);
  });

  it('ignores a second signal rather than exiting through the first drain', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopCalls = 0;
    const { exits, effects } = spyEffects();
    const shutdown = buildShutdownHandler(
      {
        stop: () => {
          stopCalls++;
          return stopCalls === 1 ? drained : Promise.resolve();
        },
      },
      effects,
    );

    shutdown();
    shutdown();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toBe(1);
    expect(exits).toEqual([]);

    release();
    await drained;
    await Promise.resolve();
    expect(exits).toEqual([0]);
  });
});

describe('installFaultHandlers (#714)', () => {
  function harness() {
    const handlers = new Map<string, (error: unknown) => void>();
    const exits: number[] = [];
    const errors: string[] = [];
    const logged: LogEntry[] = [];
    return {
      handlers,
      exits,
      errors,
      logged,
      logger: {
        log: (entry: LogEntry) => {
          logged.push(entry);
        },
      },
      effects: {
        exit: (code: number) => {
          exits.push(code);
        },
        stderr: (message: string) => {
          errors.push(message);
        },
        on: (
          event: 'uncaughtException' | 'unhandledRejection',
          handler: (error: unknown) => void,
        ) => {
          handlers.set(event, handler);
        },
      },
    };
  }

  it('installs handlers for both unhandled fault kinds', () => {
    const h = harness();
    installFaultHandlers(h.logger, h.effects);

    expect([...h.handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  });

  for (const fault of ['uncaughtException', 'unhandledRejection'] as const) {
    it(`records a ${fault} durably and exits non-zero rather than continuing`, () => {
      const h = harness();
      installFaultHandlers(h.logger, h.effects);

      h.handlers.get(fault)?.(new Error('a stage exploded'));

      expect(h.exits).toEqual([1]);
      expect(h.logged).toHaveLength(1);
      expect(h.logged[0].level).toBe('error');
      expect(h.logged[0].message).toContain(fault);
      expect(h.logged[0].payload).toMatchObject({ fault, error: 'a stage exploded' });
      expect(h.errors.join('')).toMatch(/a stage exploded/);
    });
  }

  it('still exits when the logger itself has no sink left to record on', () => {
    const h = harness();
    installFaultHandlers(
      {
        log: () => {
          throw new Error('structured logging reached no sink');
        },
      },
      h.effects,
    );

    expect(() => h.handlers.get('uncaughtException')?.(new Error('EPIPE'))).not.toThrow();
    expect(h.exits).toEqual([1]);
  });

  it('reports by message only, never the thrown object', () => {
    const h = harness();
    installFaultHandlers(h.logger, h.effects);
    const secretive = Object.assign(new Error('boom'), { apiKey: 'sk-live-must-not-leak' });

    h.handlers.get('uncaughtException')?.(secretive);

    expect(h.errors.join('')).toMatch(/boom/);
    expect(h.errors.join('')).not.toMatch(/sk-live-must-not-leak/);
    expect(JSON.stringify(h.logged)).not.toMatch(/sk-live-must-not-leak/);
  });
});

describe('runEntrypointLogRetention (#1116)', () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'samurai-entrypoint-retention-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function backdate(path: string, ageMs: number): string {
    const seconds = (Date.now() - ageMs) / 1000;
    writeFileSync(path, 'line\n');
    utimesSync(path, seconds, seconds);
    return path;
  }

  function sinkConfig() {
    return { filePath: join(dir, 'orchestrator.log'), maxBytes: 1000, maxRotatedFiles: 2 };
  }

  it('sweeps the directory holding the configured sink file, and nothing else in it', () => {
    const stale = backdate(join(dir, 'orchestrator-20260101-0000.log'), 100 * ONE_DAY_MS);
    const untouched = backdate(join(dir, '.env.local'), 100 * ONE_DAY_MS);

    runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(() => statSync(stale)).toThrow();
    expect(statSync(untouched).isFile()).toBe(true);
  });

  it("protects the sink's own rotation generations, and only as many as are configured", () => {
    const rotated = backdate(join(dir, 'orchestrator.log.2'), 100 * ONE_DAY_MS);
    const orphaned = backdate(join(dir, 'orchestrator.log.9'), 100 * ONE_DAY_MS);

    runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(statSync(rotated).isFile()).toBe(true);
    expect(() => statSync(orphaned)).toThrow();
  });

  it('reads the window and the keep-list from the environment it is handed', () => {
    const kept = backdate(join(dir, 'supervisor-20260101-0000.log'), 5 * ONE_DAY_MS);
    const swept = backdate(join(dir, 'orchestrator-20260101-0000.log'), 5 * ONE_DAY_MS);

    runEntrypointLogRetention(
      sinkConfig(),
      { log: () => {} },
      {
        SAMURAI_LOG_RETENTION_DAYS: '2',
        SAMURAI_LOG_RETENTION_KEEP: 'supervisor-20260101-0000.log',
      },
    );

    expect(statSync(kept).isFile()).toBe(true);
    expect(() => statSync(swept)).toThrow();
  });

  it('truncates a bare live-shaped name once it crosses the configured byte threshold', () => {
    const soakBoot = join(dir, 'soak-boot.out');
    writeFileSync(soakBoot, 'x'.repeat(200));

    const result = runEntrypointLogRetention(
      sinkConfig(),
      { log: () => {} },
      {
        SAMURAI_LOG_BARE_TRUNCATE_BYTES: '100',
      },
    );

    expect(result.filesTruncated).toBe(1);
    expect(statSync(soakBoot).size).toBe(0);
  });

  it("never truncates the sink's own active file even though it is a bare name", () => {
    const config = sinkConfig();
    writeFileSync(config.filePath, 'x'.repeat(200));

    const result = runEntrypointLogRetention(
      config,
      { log: () => {} },
      {
        SAMURAI_LOG_BARE_TRUNCATE_BYTES: '100',
      },
    );

    expect(result.filesTruncated).toBe(0);
    expect(statSync(config.filePath).size).toBe(200);
  });

  it('truncates an oversized soak-boot.out with no configuration at all', () => {
    const soakBoot = join(dir, 'soak-boot.out');
    const oversized = 17 * 1024 * 1024;
    writeFileSync(soakBoot, 'x'.repeat(oversized));

    const result = runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(result.filesTruncated).toBe(1);
    expect(statSync(soakBoot).size).toBe(0);
  });

  it('leaves a large bare file that is not soak-boot.out untouched by default', () => {
    const other = join(dir, 'install.log');
    const oversized = 17 * 1024 * 1024;
    writeFileSync(other, 'x'.repeat(oversized));

    const result = runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(result.filesTruncated).toBe(0);
    expect(statSync(other).size).toBe(oversized);
  });

  it('also truncates an operator-added name from SAMURAI_LOG_BARE_TRUNCATE_NAMES', () => {
    const soakBoot = join(dir, 'soak-boot.out');
    const custom = join(dir, 'custom.out');
    writeFileSync(soakBoot, 'x'.repeat(200));
    writeFileSync(custom, 'x'.repeat(200));

    const result = runEntrypointLogRetention(
      sinkConfig(),
      { log: () => {} },
      {
        SAMURAI_LOG_BARE_TRUNCATE_BYTES: '100',
        SAMURAI_LOG_BARE_TRUNCATE_NAMES: 'custom.out',
      },
    );

    expect(result.filesTruncated).toBe(2);
    expect(statSync(soakBoot).size).toBe(0);
    expect(statSync(custom).size).toBe(0);
  });

  it('is called from the entrypoint guard', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    const guardIndex = source.indexOf('if (process.argv[1] !== undefined');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(source.slice(guardIndex)).toMatch(/^\s*runEntrypointLogRetention\(/m);
  });
});

describe('withSaxoSessionStop', () => {
  function fakeTokenSource(record: (event: string) => void): SaxoTokenSource {
    return {
      getAccessToken: async () => 'unused-in-this-test',
      sessionState: () => ({
        status: 'active',
        accessTokenExpiresAt: '2026-09-15T12:20:00.000Z',
        refreshTokenExpiresAt: '2026-09-15T12:40:00.000Z',
        failedAttempts: 0,
      }),
      stop: async () => {
        record('token-source-stop');
      },
    };
  }

  it('stops the token refresher AFTER the orchestrator has drained, keeping the rest of the surface', async () => {
    const calls: string[] = [];
    const orchestrator = {
      universe: [{ asset: 'SPY' }],
      stop: async () => {
        calls.push('orchestrator-stop');
      },
    } as unknown as ProductionOrchestrator;

    const wrapped = withSaxoSessionStop(
      orchestrator,
      fakeTokenSource((e) => calls.push(e)),
    );
    await wrapped.stop();

    expect(calls).toEqual(['orchestrator-stop', 'token-source-stop']);
    expect(wrapped.universe).toBe(orchestrator.universe);
  });

  it('does not resolve until the token source has finished its own shutdown', async () => {
    let releaseSource = (): void => {};
    const sourceFinished = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    let stopResolved = false;
    const orchestrator = { stop: async () => {} } as unknown as ProductionOrchestrator;
    const tokenSource: SaxoTokenSource = {
      ...fakeTokenSource(() => {}),
      stop: () => sourceFinished,
    };

    const pending = withSaxoSessionStop(orchestrator, tokenSource)
      .stop()
      .then(() => {
        stopResolved = true;
      });
    await Promise.resolve();

    expect(stopResolved).toBe(false);

    releaseSource();
    await pending;

    expect(stopResolved).toBe(true);
  });
});
