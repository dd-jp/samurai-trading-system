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
    // Spread rather than assigned: `alertChatId` is optional, and under
    // `exactOptionalPropertyTypes` passing an explicit `undefined` is not the
    // same as omitting it. Callers that leave it out must produce a config
    // with no `alertChatId` key at all
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
    // A trailing newline out of an env file must not land in the request URL —
    // same class of bug as #342/#354's chat-id whitespace issue, and the same
    // rule: normalize once, at the read point, and hand the normalized value
    // onward. Verified by observing the *outbound request URL*, not by
    // asserting on `#botToken` directly (private), and never by logging the
    // fake token's value in a failure message
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
    // Every `new TypeError('fetch failed')` mock in this file now carries a
    // `.cause` (#1132): classifyTelegramThrown keys on that shape, not the
    // message text, so a cause-less TypeError no longer models a real fetch
    // failure and would misclassify as non-retryable
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

  // Finding 2 (third #1108 review pass): `#recordDeliveryFailure`'s `#log`
  // payload's `error` field is masked centrally by `formatLogLine`'s
  // `redactPayload` walk, but `message` is a plain string the logger never
  // touches — so a bot-token-shaped detail (e.g. a misconfigured `baseUrl`
  // landing the token in a thrown `TypeError`'s message, exactly what this
  // module's header doc names as the threat) must be masked before it's
  // interpolated into `message`, not just left to `payload`'s protection
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
    // `SqliteAlertDeliveryLog.recordFailure` mask-then-caps (see
    // alert-delivery-log.ts and the end-to-end blocker regression test just
    // below); capping here first would truncate ahead of that mask, which is
    // exactly the ordering bug the blocker fixed. This test double only
    // records what it's given, so this pins that the client hands over the
    // ORIGINAL length rather than pre-truncating
    const h = makeClient();
    const errorMessage = `fetch failed: ${'y'.repeat(1_000)}`;
    h.fetchMock.mockRejectedValue(new TypeError(errorMessage));
    // `#call` classifies the thrown error before it reaches
    // `#recordDeliveryFailure`, wrapping the raw message — compute the same
    // wrapping rather than hardcode it, so this doesn't drift from
    // telegram-errors.ts's own wording
    const expectedError = classifyTelegramThrown(
      new TypeError(errorMessage),
      'sendMessage',
    ).message;

    await expect(h.client.sendMessage(CHAT_ID, 'z'.repeat(1_000))).rejects.toThrow();

    const [recorded] = h.alertDeliveryLog.failures;
    expect(recorded?.body.length).toBe(1_000);
    expect(recorded?.error).toBe(expectedError);
  });

  // #1108 blocker, end-to-end: a token-shaped secret straddling the 500-char
  // truncation boundary must still be fully redacted once it reaches disk
  // The `alertDeliveryLog` test double above only records what it's handed —
  // it can't catch a truncate-then-mask bug that lives in the INTERACTION
  // between this client (the former truncation site) and the real
  // `SqliteAlertDeliveryLog` (the masking site), so this test wires the real
  // one in over an in-memory DB. Truncating before masking bisects the bare
  // `\d{6,}:[A-Za-z0-9_-]{20,}` pattern so only a short remainder of the
  // opaque suffix survives the cut — too short to clear the `{20,}` floor —
  // leaving a partial secret on disk. This is red against the pre-fix
  // truncate-then-mask ordering and green once masking runs before the cap
  it('fully redacts a secret straddling the truncation boundary once it reaches the real durable log', async () => {
    const db = openSharedStore(':memory:');
    const realLog = new SqliteAlertDeliveryLog(db);
    const h = makeClient({
      alertDeliveryLog: realLog,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    // A word-boundary (space) on both sides is required for the bare-token
    // pattern's `\b` anchors to fire against the surrounding filler —
    // without it, filler and token blend into one run of word characters and
    // the pattern never matches
    const digits = '123456789012';
    const suffix = 'F'.repeat(40);
    const secret = `${digits}:${suffix}`;
    const after = ` ${'y'.repeat(200)}`;

    // `#call` classifies the thrown error before it reaches
    // `#recordDeliveryFailure`, wrapping the raw message in fixed prose —
    // measured here via a marker rather than hardcoded, so this doesn't drift
    // from telegram-errors.ts's own wording. The cut must land far enough
    // into the opaque suffix that fewer than 20 of its chars survive — a
    // shallower cut leaves enough of the run intact to still clear the
    // pattern's `{20,}` floor even after truncation, which would falsely
    // "pass" a truncate-then-mask bug
    const MARKER = 'Z';
    const wrapperPrefixLen = classifyTelegramThrown(
      new TypeError(MARKER),
      'sendMessage',
    ).message.indexOf(MARKER);
    // 12(digits) + 1(colon) + 2 = 15 chars of the secret survive the cap
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

    // Masking is not a substitute for capping: assert the row is STILL
    // truncated, and that the reported "chars total" count reflects the
    // POST-mask length (shorter than the raw wrapped message) rather than
    // the pre-mask length — the latter is exactly what a reverted
    // truncate-then-mask ordering would report, since it caps before the
    // secret has been shrunk to '[REDACTED]'
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

  // #1108 third review pass: two log interpolations remained unsanitised
  // after the `detail` fix above — this is the first, the `recordError`
  // interpolated into "failed to durably record an undelivered alert"
  // `redactPayload` never walks this plain string `message`, so a
  // bot-token-shaped `recordError.message` reaches the log unmasked without
  // `sanitizeLogText` around it, the same threat the `detail` test above
  // pins for the main line
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

  // #1351: `recordError`'s render sits BEFORE the unconditional
  // `telegram_delivery_failed` log call that follows the `if` block — a
  // throw here (unguarded) would destroy that line too, not just its own
  it('an unrenderable recordError still logs telegram_delivery_failed and its own line with the placeholder', async () => {
    const entries: LogEntry[] = [];
    const h = makeClient({ logger: { log: (entry) => entries.push(entry) } });
    h.fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
    );
    // Same hostile shape as the #1262 tick-loop test: circular (defeats
    // `JSON.stringify`) with a throwing `Symbol.toPrimitive` (defeats the
    // `String()` fallback too)
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;
    h.alertDeliveryLog.recordFailure = () => {
      throw hostile;
    };

    // The ORIGINAL fetch failure, not a render failure, must still be what
    // rejects the call — proof `#recordDeliveryFailure` did not itself throw
    // and replace it
    await expect(h.client.sendMessage(CHAT_ID, 'hi')).rejects.toThrow(/fetch failed/);

    const recordFailedEntry = entries.find((entry) =>
      entry.message.startsWith('failed to durably record an undelivered alert'),
    );
    expect(recordFailedEntry?.message).toContain('[unrenderable error]');

    // The durable artifact this guard exists to preserve: the method's own
    // unconditional summary line, reached only if the render above did not
    // escape the surrounding catch
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

  // #1130: this notice posts to `#alertChatId` over the SAME transport that
  // just exhausted its retries, so it arrives only if that chat is reachable
  // at some point within the escalation send's OWN retry window (necessary,
  // not sufficient — the escalation's own `#call` can fail independently)
  // That window is not an instant: `#call` is `withRetry` over
  // `isRetryableTelegramError`, which accepts exactly the network/timeout/
  // rate-limit errors a live outage throws, so the notice can fire mid-outage
  // and land on a later attempt — tens of seconds wide on `DEFAULT_RETRY` +
  // `DEFAULT_TIMEOUT_MS`. So arrival is a fact about that window, not about
  // what class of failure produced the count, and its ABSENCE is not
  // observable by anyone. The text must therefore make no forward-looking delivery
  // claim in EITHER direction, and must point at `alert_delivery_failures`
  // (the Rail tile, #1108/#1129) with its different denominator named
  //
  // Round 1's finding was that the previous version of this test pinned two
  // substrings: prepending 'This notice will reach you even during a total
  // outage. ' left both intact and 62/62 still passed — a message asserting
  // the exact opposite of the thesis survived the test meant to pin it. So
  // the guard below is on the CLAIM: a modal or auxiliary verb bound to a
  // delivery verb is an assertion about future delivery, and this mechanism
  // supports none. Honest limit: this catches auxiliary-marked assertions
  // ('will reach', 'cannot arrive', 'is guaranteed to be delivered'),
  // wherever in the message they sit, including inside a sentence that
  // already carries a qualifier. It does not catch every possible paraphrase
  // ('you always get this one'); it is a claim-shape guard, not a semantic
  // one
  const FORWARD_DELIVERY_CLAIM =
    /\b(?:will|would|can(?:not)?|could|shall|does|is guaranteed to)\s+(?:not\s+|never\s+|still\s+|always\s+)*(?:reach|arrive|get through|be delivered)\b/gi;

  // #1303: `FORWARD_DELIVERY_CLAIM` is a `can|could|...` alternation, not a
  // `\bcan\b`-then-`not` sequence, so `cannot` (one token) only matches
  // through the explicit `can(?:not)?` branch — a prior version of this
  // alternation used a bare `can` and silently missed `'cannot arrive'`,
  // one of the very examples the guard's own comment above lists as caught
  // Pinned per-string so a future edit to the alternation that reopens this
  // gap fails here directly. This table is one-directional (every case here
  // is a claim the guard MUST catch); it cannot by itself catch the alternation
  // going too wide — that direction is pinned by the aggregate
  // `.toEqual([])` assertion below, run against the real wire text
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
    // What it may say instead, at exactly the strength the mechanism supports:
    // reachability somewhere inside this send's own send-and-retry window —
    // not that a retry itself happened, since a first-attempt success never
    // retries and the window bound holds either way. Both halves are pinned
    // because either alone is passable by wording that is wrong — a bare
    // 'reachable' by an instant claim, a bare 'window' by a sentence that
    // names a window and still asserts an instant. Like FORWARD_DELIVERY_CLAIM
    // above, this is a claim-shape guard, not a semantic one: it pins the
    // strength this wording carries, and a paraphrase that dropped the window
    // without using the point-in-time phrasings below would slip past it
    // Deliberately blunt in the other direction too: it rejects that phrasing
    // family wherever it sits, so a legitimate future sentence ('not at the
    // moment the failures were counted') has to be reworded rather than
    // exempted — reword, and do not read the rejection as a finding about the
    // message
    expect(text).toMatch(/reachable at some point[^.]*send-and-retry window/i);
    expect(text).not.toMatch(/\bat (?:the|that|one|a single) (?:moment|instant)\b/i);
    // And the two denominators, so the operator is not left reconciling them
    // #1131: the tile is windowed (trailing 24h), not all-time, so the text
    // must name that window rather than the dropped "all-time" claim
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
    // Let the fire-and-forget escalation attempt (itself rejected, since
    // fetchMock always rejects) settle before asserting
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(h.alertDeliveryLog.failures).toHaveLength(3);
  });

  // #1108 third review pass: the second of the two remaining unsanitised
  // interpolations — `escalationError` in the fire-and-forget `.catch` above
  // The escalation send itself goes through `#call`/`#request`, which can
  // fail against the same misconfigured `baseUrl` this module's header names
  // as the threat, so a bot-token-shaped message here must be masked too
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
    // Let the fire-and-forget escalation attempt (itself rejected, since
    // fetchMock always rejects) settle before asserting
    await new Promise((resolve) => setTimeout(resolve, 5));

    const escalationLogEntry = entries.find((entry) =>
      entry.message.startsWith('failed to post the repeated-delivery-failure escalation'),
    );
    expect(escalationLogEntry).toBeDefined();
    expect(escalationLogEntry?.message).not.toContain(tokenLike);
    expect(escalationLogEntry?.message).toContain('[REDACTED]');
  });

  // #1351: `escalationError` is inside a detached `.catch()` on the
  // escalation's own `#call('sendMessage', …)` — nothing awaits or re-catches
  // it, so an unguarded throw here is an unhandled rejection
  // `classifyTelegramThrown` passes a `TelegramProviderError` through
  // unchanged (telegram-errors.ts), so a hostile instance of it survives the
  // classification layer intact and reaches this catch as-is
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
      // Let the fire-and-forget escalation attempt settle before asserting
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // The durable artifact: no unhandled rejection reached the process —
    // before the fix, rendering `hostile` here threw INSIDE the `.catch()`
    // handler itself, which is exactly what turns a handled rejection into
    // an unhandled one
    expect(unhandled).toEqual([]);

    const escalationLogEntry = entries.find((entry) =>
      entry.message.startsWith('failed to post the repeated-delivery-failure escalation'),
    );
    expect(escalationLogEntry?.message).toContain('[unrenderable error]');
  });

  it('a failure on a DIFFERENT chat than the escalation chat never triggers escalation (#342 isolation)', async () => {
    // The heartbeat posts to its own chat, never the escalation chat (#342) —
    // a dead heartbeat destination must not mute or drown the escalations
    // sent elsewhere. alert-transport.test.ts's #342 suite covers a failing
    // heartbeat CHANNEL end-to-end, but only against the pre-#1108 send path;
    // this is the one place a heartbeat-chat failure is driven through the
    // #1108 delivery-failure counter itself, to pin that it durably records
    // without ever advancing or triggering the escalation-chat alert
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
    // Still durably recorded — just never counted toward, or itself escalated to, the alert chat
    expect(h.alertDeliveryLog.failures).toHaveLength(5);
  });
});

describe('AlertDeliveryLog port', () => {
  it('is structurally satisfied by the orchestrator SqliteAlertDeliveryLog', () => {
    expectTypeOf<SqliteAlertDeliveryLog>().toExtend<AlertDeliveryFailureLog>();
  });
});

/**
 * An over-long body is a PERMANENT 400, not transport flake — the retry
 * re-sends the same bytes — so the cap has to hold in the transport: ten
 * channels build bodies, and a bound only some of them remember to apply is
 * not a bound. Bodies grow past the limit because they interpolate
 * `describeThrown` over an `AggregateError` whose member count scales with
 * the open book, which is the reproduction the first case below builds.
 */
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

  /** The record half of the bound — see `#capForWire` */
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

  /**
   * The whole defect in one assertion: a cap that slices to the limit and
   * then appends a suffix still exceeds the limit, still 400s, and still
   * never delivers
   */
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
    // '📈' is one astral code point, two UTF-16 code units. Repeating it to
    // straddle the cut point lands the boundary mid-pair on some offsets
    for (let pad = 0; pad < 4; pad += 1) {
      const capped = capOutboundText(`${'a'.repeat(pad)}${'📈'.repeat(6000)}`);
      expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
      expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    }
  });
});
