/**
 * Entrypoint tests (#236). The value here is the fail-fast contract: an
 * operator running `npm run orchestrator` against a half-wired environment
 * must get a message naming what is missing, before anything touches a
 * broker — not a process that starts and trades on invented defaults.
 *
 * Importing this module must also be side-effect free (it is the package's
 * export surface as well as the entrypoint); every test below relies on that
 * implicitly, since a top-level start would hang the suite.
 */
import {
  buildShutdownHandler,
  missingCredentialEnvVars,
  paperStartingProfile,
  REQUIRED_INJECTED_CONFIG,
  startFromEnvironment,
  storePathEncodesTradingMode,
  warnIfStorePathIgnoresMode,
} from './index.js';
import type { Logger } from './types.js';

describe('startFromEnvironment', () => {
  it('refuses to start with nothing wired, naming every missing dependency', async () => {
    await expect(startFromEnvironment()).rejects.toThrow(/cannot start/i);

    const error = await startFromEnvironment().catch((e: unknown) => e as Error);
    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(error.message).toContain(key);
    }
  });

  it('names only the dependencies that are actually missing', async () => {
    const error = await startFromEnvironment({
      llmClient: {} as never,
      traderConfig: {} as never,
    }).catch((e: unknown) => e as Error);

    expect(error.message).not.toMatch(/\bllmClient\b/);
    expect(error.message).not.toMatch(/\btraderConfig\b/);
    expect(error.message).toContain('riskConfig');
  });

  it('rejects an unrecognised SAMURAI_MODE rather than casting it through', async () => {
    // `backtest` auto-approves every HITL gate and `live` spends real money,
    // so a typo must not reach VerdictImpl/ExecutionImpl as an opaque string.
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
    // Pinned deliberately (#355, per #342 follow-up docs on parseMode): unlike
    // TELEGRAM_BOT_TOKEN and the chat ids, SAMURAI_MODE must stay raw. If this
    // ever starts trimming, 'live ' stops being a hard refusal and becomes a
    // real-money path — the opposite direction a "helpful" normalization fix
    // should ever move this value.
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
    // Guards against a future field being added to ProductionConfig as a
    // silently-optional dependency: these are the seams with no in-repo
    // implementation, and the list is the contract.
    expect(REQUIRED_INJECTED_CONFIG).toContain('riskConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('verdictConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('executionConfig');
    expect(new Set(REQUIRED_INJECTED_CONFIG).size).toBe(REQUIRED_INJECTED_CONFIG.length);

    // The other half of the contract: a seam that HAS an in-repo
    // implementation must not stay on this list, or the entrypoint keeps
    // demanding something the composition root can build for itself. These
    // three left the list when #273/#286 (Alpaca HTTP clients) and #276
    // (AccountStateProvider) landed.
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaBrokerClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaDataClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('accountState');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('volatility');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('heartbeatChannel');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('approvals');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('orphanAlerts');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('ciiScoreProvider');

    // What is left is exactly the per-stage tuning config, which every stage
    // spec says is tuned in paper trading rather than checked in — no
    // transport remains on this list.
    expect([...REQUIRED_INJECTED_CONFIG].every((key) => key.endsWith('Config'))).toBe(true);
  });

  it('does not still claim the trade-channel/HITL transports are unimplemented (#323)', async () => {
    // #275 landed a real `TelegramBotApiClient`, so the guard's original text
    // was describing a codebase that no longer exists. An error message that
    // is confidently out of date is worse than a terse one: it sends an
    // operator looking for work that is already done.
    const error = await startFromEnvironment().catch((e: unknown) => e as Error);

    expect(error.message).not.toMatch(/still have no implementation/i);
    expect(error.message).toContain('TelegramBotApiClient');
    // And it points at the way out that now exists.
    expect(error.message).toContain('paperStartingProfile');
  });

  it('is satisfied by the checked-in paper profile', () => {
    // The claim the whole ticket rests on: the profile covers the guard
    // exactly, with nothing left over for the entrypoint to invent.
    const profile = paperStartingProfile('paper');

    expect(REQUIRED_INJECTED_CONFIG.filter((key) => profile[key] === undefined)).toEqual([]);
  });

  it('does NOT default to the paper profile — an unwired caller still fails', async () => {
    // Defaulting `injected` to the profile would make the guard above
    // unfalsifiable and let any programmatic caller silently inherit values
    // nobody chose for it. The entrypoint passes the profile explicitly
    // instead. This is the test that would catch that shortcut.
    await expect(startFromEnvironment()).rejects.toThrow(/required dependencies are not wired/i);
  });
});

