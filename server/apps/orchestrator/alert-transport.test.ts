import { openSharedStore } from '../../shared/store/index.js';
import { ALERT_CATALOGUE, ALERT_IDS } from './alert-catalogue.js';
import {
  ALERT_CHANNEL_FIELDS,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
} from './alert-transport.js';
import { Heartbeat } from './heartbeat.js';
import type { ProductionConfig } from './production.js';
import type { Logger } from './types.js';

const MUTATED_ENV_VARS = ['SAMURAI_ALERTS', ...TELEGRAM_ALERT_ENV_VARS] as const;
const savedEnv = new Map<string, string | undefined>();

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

const ESCALATION_CHAT_ID = '-1001234567890';
const HEARTBEAT_CHAT_ID = '-1009876543210';

function configureTelegramEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = SENTINEL_TOKEN;
  process.env.TELEGRAM_CHAT_ID = ESCALATION_CHAT_ID;
  process.env.TELEGRAM_HEARTBEAT_CHAT_ID = HEARTBEAT_CHAT_ID;
}

function sentMessages(
  stub: ReturnType<typeof stubTelegramFetch>,
): { chat_id: string; text: string }[] {
  return stub.mock.calls.map(
    ([, init]) => JSON.parse(init.body) as { chat_id: string; text: string },
  );
}

