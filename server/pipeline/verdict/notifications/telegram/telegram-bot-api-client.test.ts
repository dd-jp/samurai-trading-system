import { SqliteAlertDeliveryLog } from '../../../../apps/orchestrator/index.js';
import type { LogEntry, Logger, RetryConfig } from '../../../../shared/index.js';
import { MAX_ERROR_BODY_CHARS } from '../../../../shared/index.js';
import { openSharedStore } from '../../../../shared/store/index.js';
import type { AlertDeliveryFailureLog } from './telegram-bot-api-client.js';
import {
  capOutboundText,
  TELEGRAM_MAX_MESSAGE_CHARS,
  TelegramBotApiClient,
} from './telegram-bot-api-client.js';
import { classifyTelegramThrown, TelegramProviderError } from './telegram-errors.js';

const FAKE_TOKEN = '1234567:test-fake-bot-token';
const CHAT_ID = '-1009876543210';

function okResponse(result: unknown = true): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => ({ ok: true, result }),
    text: async () => JSON.stringify({ ok: true, result }),
  } as unknown as Response;
}

function errorResponse(status: number, body = '{"ok":false,"description":"nope"}'): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers(),
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

interface RecordedFailure {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: Date;
}

function makeAlertDeliveryLog(): AlertDeliveryFailureLog & { failures: RecordedFailure[] } {
  const failures: RecordedFailure[] = [];
  return {
    failures,
    recordFailure(entry) {
      failures.push(entry);
    },
  };
}

interface ClientHarness {
  client: TelegramBotApiClient;
  fetchMock: ReturnType<typeof vi.fn>;
  alertDeliveryLog: ReturnType<typeof makeAlertDeliveryLog>;
  calls: () => { url: string; body: Record<string, unknown> }[];
}