describe('missingCredentialEnvVars', () => {
  const CREDENTIALS = [
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_ALLOWED_USER_IDS',
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
    // Each client refuses to be built without its own key, but they are
    // constructed in sequence — so without this pre-flight an unconfigured
    // host learns about exactly one variable per attempt.
    expect(missingCredentialEnvVars({}, 'log-only')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('treats an empty value as missing, matching the tracked .env placeholders', () => {
    // `.env` ships `ALPACA_API_KEY=` and `--env-file` turns that into `''`,
    // not `undefined`. Both mean "not configured", and both Alpaca clients
    // already reject an empty string.
    process.env.ALPACA_API_KEY = '';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.ANTHROPIC_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only')).toEqual(['ALPACA_API_KEY']);
  });

  it('treats a whitespace-only value as missing too', () => {
    // Same rule the alert transport applies at its own read (#342 follow-up):
    // a variable holding nothing but whitespace is not configured. Without
    // this the two disagree — the pre-flight reports a clean environment and
    // `buildAlertChannels` then throws about the same variable one step later,
    // defeating the whole point of naming every missing one at once.
    process.env.ALPACA_API_KEY = ' ';
    process.env.ALPACA_API_SECRET = '\n';
    process.env.ANTHROPIC_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
    ]);
  });

  it('does not demand credentials for clients the caller injected', () => {
    // A test or a non-Alpaca composition root supplying its own clients must
    // not be asked for keys it will never use.
    expect(
      missingCredentialEnvVars(
        {
          alpacaBrokerClient: {} as never,
          dataSource: {} as never,
          llmClient: {} as never,
        },
        'log-only',
      ),
    ).toEqual([]);
  });

  it('still demands Alpaca keys when only the broker ADAPTER is overridden', () => {
    // `buildProductionComponents` builds the Alpaca wire client
    // unconditionally — `AccountStateProvider` reads `GET /v2/account`
    // through it even when `ProductionConfig.broker` is a simulated adapter.
    // Skipping the check on `broker` alone would move the failure back to a
    // deep stack trace inside construction.
    expect(
      missingCredentialEnvVars({ broker: {} as never, llmClient: {} as never }, 'log-only'),
    ).toEqual(['ALPACA_API_KEY', 'ALPACA_API_SECRET']);
  });

  it('never returns a credential VALUE, only its variable name', () => {
    process.env.ALPACA_API_KEY = 'super-secret-key';
    process.env.TELEGRAM_BOT_TOKEN = 'super-secret-bot-token';

    expect(missingCredentialEnvVars({}, 'telegram').join(' ')).not.toContain('super-secret-key');
    expect(missingCredentialEnvVars({}, 'telegram').join(' ')).not.toContain(
      'super-secret-bot-token',
    );
  });

  it('demands the Telegram variables only under the unattended alerts mode (#322)', () => {
    // The mode is passed in rather than read from `process.env` here on
    // purpose: what this pre-flight reports must not depend on ambient state
    // that a sibling test could leave behind.
    expect(missingCredentialEnvVars({}, 'telegram')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'ANTHROPIC_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_ALLOWED_USER_IDS',
      'TELEGRAM_HEARTBEAT_CHAT_ID',
    ]);
    expect(missingCredentialEnvVars({}, 'log-only')).not.toContain('TELEGRAM_BOT_TOKEN');
    // `undefined` — the caller injected every alert channel, so no transport
    // credential is needed either.
    expect(missingCredentialEnvVars({}, undefined)).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('drops the heartbeat chat id when the caller injected its own heartbeat channel (#342)', () => {
    // The separate destination exists so an operator can mute the heartbeat
    // without muting escalations. A caller supplying its own channel has
    // already decided where heartbeats go, so demanding the variable would be
    // asking for one this run never reads — the same precision the Alpaca and
    // Anthropic entries above apply.
    expect(missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram')).not.toContain(
      'TELEGRAM_HEARTBEAT_CHAT_ID',
    );
    // ...and the escalation chat is still required: that is the channel the
    // injected heartbeat does not cover.
    expect(missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram')).toContain(
      'TELEGRAM_CHAT_ID',
    );
  });
});

describe('storePathEncodesTradingMode', () => {
  // The predicate behind the #330 startup warning. Worth its own tests
  // because it is what decides when the warning STOPS: it is written against
  // the shape #168 asks for, so re-keying the path to mode makes it true and
  // the warning silences itself, rather than someone having to remember to
  // delete it.
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
    // The failure that would matter most: a live process quietly accepting the
    // paper file as correctly keyed.
    expect(storePathEncodesTradingMode('data/samurai-paper.sqlite', 'live')).toBe(false);
    expect(storePathEncodesTradingMode('data/samurai-live.sqlite', 'paper')).toBe(false);
  });

  it('reads the filename only, not the directories above it', () => {
    // A developer whose checkout happens to sit under `~/live/...` must not
    // silence the warning by accident.
    expect(
      storePathEncodesTradingMode('/home/me/live/data/samurai-production.sqlite', 'live'),
    ).toBe(false);
  });
});

describe('warnIfStorePathIgnoresMode', () => {
  function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
    const entries: Parameters<Logger['log']>[0][] = [];
    return { entries, log: (entry) => entries.push(entry) };
  }

  it('warns when the resolved filename cannot distinguish paper from live (#330)', () => {
    const logger = recordingLogger();

    warnIfStorePathIgnoresMode({ dbPath: 'data/samurai-production.sqlite', mode: 'paper', logger });

    expect(logger.entries).toHaveLength(1);
    const [entry] = logger.entries;
    expect(entry?.level).toBe('warn');
    // Both facts the operator needs to act: which mode this process believes
    // it is in, and which file it is actually writing.
    expect(entry?.payload).toMatchObject({
      mode: 'paper',
      db_file: 'samurai-production.sqlite',
    });
    expect(entry?.message).toContain('#330');
  });

  it('stays silent once the path is keyed off mode', () => {
    // This is the branch that retires the warning when #330 lands.
    const logger = recordingLogger();

    warnIfStorePathIgnoresMode({ dbPath: 'data/samurai-paper.sqlite', mode: 'paper', logger });

    expect(logger.entries).toEqual([]);
  });
});

describe('buildShutdownHandler', () => {
  /** Records the effects the handler would have had on the real process. */
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

    // Still draining: exiting here is the mid-pass exit #209 exists to detect.
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
    // The startup catch has the same posture: a config-bearing error must not
    // reach stderr, because the config holds API credentials.
    const secretive = Object.assign(new Error('drain failed'), { apiKey: 'sk-live-must-not-leak' });
    const { errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(secretive) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    // Both halves matter: the message must be reported, and only the message.
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
          // A re-entrant stop() finds its timers cleared and its loop already
          // released, so it resolves at once — which is exactly how a second
          // Ctrl-C would exit 0 straight through the first, still-running drain.
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
