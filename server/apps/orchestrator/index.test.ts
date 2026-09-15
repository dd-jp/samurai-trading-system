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

/**
 * `missingCredentialEnvVars` reads `savedSessionExists(tokenFilePath('sim'))`
 * against the REAL filesystem (#1523) — a developer machine with a live
 * `yarn saxo:login` session on disk (`data/saxo-tokens/sim.json`, gitignored)
 * flips the saved-session branch underneath every test below that exercises
 * the `saxo` venue without injecting a broker, independent of what that test
 * sets up. Pinned false here so those tests assert on the no-saved-session
 * path they were written against; `credentialRequirements()` is exercised
 * directly with an explicit `savedSaxoSession` where the true branch matters.
 */
vi.mock('../../pipeline/execution/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pipeline/execution/index.js')>();
  return { ...actual, savedSessionExists: vi.fn(() => false) };
});

/**
 * See the twin in `startup.test.ts`. Resolve arm of the `.then(…, …)` pairs
 * below, so `error` types as `Error` instead of the
 * `Error | ProductionOrchestrator` union the old `.catch(e => e as Error)`
 * produced — and so a guard that stopped rejecting fails by name rather than
 * by an `undefined.message`.
 */
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
    // `backtest` auto-approves every HITL gate and `live` spends real money,
    // so a typo must not reach VerdictImpl/ExecutionImpl as an opaque string
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
    // should ever move this value
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
    // implementation, and the list is the contract
    expect(REQUIRED_INJECTED_CONFIG).toContain('riskConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('verdictConfig');
    expect(REQUIRED_INJECTED_CONFIG).toContain('executionConfig');
    expect(new Set(REQUIRED_INJECTED_CONFIG).size).toBe(REQUIRED_INJECTED_CONFIG.length);

    // The other half of the contract: a seam that HAS an in-repo
    // implementation must not stay on this list, or the entrypoint keeps
    // demanding something the composition root can build for itself. These
    // three left the list when #273/#286 (Alpaca HTTP clients) and #276
    // (AccountStateProvider) landed
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
    // transport remains on this list. `universe` is the one deliberate
    // exception (#738): not a per-stage tuning value, but a second config the
    // same list-and-name mechanism is reused for, because the alternative was
    // an equities-only default resolving on a closed session into an EMPTY
    // tick plan indistinguishable from a healthy no-trade run — see
    // `startFromEnvironment`'s own doc comment on `REQUIRED_INJECTED_CONFIG`
    expect(
      [...REQUIRED_INJECTED_CONFIG]
        .filter((key) => key !== 'universe')
        .every((key) => key.endsWith('Config')),
    ).toBe(true);
    expect(REQUIRED_INJECTED_CONFIG).toContain('universe');
  });

  it('does not still claim the trade-channel/HITL transports are unimplemented (#323)', async () => {
    // #275 landed a real `TelegramBotApiClient`, so the guard's original text
    // was describing a codebase that no longer exists. An error message that
    // is confidently out of date is worse than a terse one: it sends an
    // operator looking for work that is already done
    const error = await startFromEnvironment().then(
      resolvedUnexpectedly,
      (e: unknown) => e as Error,
    );

    expect(error.message).not.toMatch(/still have no implementation/i);
    expect(error.message).toContain('TelegramBotApiClient');
    // And it points at the way out that now exists
    expect(error.message).toContain('paperStartingProfile');
  });

  it('is satisfied by the checked-in paper profile', () => {
    // The claim the whole ticket rests on: the profile covers the guard
    // exactly, with nothing left over for the entrypoint to invent
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
    'NOUS_API_KEY',
    'NOUS_BASE_URL',
    // Not required by the pre-flight, but cleared between cases: they can
    // SATISFY `NOUS_API_KEY`, so one left behind would mask a missing key
    'NOUS_DEBATE_API_KEY',
    'NOUS_SENTIMENT_API_KEY',
    // Required only by the `saxo` venue cases below, cleared with the rest so
    // one left behind cannot mask a missing token
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
    // Each client refuses to be built without its own key, but they are
    // constructed in sequence — so without this pre-flight an unconfigured
    // host learns about exactly one variable per attempt
    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
      'NOUS_API_KEY',
      'NOUS_BASE_URL',
    ]);
  });

  it('treats an empty value as missing, matching the tracked .env placeholders', () => {
    // `.env` ships `ALPACA_API_KEY=` and `--env-file` turns that into `''`,
    // not `undefined`. Both mean "not configured", and both Alpaca clients
    // already reject an empty string
    process.env.ALPACA_API_KEY = '';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['ALPACA_API_KEY']);
  });

  it('treats a whitespace-only value as missing too', () => {
    // Same rule the alert transport applies at its own read (#342 follow-up):
    // a variable holding nothing but whitespace is not configured. Without
    // this the two disagree — the pre-flight reports a clean environment and
    // `buildAlertChannels` then throws about the same variable one step later,
    // defeating the whole point of naming every missing one at once
    process.env.ALPACA_API_KEY = ' ';
    process.env.ALPACA_API_SECRET = '\n';
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([
      'ALPACA_API_KEY',
      'ALPACA_API_SECRET',
    ]);
  });

  /**
   * The "a key per model" setup ADR-0009 was asked for, checked on the path
   * that actually gates a boot.
   *
   * `nousCredentials` resolves `NOUS_<ROLE>_API_KEY` before `NOUS_API_KEY`, so
   * an operator who sets only per-role keys has configured the run completely.
   * Before `alternatives`, this pre-flight still demanded `NOUS_API_KEY` and
   * refused to start over a variable nothing would have read — and a test that
   * builds components directly cannot catch it, because that path never runs
   * the pre-flight.
   */
  it('accepts a per-role Nous key in place of the shared one', () => {
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_BASE_URL = 'set';
    process.env.NOUS_DEBATE_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual([]);
  });

  it('still reports the shared key when no per-role key is set either', () => {
    // The reported name is `NOUS_API_KEY` rather than all three, because it is
    // the one that configures every role at once
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_BASE_URL = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['NOUS_API_KEY']);
  });

  it('does not let a per-role key substitute for the base URL', () => {
    // There is no default endpoint in source, so nothing resolves without it
    process.env.ALPACA_API_KEY = 'set';
    process.env.ALPACA_API_SECRET = 'set';
    process.env.NOUS_SENTIMENT_API_KEY = 'set';

    expect(missingCredentialEnvVars({}, 'log-only', 'paper', 'alpaca')).toEqual(['NOUS_BASE_URL']);
  });

  it('does not demand credentials for clients the caller injected', () => {
    // A test or a non-Alpaca composition root supplying its own clients must
    // not be asked for keys it will never use
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
    // `buildProductionComponents` still builds the Alpaca wire client on this
    // config — `AccountStateProvider` reads `GET /v2/account` through it even
    // when `ProductionConfig.broker` is a simulated adapter, and only an
    // injected `accountState` retires that second call site (#1400 made the
    // construction lazy, not absent). Skipping the check on `broker` alone
    // would move the failure back to a deep stack trace inside construction
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
    // Before #1509 a Saxo run had to be handed a whole `accountState`, so this
    // pre-flight keyed the Alpaca pair off that. A Saxo run now builds its own
    // GBP-native funding read, and `buildProductionComponents` constructs the
    // Alpaca wire client lazily — so demanding the pair here would block a boot
    // on keys for a transport the run never opens (#1400's complaint)
    process.env.NOUS_API_KEY = 'set';
    process.env.NOUS_BASE_URL = 'set';
    process.env.SAXO_SIM_ACCESS_TOKEN = 'set';

    // `dataSource` covers the OTHER half of the pair — Alpaca still serves
    // this run's bars otherwise (#895 owes the LSE mark source), and that half
    // is a real requirement, not the one under test here
    expect(
      missingCredentialEnvVars({ dataSource: {} as never }, 'log-only', 'paper', 'saxo'),
    ).toEqual([]);
  });

  it('demands Alpaca keys again when an injected Saxo client suppresses that read', () => {
    // `startFromEnvironment` builds the funding read only when it also built
    // the client. A caller that injected its own wire client gets neither, so
    // the account read falls back to Alpaca's and the keys are live again
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

  /**
   * #1523. The saved-session branch reads no pasted token but hard-requires
   * the app credentials — `resolveSaxoOAuthConfig` throws on a missing
   * `SAXO_SIM_APP_KEY`, and every refresh re-sends the pair as Basic auth.
   * Asserted against the table's own predicates rather than through
   * `missingCredentialEnvVars`, which reads the real `data/saxo-tokens/sim.json`
   * path: this suite must never depend on, create, or clobber the operator's
   * saved session.
   */
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
    // The mode is passed in rather than read from `process.env` here on
    // purpose: what this pre-flight reports must not depend on ambient state
    // that a sibling test could leave behind
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
    // `undefined` — the caller injected every alert channel, so no transport
    // credential is needed either
    expect(missingCredentialEnvVars({}, undefined, 'paper', 'alpaca')).not.toContain(
      'TELEGRAM_BOT_TOKEN',
    );
  });

  it('drops the heartbeat chat id when the caller injected its own heartbeat channel (#342)', () => {
    // The separate destination exists so an operator can mute the heartbeat
    // without muting escalations. A caller supplying its own channel has
    // already decided where heartbeats go, so demanding the variable would be
    // asking for one this run never reads — the same precision the Alpaca and
    // Anthropic entries above apply
    expect(
      missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram', 'paper', 'alpaca'),
    ).not.toContain('TELEGRAM_HEARTBEAT_CHAT_ID');
    // ...and the escalation chat is still required: that is the channel the
    // injected heartbeat does not cover
    expect(
      missingCredentialEnvVars({ heartbeatChannel: {} as never }, 'telegram', 'paper', 'alpaca'),
    ).toContain('TELEGRAM_CHAT_ID');
  });
});

