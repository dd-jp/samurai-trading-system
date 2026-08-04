import type { SqliteAuditLog } from '../../../orchestrator/index.js';
import type { CallbackAuditLog } from './telegram-bot-api-client.js';
import { TelegramBotApiClient } from './telegram-bot-api-client.js';

const FAKE_TOKEN = '1234567:test-fake-bot-token';
const ALLOWED_ID = 4242;
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

interface RecordedEntry {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: Date;
}

function makeAuditLog(): CallbackAuditLog & { entries: RecordedEntry[] } {
  const entries: RecordedEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
}

interface ClientHarness {
  client: TelegramBotApiClient;
  fetchMock: ReturnType<typeof vi.fn>;
  auditLog: ReturnType<typeof makeAuditLog>;
  calls: () => { url: string; body: Record<string, unknown> }[];
}

function makeClient(
  overrides: { updates?: unknown[][]; alertChatId?: string } = {},
): ClientHarness {
  const queued = overrides.updates ?? [];
  let poll = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/getUpdates')) {
      return okResponse(queued[poll++] ?? []);
    }
    return okResponse();
  });
  vi.stubGlobal('fetch', fetchMock);

  const auditLog = makeAuditLog();
  const client = new TelegramBotApiClient({
    botToken: FAKE_TOKEN,
    allowedUserIds: String(ALLOWED_ID),
    auditLog,
    alertChatId: overrides.alertChatId,
    logger: { log: () => {} },
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });

  return {
    client,
    fetchMock,
    auditLog,
    calls: () =>
      fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>,
      })),
  };
}

