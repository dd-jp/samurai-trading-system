import {
  type AlpacaCalendarDay,
  AlpacaCalendarFetchError,
  AlpacaEquitySessionCalendar,
  AlpacaHttpCalendarClient,
  buildAlpacaSessionTable,
} from './alpaca-session-calendar.js';

const FAKE_KEY = 'test-fake-alpaca-key';
const FAKE_SECRET = 'test-fake-alpaca-secret';

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('AlpacaHttpCalendarClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits GET /v2/calendar on the paper host with the Alpaca auth headers and date range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpCalendarClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    await client.fetchCalendar({ start: '2026-08-01', end: '2026-08-31' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://paper-api.alpaca.markets/v2/calendar?start=2026-08-01&end=2026-08-31',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe(FAKE_KEY);
    expect(headers['APCA-API-SECRET-KEY']).toBe(FAKE_SECRET);
  });

  it('parses a row into {date, open, close}, ignoring fields it does not read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          date: '2026-11-27',
          open: '09:30',
          close: '13:00',
          session_open: '0400',
          session_close: '1700',
          settlement_date: '2026-11-30',
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpCalendarClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });
    const days = await client.fetchCalendar({ start: '2026-11-01', end: '2026-11-30' });

    expect(days).toEqual([{ date: '2026-11-27', open: '09:30', close: '13:00' }]);
  });

  it('throws on a malformed row rather than passing it through', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ date: '2026-11-27', open: '09:30' }]));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpCalendarClient({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET });

    await expect(client.fetchCalendar({ start: '2026-11-01', end: '2026-11-30' })).rejects.toThrow(
      AlpacaCalendarFetchError,
    );
  });

  it('retries a 500 and eventually throws a retryable AlpacaCalendarFetchError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'boom' }, 500, 'Internal Error'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpCalendarClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });

    await expect(client.fetchCalendar({ start: '2026-11-01', end: '2026-11-30' })).rejects.toThrow(
      /Alpaca calendar request failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx — a bad key or bad params will not fix itself', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401, 'Unauthorized'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AlpacaHttpCalendarClient({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });

    await expect(client.fetchCalendar({ start: '2026-11-01', end: '2026-11-30' })).rejects.toThrow(
      /Alpaca calendar request failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when ALPACA_API_KEY/SECRET are not set and none is passed explicitly', () => {
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    try {
      expect(() => new AlpacaHttpCalendarClient()).toThrow(/ALPACA_API_KEY/);
    } finally {
      if (savedKey !== undefined) process.env.ALPACA_API_KEY = savedKey;
      if (savedSecret !== undefined) process.env.ALPACA_API_SECRET = savedSecret;
    }
  });
});

describe('buildAlpacaSessionTable', () => {
  it('keys rows by their own date field', () => {
    const days: AlpacaCalendarDay[] = [
      { date: '2026-08-17', open: '09:30', close: '16:00' },
      { date: '2026-11-27', open: '09:30', close: '13:00' },
    ];

    const table = buildAlpacaSessionTable(days);

    expect(table.get('2026-08-17')).toEqual({ openMinutes: 570, closeMinutes: 960 });
    expect(table.get('2026-11-27')).toEqual({ openMinutes: 570, closeMinutes: 780 });
  });

  it('throws on a row whose open is not before its close', () => {
    expect(() =>
      buildAlpacaSessionTable([{ date: '2026-08-17', open: '16:00', close: '09:30' }]),
    ).toThrow(/open .* close/);
  });

  it('throws on an unparsable wall-clock time', () => {
    expect(() =>
      buildAlpacaSessionTable([{ date: '2026-08-17', open: '9:30am', close: '16:00' }]),
    ).toThrow(/not HH:MM/);
  });
});

describe('AlpacaEquitySessionCalendar', () => {
  /**
   * The scenario #684 exists for: 2026-08-17 is not a real early close and is
   * used here only as a stand-in date NOT in the hand-entered
   * `US_EARLY_CLOSE_DAYS` table — proving the early close comes from the
   * FETCHED table, not from the table #684 replaces.
   */
  const table = buildAlpacaSessionTable([
    { date: '2026-08-17', open: '09:30', close: '13:00' }, // an early close absent from the hand table
    { date: '2026-08-18', open: '09:30', close: '16:00' },
    { date: '2026-08-19', open: '09:30', close: '16:00' },
  ]);
  const calendar = new AlpacaEquitySessionCalendar(table);

  it('is a trading day exactly on the dates the fetched table lists', () => {
    expect(calendar.isTradingDay(new Date('2026-08-17T15:00:00Z'))).toBe(true);
    // A Saturday, absent from the table — no separate weekend rule needed.
    expect(calendar.isTradingDay(new Date('2026-08-15T15:00:00Z'))).toBe(false);
  });

  it('computes isOpen from the FETCHED early close, not a hand-entered one', () => {
    // 13:00 ET = 17:00 UTC in August (EDT).
    expect(calendar.isOpen(new Date('2026-08-17T16:59:00Z'))).toBe(true);
    expect(calendar.isOpen(new Date('2026-08-17T17:00:00Z'))).toBe(false);
  });

  it('resolves sessionEnd to the fetched early close, not a phantom 16:00', () => {
    const end = calendar.sessionEnd(new Date('2026-08-17T14:00:00Z'));
    expect(end?.toISOString()).toBe('2026-08-17T17:00:00.000Z');
  });

  it('resolves sessionEnd to the fetched 16:00 close on an ordinary day', () => {
    const end = calendar.sessionEnd(new Date('2026-08-18T14:00:00Z'));
    expect(end?.toISOString()).toBe('2026-08-18T20:00:00.000Z');
  });

  it('resolves sessionStart to the prior fetched close', () => {
    expect(calendar.sessionStart(new Date('2026-08-19T14:00:00Z'))).toEqual(
      new Date('2026-08-18T20:00:00Z'),
    );
  });

  it('treats a date outside the fetched window as no session — the safe direction', () => {
    expect(calendar.isTradingDay(new Date('2026-01-01T15:00:00Z'))).toBe(false);
    expect(calendar.isOpen(new Date('2026-01-01T15:00:00Z'))).toBe(false);
  });

  it('throws when the forward walk exhausts the table rather than guessing a close', () => {
    expect(() => calendar.sessionEnd(new Date('2026-08-19T21:00:00Z'))).toThrow(
      /no session close found within/,
    );
  });
});