describe('storePathEncodesTradingMode', () => {
  // The predicate behind the #330 startup warning. Worth its own tests
  // because it is what decides when the warning STOPS: it is written against
  // the shape #168 asks for, so re-keying the path to mode makes it true and
  // the warning silences itself, rather than someone having to remember to
  // delete it
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
    // paper file as correctly keyed
    expect(storePathEncodesTradingMode('data/samurai-paper.sqlite', 'live')).toBe(false);
    expect(storePathEncodesTradingMode('data/samurai-live.sqlite', 'paper')).toBe(false);
  });

  it('reads the filename only, not the directories above it', () => {
    // A developer whose checkout happens to sit under `~/live/...` must not
    // silence the warning by accident
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
    // `sharedStorePath` reads SAMURAI_MODE, so a programmatic caller passing
    // `mode: 'live'` on a host whose environment still says `paper` would write
    // live state into the paper database. This was a warn while the path was
    // keyed off NODE_ENV and every filename failed the check; now that it
    // normally passes, the one case that fails it is already wrong
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
    // Filename only — the path can carry a home directory, and a startup error
    // is not the place to disclose one
    expect(error.message).not.toContain('/home/me');
  });
});

describe('buildShutdownHandler', () => {
  /** Records the effects the handler would have had on the real process */
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

    // Still draining: exiting here is the mid-pass exit #209 exists to detect
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
    // reach stderr, because the config holds API credentials
    const secretive = Object.assign(new Error('drain failed'), { apiKey: 'sk-live-must-not-leak' });
    const { errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(secretive) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    // Both halves matter: the message must be reported, and only the message
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
          // Ctrl-C would exit 0 straight through the first, still-running drain
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
  /** Captures the handlers instead of attaching them to the real process */
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
      // The constraint this handler exists to hold: it is NOT a swallow. A
      // trading process in an unknown state with open positions must stop —
      // restart-time reconciliation (#209) is built for a death mid-pass;
      // nothing is built for trading on after an exception nobody saw
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
    // The escalation `JsonLogger` performs when both its sinks are gone lands
    // here, so this handler must not be the thing that throws
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
    // Same posture as the startup catch and `buildShutdownHandler`: a
    // config-bearing error must not put credentials on stderr
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

  /** The whole point of the helper: the swept directory comes from the sink path */
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

  // #1206: the shape #1116's own audit named as still unbounded — a bare,
  // undated name a shell redirect writes (`soak-boot.out`), which
  // `isArchivedLogName` refuses to unlink at any age. This is the sweep's
  // OTHER path for it, driven end to end through the real entrypoint helper
  // rather than `sweepStaleLogs` directly, so the env-var derivation
  // (`SAMURAI_LOG_BARE_TRUNCATE_BYTES`) is covered too
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

  // #1281 review, round 2: the earlier revision of this fix (round 1) made
  // the threshold opt-in specifically so a default-on setting could never
  // reach a file this process does not recognise — sound against the
  // blast-radius hazard, but it also meant #1206's own file stayed exactly
  // as unbounded as before #1206 in every deployment that never set the
  // variable, which — grepped across this repo — is every deployment. This
  // proves the reversal: driven through the real entrypoint helper, with NO
  // env var of any kind set, `soak-boot.out` itself — the one file the
  // ticket names — is bounded automatically, because `bareTruncateNames`
  // defaults to it and `bareTruncateBytes` defaults on again
  //
  // The fixture is deliberately larger than `DEFAULT_BARE_TRUNCATE_BYTES`
  // (16 MiB, `log-retention.ts`): a small fixture would pass this assertion
  // whether the mechanism ran or not, so it would not actually distinguish
  // the fix from a regression that silently disables it again
  it('truncates an oversized soak-boot.out with no configuration at all', () => {
    const soakBoot = join(dir, 'soak-boot.out');
    const oversized = 17 * 1024 * 1024; // > 16 MiB DEFAULT_BARE_TRUNCATE_BYTES
    writeFileSync(soakBoot, 'x'.repeat(oversized));

    const result = runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(result.filesTruncated).toBe(1);
    expect(statSync(soakBoot).size).toBe(0);
  });

  // The other half of the same reversal: a default-on threshold is only safe
  // because `bareTruncateNames` still narrows WHICH bare file it can reach
  // `install.log` is a real macOS system log the round-1 review found
  // matching the old, unscoped predicate — this proves it stays untouched
  // even with the threshold back to default-on and no config set at all
  it('leaves a large bare file that is not soak-boot.out untouched by default', () => {
    const other = join(dir, 'install.log');
    const oversized = 17 * 1024 * 1024;
    writeFileSync(other, 'x'.repeat(oversized));

    const result = runEntrypointLogRetention(sinkConfig(), { log: () => {} }, {});

    expect(result.filesTruncated).toBe(0);
    expect(statSync(other).size).toBe(oversized);
  });

  // The allowlist is additive, not a replacement — an operator's own extra
  // bare name is reachable ALONGSIDE soak-boot.out, not instead of it
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

  /**
   * The enforcement, not the construction: the helper above only runs on a
   * real boot if the entrypoint guard calls it, and that guard executes only
   * under `npm run orchestrator` — no in-process caller can reach it. So the
   * assertion is over the guard's own source text, sliced from the
   * `import.meta.url` line so the exported declaration cannot satisfy it.
   * Precedent for reading a source file in a test:
   * `pipeline/analysts/analyst-prompt-cost.test.ts`.
   */
  it('is called from the entrypoint guard', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    const guardIndex = source.indexOf('if (process.argv[1] !== undefined');

    expect(guardIndex).toBeGreaterThan(-1);
    // Anchored to the start of a line so a commented-out or otherwise
    // disabled call fails: a `toContain` on the bare call text passes on
    // `// runEntrypointLogRetention(...)`, which is the exact state this
    // asserts against — the guard runs only under `node index.js`, so no
    // in-process test can observe the call's effect instead
    expect(source.slice(guardIndex)).toMatch(/^\s*runEntrypointLogRetention\(/m);
  });
});

/**
 * #1523. `startFromEnvironment` cannot reach this offline — the Saxo arm needs
 * the venue resolved and a token source built — so the spread is asserted
 * directly.
 */
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

  /**
   * The drain still sends Saxo requests (flatten, cancel), so the refresher
   * has to outlive it — a source stopped first stops renewing, and a tick that
   * outlives the refresh lead would drain on an expired bearer
   */
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

  /**
   * `buildShutdownHandler` calls `effects.exit(0)` the moment this resolves,
   * so a `stop()` that is not awaited kills the process mid-rotation — and
   * Saxo invalidated the previous refresh token when it issued the one in
   * flight, so that is a stranded session, not a retry
   */
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