function callbackUpdate(
  updateId: number,
  data: string,
  fromId: number = ALLOWED_ID,
): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: 'David' },
      message: { message_id: 1, chat: { id: Number(CHAT_ID) } },
      data,
    },
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
      expect(
        () =>
          new TelegramBotApiClient({
            allowedUserIds: String(ALLOWED_ID),
            auditLog: makeAuditLog(),
          }),
      ).toThrow(/TELEGRAM_BOT_TOKEN/);
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });

  it('rejects an unset allowlist at construction rather than failing closed at runtime', () => {
    const previous = process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    try {
      expect(
        () => new TelegramBotApiClient({ botToken: FAKE_TOKEN, auditLog: makeAuditLog() }),
      ).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_ALLOWED_USER_IDS = previous;
    }
  });

  it('rejects a wildcard allowlist', () => {
    expect(
      () =>
        new TelegramBotApiClient({
          botToken: FAKE_TOKEN,
          allowedUserIds: '*',
          auditLog: makeAuditLog(),
        }),
    ).toThrow(/wildcard/i);
  });

  it('never leaks the bot token in the construction error message', () => {
    try {
      new TelegramBotApiClient({
        botToken: FAKE_TOKEN,
        allowedUserIds: 'bogus',
        auditLog: makeAuditLog(),
      });
      expect.unreachable('expected a validation failure');
    } catch (error) {
      expect((error as Error).message).not.toContain(FAKE_TOKEN);
    }
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

describe('TelegramBotApiClient.sendApprovalButtons', () => {
  it('sends two inline buttons whose callback_data are distinct 32-hex correlation tokens', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'Approval requested', {
      trace_id: 'trace-1',
      idempotency_key: 'idem-1',
      timeout_ms: 60_000,
    });

    const [call] = h.calls();
    expect(call?.url).toContain('/sendMessage');
    const markup = call?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const [row] = markup.inline_keyboard;
    expect(row).toHaveLength(2);
    const [approve, reject] = row as { callback_data: string }[];
    expect(approve?.callback_data).toMatch(/^[0-9a-f]{32}$/);
    expect(reject?.callback_data).toMatch(/^[0-9a-f]{32}$/);
    expect(approve?.callback_data).not.toBe(reject?.callback_data);
  });

  it('does not block on a human response', async () => {
    const h = makeClient();
    await expect(
      h.client.sendApprovalButtons(CHAT_ID, 'text', {
        trace_id: 't',
        idempotency_key: 'k',
        timeout_ms: 60_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('drops the minted tokens when the send itself fails', async () => {
    const h = makeClient();
    h.fetchMock.mockResolvedValue(errorResponse(500));

    await expect(
      h.client.sendApprovalButtons(CHAT_ID, 'text', {
        trace_id: 't',
        idempotency_key: 'k',
        timeout_ms: 60_000,
      }),
    ).rejects.toThrow();
    expect(h.client.pendingTokenCount).toBe(0);
  });
});

describe('TelegramBotApiClient.pollOnce — offset tracking', () => {
  it('omits offset on the first poll and passes highest update_id + 1 afterwards', async () => {
    const h = makeClient({ updates: [[{ update_id: 7 }, { update_id: 9 }], []] });

    await h.client.pollOnce();
    await h.client.pollOnce();

    const polls = h.calls().filter((c) => c.url.includes('/getUpdates'));
    expect(polls[0]?.body.offset).toBeUndefined();
    expect(polls[1]?.body.offset).toBe(10);
  });

  it('does not rewind the offset when a lower update_id arrives late', async () => {
    const h = makeClient({ updates: [[{ update_id: 9 }], [{ update_id: 3 }], []] });

    await h.client.pollOnce();
    await h.client.pollOnce();
    await h.client.pollOnce();

    const polls = h.calls().filter((c) => c.url.includes('/getUpdates'));
    expect(polls[2]?.body.offset).toBe(10);
  });

  it('requests only callback_query updates and long-polls', async () => {
    const h = makeClient();
    await h.client.pollOnce();

    const [poll] = h.calls().filter((c) => c.url.includes('/getUpdates'));
    expect(poll?.body.allowed_updates).toEqual(['callback_query']);
    expect(poll?.body.timeout).toBeGreaterThan(0);
  });

  it('advances the offset even when handling an update throws', async () => {
    const h = makeClient({ updates: [[callbackUpdate(11, '0'.repeat(32))], []] });
    h.client.onApprovalCallback(() => {
      throw new Error('handler blew up');
    });

    await expect(h.client.pollOnce()).resolves.toBeUndefined();
    await h.client.pollOnce();

    const polls = h.calls().filter((c) => c.url.includes('/getUpdates'));
    expect(polls[1]?.body.offset).toBe(12);
  });
});

describe('TelegramBotApiClient inbound callback flow', () => {
  it('invokes the registered handler with the recovered request when from.id is allowlisted', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 'trace-1',
      idempotency_key: 'idem-1',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const approveToken = markup.inline_keyboard[0]?.[0]?.callback_data as string;

    const handler = vi.fn();
    h.client.onApprovalCallback(handler);
    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(String(url).includes('/getUpdates') ? [callbackUpdate(1, approveToken)] : true),
    );

    await h.client.pollOnce();

    expect(handler).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      idempotency_key: 'idem-1',
      outcome: 'approved',
    });
  });

  it('always calls answerCallbackQuery, including for an allowlist rejection', async () => {
    const h = makeClient({
      updates: [[callbackUpdate(1, 'a'.repeat(32), 999)]],
    });
    await h.client.pollOnce();

    const answers = h.calls().filter((c) => c.url.includes('/answerCallbackQuery'));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.body.callback_query_id).toBe('cbq-1');
  });

  it('answers the callback even when the token is unknown/expired', async () => {
    const h = makeClient({ updates: [[callbackUpdate(1, 'b'.repeat(32))]] });
    const handler = vi.fn();
    h.client.onApprovalCallback(handler);

    await h.client.pollOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(h.calls().filter((c) => c.url.includes('/answerCallbackQuery'))).toHaveLength(1);
  });

  it('answers the callback even when the handler throws', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 't',
      idempotency_key: 'k',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const token = markup.inline_keyboard[0]?.[1]?.callback_data as string;

    h.client.onApprovalCallback(() => {
      throw new Error('boom');
    });
    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(String(url).includes('/getUpdates') ? [callbackUpdate(2, token)] : true),
    );

    await h.client.pollOnce();
    expect(h.calls().filter((c) => c.url.includes('/answerCallbackQuery'))).toHaveLength(1);
  });

  it('resolves a request only once — the sibling button is invalidated', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 't',
      idempotency_key: 'k',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const approve = markup.inline_keyboard[0]?.[0]?.callback_data as string;
    const reject = markup.inline_keyboard[0]?.[1]?.callback_data as string;

    const handler = vi.fn();
    h.client.onApprovalCallback(handler);
    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(
        String(url).includes('/getUpdates')
          ? [callbackUpdate(1, approve), callbackUpdate(2, reject), callbackUpdate(3, approve)]
          : true,
      ),
    );

    await h.client.pollOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      trace_id: 't',
      idempotency_key: 'k',
      outcome: 'approved',
    });
  });
});

