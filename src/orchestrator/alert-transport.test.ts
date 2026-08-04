/**
 * The attended/unattended selection (#322). What these tests are really
 * guarding is a *negative*: that there is no path from an unconfigured host to
 * a running process whose alerts all go to a log nobody reads.
 */
import { openSharedStore } from '../shared/store/index.js';
import {
  ALERT_CHANNEL_FIELDS,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
} from './alert-transport.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';
import { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
import type { ProductionConfig } from './production.js';
import type { Logger } from './types.js';
import { TradeChannelUnpricedFillAlert } from './unpriced-fill-channel.js';

/**
 * Saved and restored around EVERY test in the file, for the reason
 * `startup.test.ts` spells out: vitest reuses a worker across files, so a
 * credential left behind here is inherited by whatever runs next.
 */
const MUTATED_ENV_VARS = ['SAMURAI_ALERTS', ...TELEGRAM_ALERT_ENV_VARS] as const;
const savedEnv = new Map<string, string | undefined>();

/** A syntactically plausible bot token that is not one. Asserted absent from logs and errors. */
const SENTINEL_TOKEN = '1234567:AA-not-a-real-bot-token-sentinel';

beforeEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MUTATED_ENV_VARS) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
  const entries: Parameters<Logger['log']>[0][] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function configureTelegramEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = SENTINEL_TOKEN;
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  process.env.TELEGRAM_ALLOWED_USER_IDS = '42';
}

describe('resolveAlertsMode', () => {
  it('refuses to start when SAMURAI_ALERTS is unset, naming the variable and both values', () => {
    // The bug #322 exists to fix: absence used to mean "log-only", silently.
    expect(() => resolveAlertsMode({})).toThrow(/SAMURAI_ALERTS/);
    const error = (() => {
      try {
        resolveAlertsMode({});
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('telegram');
    expect(error?.message).toContain('log-only');
  });

  it('rejects an unrecognised value rather than falling back to the quiet one', () => {
    process.env.SAMURAI_ALERTS = 'telegam';

    expect(() => resolveAlertsMode({})).toThrow(/SAMURAI_ALERTS/);
  });

  it('accepts each of the two named modes', () => {
    process.env.SAMURAI_ALERTS = 'telegram';
    expect(resolveAlertsMode({})).toBe('telegram');

    process.env.SAMURAI_ALERTS = 'log-only';
    expect(resolveAlertsMode({})).toBe('log-only');
  });

  it('needs no mode at all when the caller injected every alert channel itself', () => {
    // Same posture as `missingCredentialEnvVars`' `satisfiedByInjection`: a
    // caller that supplied all three transports has already made this decision
    // explicitly, and must not be asked for an env var it will never consult.
    const injected = Object.fromEntries(
      ALERT_CHANNEL_FIELDS.map((field) => [field, {}]),
    ) as Partial<ProductionConfig>;

    expect(resolveAlertsMode(injected)).toBeUndefined();
  });

  it('still demands a mode when only SOME channels are injected', () => {
    // The hole this closes: injecting one channel must not exempt the other
    // two from the decision, or a partially-wired caller inherits log-only for
    // the rest by omission.
    for (const field of ALERT_CHANNEL_FIELDS) {
      expect(() => resolveAlertsMode({ [field]: {} } as Partial<ProductionConfig>)).toThrow(
        /SAMURAI_ALERTS/,
      );
    }
  });
});

describe('TELEGRAM_ALERT_ENV_VARS', () => {
  it('names the bot token, the chat id and the approval allowlist', () => {
    // The allowlist is on this list because `TelegramBotApiClient` validates it
    // at construction, not because this ticket arms the HITL gate — see the
    // module doc.
    expect([...TELEGRAM_ALERT_ENV_VARS]).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_ALLOWED_USER_IDS',
    ]);
  });
});

describe('buildAlertChannels — log-only', () => {
  it('supplies nothing, leaving the composition root its own log-only defaults', () => {
    // Deliberate: `LoggingHeartbeatChannel`/`LoggingOrphanAlertChannel`/
    // `LoggingUnpricedFillAlertChannel` are already the documented defaults in
    // production.ts. Constructing a second set here would be two places to
    // keep in sync for no behavioural difference.
    const logger = recordingLogger();

    expect(
      buildAlertChannels({
        alertsMode: 'log-only',
        injected: {},
        db: openSharedStore(':memory:'),
        logger,
      }),
    ).toEqual({});
  });

  it('logs a warn naming log-only as a degraded, attended-run-only posture', () => {
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'log-only',
      injected: {},
      db: openSharedStore(':memory:'),
      logger,
    });

    const entry = logger.entries.find((e) => e.message.includes('log-only'));
    expect(entry?.level).toBe('warn');
  });
});

describe('buildAlertChannels — telegram', () => {
  it('wires all three operator alerts onto the real trade-channel adapters', () => {
    configureTelegramEnv();
    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    expect(channels.heartbeatChannel).toBeInstanceOf(TradeChannelHeartbeat);
    expect(channels.orphanAlerts).toBeInstanceOf(TradeChannelOrphanAlert);
    expect(channels.unpricedFillAlerts).toBeInstanceOf(TradeChannelUnpricedFillAlert);
  });

  it('does not replace a channel the caller injected', () => {
    configureTelegramEnv();
    const injectedHeartbeat = { postHeartbeat: vi.fn(async () => {}) };

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: { heartbeatChannel: injectedHeartbeat },
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    expect(channels.heartbeatChannel).toBeUndefined();
    expect(channels.orphanAlerts).toBeInstanceOf(TradeChannelOrphanAlert);
  });

  it('posts to the chat id TELEGRAM_CHAT_ID names', async () => {
    // Proves the env var is actually threaded through to the wire, which
    // `toBeInstanceOf` above cannot. Stubbed transport — no live call.
    configureTelegramEnv();
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
    vi.stubGlobal('fetch', fetchStub);

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });
    await channels.heartbeatChannel?.postHeartbeat(new Date('2026-08-04T10:00:00Z'));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '-1001234567890' });
  });

  it('never writes the bot token to the startup log', async () => {
    // SECURITY. The token is a bearer credential for the whole bot; it lives in
    // every request path, so the one place it could leak is a log line or an
    // error message written around construction.
    configureTelegramEnv();
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger,
    });

    expect(JSON.stringify(logger.entries)).not.toContain(SENTINEL_TOKEN);
    // And it did log something — otherwise this assertion is vacuous.
    expect(logger.entries.some((e) => e.message.includes('telegram'))).toBe(true);
  });

  it('fails loudly, without the token, when the allowlist is malformed', () => {
    // `parseAllowedUserIds` throws at construction. The message must name the
    // variable and carry no credential — it is printed to stderr by the
    // entrypoint's startup catch.
    configureTelegramEnv();
    process.env.TELEGRAM_ALLOWED_USER_IDS = '*';

    const error = (() => {
      try {
        buildAlertChannels({
          alertsMode: 'telegram',
          injected: {},
          db: openSharedStore(':memory:'),
          logger: recordingLogger(),
        });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('TELEGRAM_ALLOWED_USER_IDS');
    expect(error?.message).not.toContain(SENTINEL_TOKEN);
  });
});