function stubTelegramFetch(failFor: (chatId: string) => boolean = () => false) {
  const stub = vi.fn((_url: string, init: { body: string }) => {
    const chatId = (JSON.parse(init.body) as { chat_id: string }).chat_id;
    if (failFor(chatId)) {
      return Promise.resolve({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('{"ok":false,"description":"Forbidden: bot was kicked"}'),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

const ORPHAN = {
  trace_id: 'trace-1',
  idempotency_key: 'ioc-1',
  instrument: 'AAPL',
  verdict_timestamp: new Date('2026-08-04T09:00:00Z'),
};
const UNPRICED_FILL = {
  venue: 'alpaca',
  client_order_id: 'ioc-1',
  broker_fill_id: 'fill-1',
  leg: 'entry' as const,
  instrument: 'AAPL',
  qty: 10,
  first_seen_at: new Date('2026-08-04T09:00:00Z'),
  unpriced_for_ms: 900_000,
  age_out_ms: 900_000,
};
const BREACH = {
  breaches: ['pbo_over_max'],
  reported_at: new Date('2026-08-04T09:00:00Z'),
};
const RESIDUAL_EXPOSURE = {
  trace_id: 'fill-sync',
  idempotency_key: 'ioc-1',
  instrument: 'AAPL',
  side: 'buy' as const,
  residual_qty: 5,
  residual_qty_is_upper_bound: false,
  rearm_unsupported: false,
  stop: 180.5,
  target: 195.25,
  observed_at: new Date('2026-08-04T09:00:00Z'),
};

describe('resolveAlertsMode', () => {
  it('refuses to start when SAMURAI_ALERTS is unset, naming the variable and both values', () => {
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

  it('accepts a named mode carrying incidental whitespace from an env file', () => {
    process.env.SAMURAI_ALERTS = ' telegram\n';
    expect(resolveAlertsMode({})).toBe('telegram');

    process.env.SAMURAI_ALERTS = '\tlog-only ';
    expect(resolveAlertsMode({})).toBe('log-only');
  });

  it('still rejects a whitespace-only value rather than defaulting', () => {
    process.env.SAMURAI_ALERTS = '   ';

    expect(() => resolveAlertsMode({})).toThrow(/SAMURAI_ALERTS/);
  });

  it('needs no mode at all when the caller injected every alert channel itself', () => {
    const injected = Object.fromEntries(
      ALERT_CHANNEL_FIELDS.map((field) => [field, {}]),
    ) as Partial<ProductionConfig>;

    expect(resolveAlertsMode(injected)).toBeUndefined();
  });

  it('still demands a mode when only SOME channels are injected', () => {
    for (const field of ALERT_CHANNEL_FIELDS) {
      expect(() => resolveAlertsMode({ [field]: {} } as Partial<ProductionConfig>)).toThrow(
        /SAMURAI_ALERTS/,
      );
    }
  });
});

describe('TELEGRAM_ALERT_ENV_VARS', () => {
  it('names the bot token and both chat ids', () => {
    expect([...TELEGRAM_ALERT_ENV_VARS]).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_HEARTBEAT_CHAT_ID',
    ]);
    expect(TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR).toBe('TELEGRAM_HEARTBEAT_CHAT_ID');
  });
});

describe('buildAlertChannels — log-only', () => {
  it('supplies nothing, leaving the composition root its own log-only defaults', () => {
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
  it('wires every operator alert onto the real trade-channel adapters', () => {
    configureTelegramEnv();
    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    for (const id of ALERT_IDS) {
      expect(Object.keys(channels[id] ?? {}), id).toEqual([ALERT_CATALOGUE[id].method]);
    }
  });

  it('builds a real adapter for every field it requires a decision about', () => {
    configureTelegramEnv();
    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    for (const field of ALERT_CHANNEL_FIELDS) {
      expect(
        channels[field],
        `${field} is in ALERT_CHANNEL_FIELDS but telegram builds no adapter`,
      ).toBeDefined();
    }
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
    expect(channels.orphanAlerts).toBeDefined();
  });

  it('posts escalations to the chat id TELEGRAM_CHAT_ID names', async () => {
    configureTelegramEnv();
    const fetchStub = stubTelegramFetch();

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });
    await channels.orphanAlerts?.postOrphanAlert(ORPHAN);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sentMessages(fetchStub)[0]?.chat_id).toBe(ESCALATION_CHAT_ID);
  });

  it('never writes the bot token to the startup log', async () => {
    configureTelegramEnv();
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger,
    });

    expect(JSON.stringify(logger.entries)).not.toContain(SENTINEL_TOKEN);
    expect(logger.entries.some((e) => e.message.includes('telegram'))).toBe(true);
  });
});

describe('buildAlertChannels — heartbeat destination is separate from escalations (#342)', () => {
  function telegramChannels() {
    return buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });
  }

  it('sends the heartbeat to the heartbeat chat and every escalation to the escalation chat', async () => {
    configureTelegramEnv();
    const fetchStub = stubTelegramFetch();
    const channels = telegramChannels();

    await channels.heartbeatChannel?.postHeartbeat(new Date('2026-08-04T10:00:00Z'));
    await channels.orphanAlerts?.postOrphanAlert(ORPHAN);
    await channels.unpricedFillAlerts?.postUnpricedFillAlert(UNPRICED_FILL);
    await channels.residualExposureAlerts?.postResidualExposureAlert(RESIDUAL_EXPOSURE);
    channels.breachAlerts?.postBreachAlert(BREACH);
    await new Promise((resolve) => setImmediate(resolve));

    const byChat = sentMessages(fetchStub).map((m) => m.chat_id);
    expect(byChat).toEqual([
      HEARTBEAT_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
    ]);
    expect(sentMessages(fetchStub).filter((m) => m.chat_id === HEARTBEAT_CHAT_ID)).toHaveLength(1);
  });

  it('still delivers escalations when every heartbeat post fails', async () => {
    configureTelegramEnv();
    const fetchStub = stubTelegramFetch((chatId) => chatId === HEARTBEAT_CHAT_ID);
    const channels = telegramChannels();
    const logger = recordingLogger();
    const heartbeat = new Heartbeat(
      channels.heartbeatChannel as NonNullable<typeof channels.heartbeatChannel>,
      logger,
    );

    for (let beat = 0; beat < 5; beat += 1) {
      await heartbeat.emit({ now: () => new Date('2026-08-04T10:00:00Z') });
    }

    await expect(channels.orphanAlerts?.postOrphanAlert(ORPHAN)).resolves.toBeUndefined();
    await expect(
      channels.unpricedFillAlerts?.postUnpricedFillAlert(UNPRICED_FILL),
    ).resolves.toBeUndefined();

    const delivered = sentMessages(fetchStub).filter((m) => m.chat_id === ESCALATION_CHAT_ID);
    expect(delivered).toHaveLength(2);
    expect(logger.entries.filter((e) => e.message === 'heartbeat post failed')).toHaveLength(5);
  });

  it('refuses to start when the heartbeat chat IS the escalation chat', () => {
    configureTelegramEnv();
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = ESCALATION_CHAT_ID;

    expect(() => telegramChannels()).toThrow(/TELEGRAM_HEARTBEAT_CHAT_ID/);
    expect(() => telegramChannels()).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('refuses to start when TELEGRAM_HEARTBEAT_CHAT_ID is unset, naming it', () => {
    configureTelegramEnv();
    delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;

    const error = (() => {
      try {
        telegramChannels();
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('TELEGRAM_HEARTBEAT_CHAT_ID');
    expect(error?.message).not.toContain(SENTINEL_TOKEN);
  });

  it('treats an empty TELEGRAM_HEARTBEAT_CHAT_ID as unset', () => {
    configureTelegramEnv();
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = '';

    expect(() => telegramChannels()).toThrow(/TELEGRAM_HEARTBEAT_CHAT_ID/);
  });

  it('treats a whitespace-only TELEGRAM_HEARTBEAT_CHAT_ID as unset, not as a chat', () => {
    configureTelegramEnv();
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = ' \n\t ';

    expect(() => telegramChannels()).toThrow(/TELEGRAM_HEARTBEAT_CHAT_ID/);
    expect(() => telegramChannels()).toThrow(/is not set/);
  });

  it('refuses a heartbeat chat that equals the escalation chat but for whitespace', () => {
    for (const padded of [
      `${ESCALATION_CHAT_ID}\n`,
      ` ${ESCALATION_CHAT_ID}`,
      `\t${ESCALATION_CHAT_ID} `,
    ]) {
      configureTelegramEnv();
      process.env.TELEGRAM_HEARTBEAT_CHAT_ID = padded;

      expect(() => telegramChannels()).toThrow(/is the same chat as/);
    }
  });

  it('refuses an escalation chat that equals the heartbeat chat but for whitespace', () => {
    configureTelegramEnv();
    process.env.TELEGRAM_CHAT_ID = ` ${HEARTBEAT_CHAT_ID} `;

    expect(() => telegramChannels()).toThrow(/is the same chat as/);
  });

  it('hands the adapters normalized chat ids, never the padded env value', async () => {
    configureTelegramEnv();
    process.env.TELEGRAM_CHAT_ID = ` ${ESCALATION_CHAT_ID}\n`;
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = `\t${HEARTBEAT_CHAT_ID} `;
    const fetchStub = stubTelegramFetch();
    const channels = telegramChannels();

    await channels.heartbeatChannel?.postHeartbeat(new Date('2026-08-04T10:00:00Z'));
    await channels.orphanAlerts?.postOrphanAlert(ORPHAN);

    expect(sentMessages(fetchStub).map((m) => m.chat_id)).toEqual([
      HEARTBEAT_CHAT_ID,
      ESCALATION_CHAT_ID,
    ]);
  });

  it('asks for no heartbeat chat at all when the caller injected the heartbeat channel', () => {
    configureTelegramEnv();
    delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: { heartbeatChannel: { postHeartbeat: vi.fn(async () => {}) } },
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    expect(channels.heartbeatChannel).toBeUndefined();
    expect(channels.orphanAlerts).toBeDefined();
  });

  it('does not claim the heartbeat chat when the caller supplied its own channel', () => {
    configureTelegramEnv();
    delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'telegram',
      injected: { heartbeatChannel: { postHeartbeat: vi.fn(async () => {}) } },
      db: openSharedStore(':memory:'),
      logger,
    });

    const entry = logger.entries.find((e) => e.message.includes(`${'SAMURAI_ALERTS'}=telegram`));
    expect(entry?.payload).toMatchObject({ heartbeat: 'caller-supplied' });
    expect(entry?.message).not.toMatch(/heartbeat goes to TELEGRAM_HEARTBEAT_CHAT_ID/);
    expect(entry?.message).toContain('ProductionConfig.heartbeatChannel');
    expect(entry?.message).toContain('TELEGRAM_CHAT_ID');
  });

  it('claims the heartbeat chat only when it is the one actually wired', () => {
    configureTelegramEnv();
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger,
    });

    const entry = logger.entries.find((e) => e.message.includes(`${'SAMURAI_ALERTS'}=telegram`));
    expect(entry?.payload).toMatchObject({ heartbeat: 'separate-chat' });
    expect(entry?.message).toMatch(/heartbeat goes to TELEGRAM_HEARTBEAT_CHAT_ID/);
  });

  it('logs the separation without disclosing either chat id or the token', () => {
    configureTelegramEnv();
    const logger = recordingLogger();

    buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db: openSharedStore(':memory:'),
      logger,
    });

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(SENTINEL_TOKEN);
    expect(serialized).not.toContain(HEARTBEAT_CHAT_ID);
    expect(serialized).not.toContain(ESCALATION_CHAT_ID);
    expect(logger.entries.some((e) => e.message.includes('TELEGRAM_HEARTBEAT_CHAT_ID'))).toBe(true);
  });
});

describe('buildAlertChannels — durable delivery-failure recording (#1108)', () => {
  it('records a permanently-undeliverable escalation in the real alert_delivery_failures table', async () => {
    configureTelegramEnv();
    stubTelegramFetch((chatId) => chatId === ESCALATION_CHAT_ID);
    const db = openSharedStore(':memory:');

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: {},
      db,
      logger: recordingLogger(),
    });
    await expect(channels.orphanAlerts?.postOrphanAlert(ORPHAN)).rejects.toThrow();

    const rows = db.prepare('SELECT chat_id, method FROM alert_delivery_failures').all() as {
      chat_id: string;
      method: string;
    }[];
    expect(rows).toEqual([{ chat_id: ESCALATION_CHAT_ID, method: 'sendMessage' }]);
  });
});
