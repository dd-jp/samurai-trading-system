/**
 * The attended/unattended selection (#322). What these tests are really
 * guarding is a *negative*: that there is no path from an unconfigured host to
 * a running process whose alerts all go to a log nobody reads.
 */
import { openSharedStore } from '../../shared/store/index.js';
import {
  ALERT_CHANNEL_FIELDS,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
} from './alert-transport.js';
import { TradeChannelBreachAlert } from './breach-alert-channel.js';
import { Heartbeat } from './heartbeat.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';
import { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
import type { ProductionConfig } from './production.js';
import { TradeChannelResidualExposureAlert } from './residual-exposure-alert-channel.js';
import { TradeChannelThresholdClampAlert } from './threshold-clamp-alert-channel.js';
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

/** The chat the operator must keep reading — every escalation lands here. */
const ESCALATION_CHAT_ID = '-1001234567890';
/** The chat the operator is free to mute (#342) — heartbeats only. */
const HEARTBEAT_CHAT_ID = '-1009876543210';

function configureTelegramEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = SENTINEL_TOKEN;
  process.env.TELEGRAM_CHAT_ID = ESCALATION_CHAT_ID;
  process.env.TELEGRAM_ALLOWED_USER_IDS = '42';
  process.env.TELEGRAM_HEARTBEAT_CHAT_ID = HEARTBEAT_CHAT_ID;
}

/** Every `sendMessage` body the stubbed transport saw, in call order. */
function sentMessages(
  stub: ReturnType<typeof stubTelegramFetch>,
): { chat_id: string; text: string }[] {
  return stub.mock.calls.map(
    ([, init]) => JSON.parse(init.body) as { chat_id: string; text: string },
  );
}

/**
 * A stub `fetch` answering like the Bot API. `failFor` picks the chat ids the
 * bot is (say) no longer a member of: they get a 403, which
 * `isRetryableTelegramError` classifies as terminal, so the send fails once
 * rather than sleeping through a retry budget.
 */
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