function makeClient(
  overrides: {
    alertChatId?: string;
    logger?: Logger;
    alertDeliveryLog?: AlertDeliveryFailureLog;
    retry?: RetryConfig;
  } = {},
): ClientHarness {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
  vi.stubGlobal('fetch', fetchMock);

  const alertDeliveryLog = makeAlertDeliveryLog();
  const client = new TelegramBotApiClient({
    botToken: FAKE_TOKEN,
    alertDeliveryLog: overrides.alertDeliveryLog ?? alertDeliveryLog,
    ...(overrides.alertChatId === undefined ? {} : { alertChatId: overrides.alertChatId }),
    logger: overrides.logger ?? { log: () => {} },
    retry: overrides.retry ?? { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });

  return {
    client,
    fetchMock,
    alertDeliveryLog,
    calls: () =>
      fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>,
      })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TelegramBotApiClient construction (boot-time validation)', () => {
  it('rejects a missing bot token', () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(() => new TelegramBotApiClient({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });

  it('trims leading/trailing whitespace from an explicitly-passed bot token (#355)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramBotApiClient({
      botToken: ` ${FAKE_TOKEN}\n`,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await client.sendMessage(CHAT_ID, 'hi');

    const [[url]] = fetchMock.mock.calls;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
  });

  it('trims a bot token sourced from process.env.TELEGRAM_BOT_TOKEN (#355)', async () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = `\t${FAKE_TOKEN} `;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new TelegramBotApiClient({
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      });
      await client.sendMessage(CHAT_ID, 'hi');

      const [[url]] = fetchMock.mock.calls;
      expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });

  it('treats a whitespace-only bot token as not configured, matching the #354 rule', () => {
    expect(() => new TelegramBotApiClient({ botToken: '   \n\t  ' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe('TelegramBotApiClient.sendMessage', () => {
  it('POSTs sendMessage with the chat id and text', async () => {
    const h = makeClient();
    await h.client.sendMessage(CHAT_ID, 'heartbeat');

    const [call] = h.calls();
    expect(call?.url).toContain('/sendMessage');
    expect(call?.body).toMatchObject({ chat_id: CHAT_ID, text: 'heartbeat' });
  });

  it('throws a classified error on a non-2xx response, without leaking the bot token', async () => {
    const h = makeClient();
    h.fetchMock.mockResolvedValue(errorResponse(401));

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow(/401/);
    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.not.toThrow(
      new RegExp(FAKE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});

describe('TelegramBotApiClient — transient network failures and undeliverable alerts (#1108)', () => {
  it('retries a bare fetch rejection and delivers on a later attempt', async () => {
    const h = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    h.fetchMock
      .mockRejectedValueOnce(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
      )
      .mockResolvedValueOnce(okResponse());

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).resolves.toBeUndefined();

    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.alertDeliveryLog.failures).toEqual([]);
  });

  it('never retries a caller-initiated abort, unlike a bare network failure (pins #1108’s documented exception)', async () => {
    const h = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    h.fetchMock.mockRejectedValue(new DOMException('Aborted.', 'AbortError'));

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('durably records a send that exhausts retries on a bare network failure', async () => {
    const h = makeClient({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );

    await expect(h.client.sendMessage(CHAT_ID, 'Samurai VERDICT: TSLA bullish')).rejects.toThrow();

    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.alertDeliveryLog.failures).toHaveLength(1);
    expect(h.alertDeliveryLog.failures[0]).toMatchObject({
      chat_id: CHAT_ID,
      method: 'sendMessage',
      body: 'Samurai VERDICT: TSLA bullish',
    });
    expect(h.alertDeliveryLog.failures[0]?.error).toContain('fetch failed');
  });

  it('masks a bot-token-shaped detail in the log message, not just in the payload', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({ logger: { log: (entry) => entries.push(entry) } });
    const tokenLike = 'bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    h.fetchMock.mockRejectedValue(new TypeError(`bad baseUrl config: ${tokenLike}`));

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow();

    const failureEntry = entries.find((entry) =>
      entry.message.startsWith('alert delivery to Telegram failed permanently'),
    );
    expect(failureEntry).toBeDefined();
    expect(failureEntry?.message).not.toContain(tokenLike);
    expect(failureEntry?.message).toContain('[REDACTED]');
  });

  it('passes the full, uncapped body/error to the durable record — capping is recordFailure’s job, not the caller’s', async () => {
    const h = makeClient();
    const errorMessage = `fetch failed: ${'y'.repeat(1_000)}`;
    h.fetchMock.mockRejectedValue(new TypeError(errorMessage));
    const expectedError = classifyTelegramThrown(
      new TypeError(errorMessage),
      'sendMessage',
    ).message;

    await expect(h.client.sendMessage(CHAT_ID, 'z'.repeat(1_000))).rejects.toThrow();

    const [recorded] = h.alertDeliveryLog.failures;
    expect(recorded?.body.length).toBe(1_000);
    expect(recorded?.error).toBe(expectedError);
  });

  it('fully redacts a secret straddling the truncation boundary once it reaches the real durable log', async () => {
    const db = openSharedStore(':memory:');
    const realLog = new SqliteAlertDeliveryLog(db);
    const h = makeClient({
      alertDeliveryLog: realLog,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    const digits = '123456789012';
    const suffix = 'F'.repeat(40);
    const secret = `${digits}:${suffix}`;
    const after = ` ${'y'.repeat(200)}`;

    const MARKER = 'Z';
    const wrapperPrefixLen = classifyTelegramThrown(
      new TypeError(MARKER),
      'sendMessage',
    ).message.indexOf(MARKER);
    const targetSecretStart = MAX_ERROR_BODY_CHARS - 15;
    const beforeContentLen = targetSecretStart - wrapperPrefixLen - 1;
    const before = `${'x'.repeat(beforeContentLen)} `;
    const rawMessage = `${before}${secret}${after}`;

    const wrapped = classifyTelegramThrown(new TypeError(rawMessage), 'sendMessage').message;
    expect(wrapped.length).toBeGreaterThan(MAX_ERROR_BODY_CHARS);
    expect(wrapped.indexOf(secret)).toBe(targetSecretStart);
    const survivingSuffixChars = MAX_ERROR_BODY_CHARS - (targetSecretStart + digits.length + 1);
    expect(survivingSuffixChars).toBeGreaterThan(0);
    expect(survivingSuffixChars).toBeLessThan(20);

    h.fetchMock.mockRejectedValue(new TypeError(rawMessage));

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow();

    const [row] = db.prepare('SELECT error FROM alert_delivery_failures').all() as Array<{
      error: string;
    }>;
    expect(row?.error).toContain('[REDACTED]');
    expect(row?.error).not.toContain(digits);
    expect(row?.error).not.toContain(suffix.slice(0, 20));

    const reportedTotal = row?.error.match(/\(truncated, (\d+) chars total\)$/);
    expect(reportedTotal).not.toBeNull();
    expect(Number(reportedTotal?.[1])).toBeLessThan(wrapped.length);
  });

  it('a broken durable write never replaces the original send failure', async () => {
    const h = makeClient();
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );
    h.alertDeliveryLog.recordFailure = () => {
      throw new Error('db locked');
    };

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow(/fetch failed/);
  });

  it('masks a bot-token-shaped recordError message in the "failed to durably record" log line', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({ logger: { log: (entry) => entries.push(entry) } });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );
    const tokenLike = 'bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    h.alertDeliveryLog.recordFailure = () => {
      throw new Error(`db write failed against ${tokenLike}`);
    };

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow();

    const failureEntry = entries.find((entry) =>
      entry.message.startsWith('failed to durably record an undelivered alert'),
    );
    expect(failureEntry).toBeDefined();
    expect(failureEntry?.message).not.toContain(tokenLike);
    expect(failureEntry?.message).toContain('[REDACTED]');
  });

  it('an unrenderable recordError still logs telegram_delivery_failed and its own line with the placeholder', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({ logger: { log: (entry) => entries.push(entry) } });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;
    h.alertDeliveryLog.recordFailure = () => {
      throw hostile;
    };

    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow(/fetch failed/);

    const recordFailedEntry = entries.find((entry) =>
      entry.message.startsWith('failed to durably record an undelivered alert'),
    );
    expect(recordFailedEntry?.message).toContain('[unrenderable error]');

    const deliveryFailedEntry = entries.find((entry) => entry.event === 'telegram_delivery_failed');
    expect(deliveryFailedEntry).toBeDefined();
  });

  it('escalates on the Nth permanently-undeliverable send and every Nth after', async () => {
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );

    for (let i = 0; i < 3; i++) {
      await expect(h.client.sendMessage(CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }

    const escalations = h
      .calls()
      .filter((c) => c.url.includes('/sendMessage') && String(c.body.text).includes('degraded'));
    expect(escalations).toHaveLength(1);
    expect(String(escalations[0]?.body.text)).toContain('3 Telegram sends');
  });

  const FORWARD_DELIVERY_CLAIM =
    /\b(?:will|would|can(?:not)?|could|shall|does|is guaranteed to)\s+(?:not\s+|never\s+|still\s+|always\s+)*(?:reach|arrive|get through|be delivered)\b/gi;

  it.each([
    ['it cannot arrive during a real outage', true],
    ['it can not arrive', true],
    ['it can never arrive', true],
    ['this does reach you', true],
    ['is guaranteed to be delivered', true],
  ])('FORWARD_DELIVERY_CLAIM.test(%s) === %s', (text, expected) => {
    FORWARD_DELIVERY_CLAIM.lastIndex = 0;
    expect(FORWARD_DELIVERY_CLAIM.test(text)).toBe(expected);
  });

  it('the degraded-channel notice asserts nothing about its own future delivery, and names both denominators', async () => {
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );

    for (let i = 0; i < 3; i++) {
      await expect(h.client.sendMessage(CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }

    const [escalation] = h
      .calls()
      .filter((c) => c.url.includes('/sendMessage') && String(c.body.text).includes('degraded'));
    const text = String(escalation?.body.text);

    expect(text.match(FORWARD_DELIVERY_CLAIM) ?? []).toEqual([]);
    expect(text).toMatch(/reachable at some point[^.]*send-and-retry window/i);
    expect(text).not.toMatch(/\bat (?:the|that|one|a single) (?:moment|instant)\b/i);
    expect(text).toMatch(/so far this run/i);
    expect(text).toMatch(/trailing 24 hours/i);
    expect(text).toContain('alert_delivery_failures');
  });

  it('an escalation attempt that itself fails is swallowed, not recorded as a second failure', async () => {
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );

    for (let i = 0; i < 3; i++) {
      await expect(h.client.sendMessage(CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(h.alertDeliveryLog.failures).toHaveLength(3);
  });

  it('masks a bot-token-shaped escalationError message in the "failed to post the ... escalation" log line', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: { log: (entry) => entries.push(entry) },
    });
    const tokenLike = 'bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    h.fetchMock.mockRejectedValue(new TypeError(`bad baseUrl config: ${tokenLike}`));

    for (let i = 0; i < 3; i++) {
      await expect(h.client.sendMessage(CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    const escalationLogEntry = entries.find((entry) =>
      entry.message.startsWith('failed to post the repeated-delivery-failure escalation'),
    );
    expect(escalationLogEntry).toBeDefined();
    expect(escalationLogEntry?.message).not.toContain(tokenLike);
    expect(escalationLogEntry?.message).toContain('[REDACTED]');
  });

  it('an unrenderable escalationError does not become an unhandled rejection, and logs the placeholder', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: { log: (entry) => entries.push(entry) },
    });
    const hostile = new TelegramProviderError('placeholder', 502);
    Object.defineProperty(hostile, 'message', {
      get(): string {
        throw new Error('render boom');
      },
      configurable: true,
    });
    h.fetchMock.mockRejectedValue(hostile);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let i = 0; i < 3; i++) {
        await expect(h.client.sendMessage(CHAT_ID, `alert ${i}`)).rejects.toBeDefined();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);

    const escalationLogEntry = entries.find((entry) =>
      entry.message.startsWith('failed to post the repeated-delivery-failure escalation'),
    );
    expect(escalationLogEntry?.message).toContain('[unrenderable error]');
  });

  it('a failure on a DIFFERENT chat than the escalation chat never triggers escalation (#342 isolation)', async () => {
    const h = makeClient({
      alertChatId: CHAT_ID,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );

    for (let i = 0; i < 5; i++) {
      await expect(h.client.sendMessage('heartbeat-chat', `beat ${i}`)).rejects.toThrow();
    }

    expect(
      h
        .calls()
        .filter((c) => c.url.includes('/sendMessage') && String(c.body.text).includes('degraded')),
    ).toEqual([]);
    expect(h.alertDeliveryLog.failures).toHaveLength(5);
  });
});

describe('AlertDeliveryLog port', () => {
  it('is structurally satisfied by the orchestrator SqliteAlertDeliveryLog', () => {
    expectTypeOf<SqliteAlertDeliveryLog>().toExtend<AlertDeliveryFailureLog>();
  });
});

describe('outbound message cap (Telegram 4096)', () => {
  it('caps an over-long sendMessage body on the wire', async () => {
    const { client, calls } = makeClient();
    const members = Array.from(
      { length: 64 },
      (_, i) => `position ${i}: no mark available for the LSE ticker within the staleness bound`,
    );
    const body =
      'Samurai TRADER DEGRADED: NFLX reported control_arm_valuation_refused.\n' +
      `Detail: the control arm could not value the book (AggregateError: ${members.join('; ')})`;
    expect(body.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_CHARS);

    await client.sendMessage(CHAT_ID, body);

    const sent = calls().at(-1)?.body.text as string;
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(sent.startsWith('Samurai TRADER DEGRADED: NFLX')).toBe(true);
  });

  it('leaves an ordinary alert untouched', async () => {
    const { client, calls } = makeClient();
    const body = 'Samurai heartbeat: 4 instruments, 0 open positions.';

    await client.sendMessage(CHAT_ID, body);

    expect(calls().at(-1)?.body.text).toBe(body);
  });

  it('puts the full pre-cap body in the log, so truncation loses nothing', async () => {
    const entries: LogEntry[] = [];
    const { client } = makeClient({ logger: { log: (entry) => entries.push(entry) } });
    const tail = 'z'.repeat(9000);

    await client.sendMessage(CHAT_ID, `head ${tail}`);

    const logged = entries.filter((entry) => entry.message.startsWith('telegram_body_truncated'));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('warn');
    expect(logged[0]?.event).toBe('telegram_body_truncated');
    expect(logged[0]?.payload).toEqual({
      chars: `head ${tail}`.length,
      body: `head ${tail}`,
    });
  });

  it('delivers a 4096+ char body instead of dropping it to Telegram’s 400 (#1108 AC1)', async () => {
    const h = makeClient();
    const body = `Samurai VERDICT: AAPL bearish. Detail: ${'x'.repeat(5_000)}`;
    expect(body.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_CHARS);

    await expect(h.client.sendMessage(CHAT_ID, body)).resolves.toBeUndefined();

    const sent = h.calls().at(-1)?.body.text as string;
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(sent).toContain('Samurai VERDICT: AAPL bearish');
    expect(sent).toContain('truncated');
    expect(h.alertDeliveryLog.failures).toEqual([]);
  });

  it('logs nothing extra when the body already fits', async () => {
    const entries: LogEntry[] = [];
    const { client } = makeClient({ logger: { log: (entry) => entries.push(entry) } });

    await client.sendMessage(CHAT_ID, 'Samurai heartbeat: 4 instruments, 0 open positions.');

    expect(entries.filter((entry) => entry.message.startsWith('telegram_body_truncated'))).toEqual(
      [],
    );
  });
});

describe('capOutboundText', () => {
  it('leaves a message that already fits completely untouched', () => {
    const text = 'Samurai TRADER DEGRADED: NFLX reported atr_not_finite.';
    expect(capOutboundText(text)).toBe(text);
  });

  it('leaves a message of exactly the limit untouched', () => {
    const text = 'x'.repeat(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(capOutboundText(text)).toBe(text);
  });

  it('produces a result within the limit, suffix included', () => {
    const capped = capOutboundText('x'.repeat(10_000));
    expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
  });

  it('says how much was dropped, so the reader knows to go to the log', () => {
    const capped = capOutboundText('x'.repeat(10_000));
    expect(capped).toContain('truncated, 10000 chars total');
  });

  it('keeps the head, where the alert states what happened', () => {
    const capped = capOutboundText(`Samurai TRADER DEGRADED: NFLX${'x'.repeat(10_000)}`);
    expect(capped.startsWith('Samurai TRADER DEGRADED: NFLX')).toBe(true);
  });

  it('never splits a surrogate pair — a lone high surrogate is not valid UTF-8 on the wire', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const capped = capOutboundText(`${'a'.repeat(pad)}${'📈'.repeat(6000)}`);
      expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
      expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    }
  });
});