describe('TelegramBotApiClient allowlist enforcement', () => {
  it('never invokes the handler for a non-allowlisted from.id', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 'trace-9',
      idempotency_key: 'idem-9',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const token = markup.inline_keyboard[0]?.[0]?.callback_data as string;

    const handler = vi.fn();
    h.client.onApprovalCallback(handler);
    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(String(url).includes('/getUpdates') ? [callbackUpdate(1, token, 999)] : true),
    );

    await h.client.pollOnce();

    expect(handler).not.toHaveBeenCalled();
    // The token is untouched by the rejection path — a later legitimate press still works.
    expect(h.client.pendingTokenCount).toBe(2);
  });

  it('rejects a callback with no from.id at all', async () => {
    const h = makeClient({
      updates: [[{ update_id: 1, callback_query: { id: 'cbq-1', data: 'c'.repeat(32) } }]],
    });
    const handler = vi.fn();
    h.client.onApprovalCallback(handler);

    await h.client.pollOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(h.auditLog.entries).toHaveLength(1);
  });

  it('writes a structured audit entry with from.id, chat.id and a truncated token prefix', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 'trace-7',
      idempotency_key: 'idem-7',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const token = markup.inline_keyboard[0]?.[0]?.callback_data as string;

    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(String(url).includes('/getUpdates') ? [callbackUpdate(1, token, 999)] : true),
    );
    await h.client.pollOnce();

    expect(h.auditLog.entries).toHaveLength(1);
    const entry = h.auditLog.entries[0] as RecordedEntry;
    // Best-effort read-only lookup populates the trace_id the token maps to.
    expect(entry.trace_id).toBe('trace-7');
    expect(entry.decision).toBe('allowlist_rejected');
    expect(entry.timestamp).toBeInstanceOf(Date);

    const detail = JSON.parse(entry.input_digest) as Record<string, unknown>;
    expect(detail.channel).toBe('telegram');
    expect(detail.from_id).toBe(999);
    expect(detail.chat_id).toBe(Number(CHAT_ID));
    expect(detail.reason).toBe('from_id_not_allowlisted');
    expect(detail.correlation_token_prefix).toBe(token.slice(0, 8));
  });

  it('never writes the full correlation token to the audit log', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 'trace-7',
      idempotency_key: 'idem-7',
      timeout_ms: 60_000,
    });
    const markup = h.calls()[0]?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const token = markup.inline_keyboard[0]?.[0]?.callback_data as string;

    h.fetchMock.mockImplementation(async (url: string) =>
      okResponse(String(url).includes('/getUpdates') ? [callbackUpdate(1, token, 999)] : true),
    );
    await h.client.pollOnce();

    const serialized = JSON.stringify(h.auditLog.entries);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain(token.slice(0, 8));
  });

  it('records an absent trace_id when the rejected token matches nothing', async () => {
    const h = makeClient({ updates: [[callbackUpdate(1, 'd'.repeat(32), 999)]] });
    await h.client.pollOnce();

    const entry = h.auditLog.entries[0] as RecordedEntry;
    expect(entry.trace_id).toBe('unknown');
  });

  it('surfaces repeated rejections on the notify channel', async () => {
    const h = makeClient({
      updates: [
        [
          callbackUpdate(1, 'e'.repeat(32), 999),
          callbackUpdate(2, 'e'.repeat(32), 999),
          callbackUpdate(3, 'e'.repeat(32), 999),
        ],
      ],
      alertChatId: CHAT_ID,
    });

    await h.client.pollOnce();

    const alerts = h
      .calls()
      .filter(
        (c) => c.url.includes('/sendMessage') && String(c.body.text).includes('unauthorised'),
      );
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]?.body.text)).toContain('999');
    expect(String(alerts[0]?.body.text)).not.toContain('e'.repeat(32));
  });

  it('an audit-log write failure never breaks the poll loop', async () => {
    const h = makeClient({ updates: [[callbackUpdate(1, 'f'.repeat(32), 999)]] });
    h.auditLog.record = () => {
      throw new Error('db locked');
    };

    await expect(h.client.pollOnce()).resolves.toBeUndefined();
    expect(h.calls().filter((c) => c.url.includes('/answerCallbackQuery'))).toHaveLength(1);
  });
});

describe('TelegramBotApiClient long-poll loop lifecycle', () => {
  it('start() is idempotent and stop() halts polling', async () => {
    const h = makeClient();
    h.client.start();
    h.client.start();
    await h.client.stop();

    const before = h.fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fetchMock.mock.calls.length).toBe(before);
  });

  it('stop() clears the correlation-token map', async () => {
    const h = makeClient();
    await h.client.sendApprovalButtons(CHAT_ID, 'text', {
      trace_id: 't',
      idempotency_key: 'k',
      timeout_ms: 60_000,
    });
    expect(h.client.pendingTokenCount).toBe(2);

    await h.client.stop();
    expect(h.client.pendingTokenCount).toBe(0);
  });

  it('a failing poll does not throw out of the loop', async () => {
    const h = makeClient();
    h.fetchMock.mockRejectedValue(new Error('network down'));

    await expect(h.client.pollOnce()).rejects.toThrow(/network down/);
    h.client.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(h.client.stop()).resolves.toBeUndefined();
  });

  it('stop() aborts an in-flight long poll instead of waiting out its 35s HTTP budget', async () => {
    const h = makeClient();
    // A getUpdates that only settles when its AbortSignal fires — i.e. a
    // normal long poll sitting open, waiting for an update that never comes.
    h.fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted.', 'AbortError')),
          );
        }),
    );

    h.client.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    await h.client.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('CallbackAuditLog port', () => {
  it('is structurally satisfied by the orchestrator SqliteAuditLog', () => {
    expectTypeOf<SqliteAuditLog>().toExtend<CallbackAuditLog>();
  });
});