/** One of each escalation, so a test can drive all three onto the wire. */
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
  idempotency_key: 'ioc-1',
  instrument: 'AAPL',
  side: 'buy' as const,
  residual_qty: 5,
  residual_qty_is_upper_bound: false,
  stop: 180.5,
  target: 195.25,
  observed_at: new Date('2026-08-04T09:00:00Z'),
};

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

  it('accepts a named mode carrying incidental whitespace from an env file', () => {
    // `SAMURAI_ALERTS=telegram\n` out of a `--env-file` or a heredoc is the
    // mode the operator typed. Refusing it produced "must be one of
    // telegram|log-only" for a value that reads as `telegram` on screen —
    // a fail-loud, but one nobody could act on. Both post-trim outcomes are
    // still values the operator wrote, so trimming invents nothing.
    process.env.SAMURAI_ALERTS = ' telegram\n';
    expect(resolveAlertsMode({})).toBe('telegram');

    process.env.SAMURAI_ALERTS = '\tlog-only ';
    expect(resolveAlertsMode({})).toBe('log-only');
  });

  it('still rejects a whitespace-only value rather than defaulting', () => {
    // Trimming must not open a path from "nothing meaningful set" to a mode.
    process.env.SAMURAI_ALERTS = '   ';

    expect(() => resolveAlertsMode({})).toThrow(/SAMURAI_ALERTS/);
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
  it('names the bot token and both chat ids — and NOT the approval allowlist (#434)', () => {
    // The heartbeat chat id joined this list in #342: a heartbeat sharing the
    // escalation chat is the alert-fatigue failure, and there is no chat id
    // this process could invent as a default.
    //
    // `TELEGRAM_ALLOWED_USER_IDS` LEFT it in #434. It was here because
    // `TelegramBotApiClient` validated it at construction — but its only
    // consumer is the inbound approval callback, and ADR-0007 turned the HITL
    // gate off, so this run forced an operator to supply a credential for a
    // seam nothing reaches. The outbound escalations on this list (orphaned go
    // verdicts, stuck fills, kill breaches, heartbeat) accept nothing FROM
    // Telegram and need no allowlist.
    expect([...TELEGRAM_ALERT_ENV_VARS]).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_HEARTBEAT_CHAT_ID',
    ]);
    expect([...TELEGRAM_ALERT_ENV_VARS]).not.toContain('TELEGRAM_ALLOWED_USER_IDS');
    expect(TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR).toBe('TELEGRAM_HEARTBEAT_CHAT_ID');
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
  it('wires every operator alert onto the real trade-channel adapters', () => {
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
    expect(channels.residualExposureAlerts).toBeInstanceOf(TradeChannelResidualExposureAlert);
    expect(channels.breachAlerts).toBeInstanceOf(TradeChannelBreachAlert);
    expect(channels.thresholdClampAlerts).toBeInstanceOf(TradeChannelThresholdClampAlert);
  });

  /**
   * The pairing that `ALERT_CHANNEL_FIELDS`-derived tests cannot catch on their
   * own: a field in that array which the telegram branch does NOT build makes
   * `resolveAlertsMode` demand `SAMURAI_ALERTS` for a channel nothing
   * constructs — so `telegram` silently falls through to production.ts's
   * log-only default while the operator believes alerts reach a phone. That is
   * the exact hole #322 exists to close, one channel down.
   */
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
    expect(channels.orphanAlerts).toBeInstanceOf(TradeChannelOrphanAlert);
  });

  it('posts escalations to the chat id TELEGRAM_CHAT_ID names', async () => {
    // Proves the env var is actually threaded through to the wire, which
    // `toBeInstanceOf` above cannot. Stubbed transport — no live call.
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

/**
 * #342. The property under test, stated once: **an operator who mutes or
 * ignores the heartbeat stream still receives every escalation.** Muting is a
 * client-side act no process can observe, so it is enforced structurally — the
 * heartbeat is delivered to a destination that holds nothing else, so muting it
 * cannot take an escalation with it. The two tests that matter are the
 * destination split and the "heartbeat chat is dead, escalations still land"
 * case; the rest guard the ways the split could be un-made by configuration.
 */
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
    // `postBreachAlert` is fire-and-forget (void, by design) — let its
    // `Promise.allSettled` settle before reading the wire.
    await new Promise((resolve) => setImmediate(resolve));

    const byChat = sentMessages(fetchStub).map((m) => m.chat_id);
    expect(byChat).toEqual([
      HEARTBEAT_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
      ESCALATION_CHAT_ID,
    ]);
    // Nothing but the heartbeat is addressed to the mutable chat — that is
    // what makes muting it safe.
    expect(sentMessages(fetchStub).filter((m) => m.chat_id === HEARTBEAT_CHAT_ID)).toHaveLength(1);
  });

  it('still delivers escalations when every heartbeat post fails', async () => {
    // The "muted" half that IS observable: a heartbeat chat the bot has been
    // kicked from. All four channels share one `TelegramBotApiClient`, so this
    // is the test that would catch a shared retry budget, circuit breaker or
    // queue letting a dead heartbeat chat take the escalations down with it.
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
    // And the heartbeat failures were not silent either.
    expect(logger.entries.filter((e) => e.message === 'heartbeat post failed')).toHaveLength(5);
  });

  it('refuses to start when the heartbeat chat IS the escalation chat', () => {
    // Configuring both to one chat re-creates #342 exactly: ~20k heartbeats
    // over the soak in the chat the escalations need. Named and refused, not
    // warned about — the operator would have to read the warning in the chat
    // they are about to mute.
    configureTelegramEnv();
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = ESCALATION_CHAT_ID;

    expect(() => telegramChannels()).toThrow(/TELEGRAM_HEARTBEAT_CHAT_ID/);
    expect(() => telegramChannels()).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('refuses to start when TELEGRAM_HEARTBEAT_CHAT_ID is unset, naming it', () => {
    // No default is inventable: there is no second chat id this process could
    // guess, and the one value it could fall back to (TELEGRAM_CHAT_ID) is the
    // bug. Backstop to `missingCredentialEnvVars`, which names it first.
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
    // Same rule as the empty string, and the one `nonEmpty` in
    // rotating-file-sink.ts already applies to `SAMURAI_LOG_MAX_FILES`: a
    // value that is nothing but whitespace is "not configured", never a
    // destination. `chat_id: "  "` is a Bot API 400 discovered on the first
    // beat, days into an unattended soak.
    configureTelegramEnv();
    process.env.TELEGRAM_HEARTBEAT_CHAT_ID = ' \n\t ';

    expect(() => telegramChannels()).toThrow(/TELEGRAM_HEARTBEAT_CHAT_ID/);
    // And refused as ABSENT rather than as the same-chat case: the operator's
    // fix differs (set the variable vs. create a second chat).
    expect(() => telegramChannels()).toThrow(/is not set/);
  });

  it('refuses a heartbeat chat that equals the escalation chat but for whitespace', () => {
    // The hole kimi-3-review found in #353: raw `===` meant one trailing
    // newline out of an env file — `TELEGRAM_HEARTBEAT_CHAT_ID=-100…\n` —
    // slipped past the refusal while still addressing the escalation chat.
    // The guard would report safe and the property it exists to protect
    // (muting the beat cannot mute an escalation) would be gone. Direct
    // precedent: #293/#320, where a whitespace-sensitive `startsWith` let
    // ' https://api.alpaca.markets' walk past a live-host guard.
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
    // The mirror image: the padding can sit on either variable, and only
    // normalizing one of them leaves the other half of the hole open.
    configureTelegramEnv();
    process.env.TELEGRAM_CHAT_ID = ` ${HEARTBEAT_CHAT_ID} `;

    expect(() => telegramChannels()).toThrow(/is the same chat as/);
  });

  it('hands the adapters normalized chat ids, never the padded env value', async () => {
    // The second half of the fix, and a bug in its own right: a trailing
    // newline inside a `chat_id` is a Bot API 400, so a padded id that IS
    // distinct from the escalation chat would pass the refusal and then fail
    // every single send. Normalize once, at the read, and both the comparison
    // and the wire see the same value.
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
    // Nothing this module builds would post to it, so demanding it — or
    // refusing a value that happens to equal the escalation chat — would be a
    // check on a decision the caller already made for itself.
    configureTelegramEnv();
    delete process.env.TELEGRAM_HEARTBEAT_CHAT_ID;

    const channels = buildAlertChannels({
      alertsMode: 'telegram',
      injected: { heartbeatChannel: { postHeartbeat: vi.fn(async () => {}) } },
      db: openSharedStore(':memory:'),
      logger: recordingLogger(),
    });

    expect(channels.heartbeatChannel).toBeUndefined();
    expect(channels.orphanAlerts).toBeInstanceOf(TradeChannelOrphanAlert);
  });

  it('does not claim the heartbeat chat when the caller supplied its own channel', () => {
    // The startup line is what an operator checks their alerting against
    // before a 14-day soak, so it must not name a destination no beat reaches.
    // On this path TELEGRAM_HEARTBEAT_CHAT_ID is never read and no
    // `TradeChannelHeartbeat` is built — the injected channel decides where the
    // beat goes, and this module cannot know where that is.
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
    // The variable may be MENTIONED (saying it is not read is useful); what it
    // must not do is assert the beat is going there.
    expect(entry?.message).not.toMatch(/heartbeat goes to TELEGRAM_HEARTBEAT_CHAT_ID/);
    expect(entry?.message).toContain('ProductionConfig.heartbeatChannel');
    // The escalation half of the line is unchanged and still true.
    expect(entry?.message).toContain('TELEGRAM_CHAT_ID');
  });

  it('claims the heartbeat chat only when it is the one actually wired', () => {
    // The other side of the branch above: when this module built the channel,
    // the line names the destination it gave it.
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
