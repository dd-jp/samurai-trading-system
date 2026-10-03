import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALPACA_ACTIVITY_MAX_PAGES } from './alpaca-activity-pages.js';
import { AlpacaBrokerProviderError } from './alpaca-broker-errors.js';
import { AlpacaCashInLieuReader, alpacaCashInLieuReader } from './alpaca-cash-in-lieu.js';
import type { AlpacaBrokerClient, AlpacaCashInLieuActivity } from './alpaca-client.js';
import { ALPACA_ACTIVITY_PAGE_SIZE, AlpacaHttpBrokerClient } from './alpaca-http-client.js';

const ACTIVITY: AlpacaCashInLieuActivity = {
  id: '20260929000000000::cil-1',
  activity_type: 'CIL',
  date: '2026-09-29',
  net_amount: '61.20',
  symbol: 'NVDA',
  qty: '0.5',
  status: 'executed',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function clientServing(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
  vi.stubGlobal('fetch', fetchMock);
  const client = new AlpacaHttpBrokerClient({
    apiKey: 'test-fake-alpaca-key',
    apiSecret: 'test-fake-alpaca-secret',
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return { client, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AlpacaHttpBrokerClient.listCashInLieu', () => {
  it('reads the CIL account activities after a date, oldest first, one page at a time', async () => {
    const { client, fetchMock } = clientServing([ACTIVITY]);
    await expect(client.listCashInLieu('2026-08-30')).resolves.toEqual([ACTIVITY]);
    await client.listCashInLieu('2026-08-30', 'tok::1');
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'https://paper-api.alpaca.markets/v2/account/activities/CIL?after=2026-08-30&direction=asc&page_size=100',
      'https://paper-api.alpaca.markets/v2/account/activities/CIL?after=2026-08-30&direction=asc&page_size=100&page_token=tok%3A%3A1',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('accepts an activity with no qty or a null one', async () => {
    const { qty: _qty, ...unstated } = ACTIVITY;
    const { client } = clientServing([unstated, { ...ACTIVITY, qty: null }]);
    await expect(client.listCashInLieu('2026-08-30')).resolves.toHaveLength(2);
  });

  it('accepts each status Alpaca gives a non-trade activity', async () => {
    const rows = (['executed', 'correct', 'canceled'] as const).map((status) => ({
      ...ACTIVITY,
      status,
    }));
    const { client } = clientServing(rows);
    await expect(client.listCashInLieu('2026-08-30')).resolves.toEqual(rows);
  });

  it.each([
    ['a body that is not an array', { activities: [] }, 'expected an array'],
    ['a row that is not an object', ['CIL'], 'an activity was not an object'],
    ['an empty id', [{ ...ACTIVITY, id: '' }], 'id must be a non-empty string'],
    ['a numeric id', [{ ...ACTIVITY, id: 7 }], 'id must be a non-empty string'],
    [
      'another activity type',
      [{ ...ACTIVITY, activity_type: 'DIV' }],
      "activity_type must be 'CIL'",
    ],
    ['a date-time', [{ ...ACTIVITY, date: '2026-09-29T00:00:00Z' }], 'date must be YYYY-MM-DD'],
    ['a prefixed date', [{ ...ACTIVITY, date: 'x2026-09-29' }], 'date must be YYYY-MM-DD'],
    ['a short year', [{ ...ACTIVITY, date: '226-09-29' }], 'date must be YYYY-MM-DD'],
    ['a short month', [{ ...ACTIVITY, date: '2026-9-29' }], 'date must be YYYY-MM-DD'],
    ['a short day', [{ ...ACTIVITY, date: '2026-09-9' }], 'date must be YYYY-MM-DD'],
    ['a numeric date', [{ ...ACTIVITY, date: 20260929 }], 'date must be YYYY-MM-DD'],
    [
      'an unparseable net amount',
      [{ ...ACTIVITY, net_amount: 'n/a' }],
      'net_amount must be a numeric string',
    ],
    [
      'a numeric net amount',
      [{ ...ACTIVITY, net_amount: 61.2 }],
      'net_amount must be a numeric string',
    ],
    ['an empty symbol', [{ ...ACTIVITY, symbol: '' }], 'symbol must be a non-empty string'],
    ['a missing symbol', [{ ...ACTIVITY, symbol: undefined }], 'symbol must be a non-empty string'],
    ['an unparseable qty', [{ ...ACTIVITY, qty: 'half' }], 'qty must be a numeric string or null'],
    ...[undefined, 'EXECUTED', 'pending'].map((status): [string, unknown, string] => [
      `a status of ${status}`,
      [{ ...ACTIVITY, status }],
      "status must be 'executed', 'correct' or 'canceled'",
    ]),
  ])('refuses %s', async (_name, body, detail) => {
    const { client } = clientServing(body);
    const read = client.listCashInLieu('2026-08-30');
    await expect(read).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
    await expect(read).rejects.toThrow(`malformed response body (listCashInLieu): ${detail} — `);
  });
});

describe('AlpacaCashInLieuReader', () => {
  it('maps each activity to the broker cash-in-lieu shape in USD', async () => {
    const reader = new AlpacaCashInLieuReader(async () => [
      ACTIVITY,
      { ...ACTIVITY, id: 'cil-2', qty: '-0.25', net_amount: '-3.10' },
      { ...ACTIVITY, id: 'cil-3', qty: '0' },
      { ...ACTIVITY, id: 'cil-4', qty: null, status: 'canceled' },
    ]);
    expect(reader.venue).toBe('alpaca');
    await expect(reader.read('2026-08-30')).resolves.toEqual([
      {
        activity_id: '20260929000000000::cil-1',
        instrument: 'NVDA',
        activity_date: '2026-09-29',
        qty: 0.5,
        amount: 61.2,
        currency: 'USD',
        status: 'executed',
      },
      expect.objectContaining({ activity_id: 'cil-2', qty: 0.25, amount: -3.1 }),
      expect.objectContaining({ activity_id: 'cil-3', qty: null }),
      expect.objectContaining({ activity_id: 'cil-4', qty: null, status: 'canceled' }),
    ]);
  });

  it('pages on the last id until a short page, passing the same date each time', async () => {
    const full = (prefix: string) =>
      Array.from({ length: ALPACA_ACTIVITY_PAGE_SIZE }, (_, i) => ({
        ...ACTIVITY,
        id: `${prefix}-${i}`,
      }));
    const pages = [full('a'), full('b'), [ACTIVITY]];
    const list = vi.fn(async () => pages.shift() ?? []);
    const read = await new AlpacaCashInLieuReader(list).read('2026-08-30');
    expect(read).toHaveLength(2 * ALPACA_ACTIVITY_PAGE_SIZE + 1);
    expect(list.mock.calls).toEqual([
      ['2026-08-30', undefined],
      ['2026-08-30', `a-${ALPACA_ACTIVITY_PAGE_SIZE - 1}`],
      ['2026-08-30', `b-${ALPACA_ACTIVITY_PAGE_SIZE - 1}`],
    ]);
  });

  it('fails rather than truncate a read that runs past the page limit', async () => {
    const page = Array.from({ length: ALPACA_ACTIVITY_PAGE_SIZE }, () => ACTIVITY);
    const list = vi.fn(async () => page);
    await expect(new AlpacaCashInLieuReader(list).read('2026-08-30')).rejects.toThrow(
      `Alpaca CIL activities since 2026-08-30 run past ${ALPACA_ACTIVITY_MAX_PAGES} pages`,
    );
    expect(list).toHaveBeenCalledTimes(ALPACA_ACTIVITY_MAX_PAGES);
  });
});

describe('alpacaCashInLieuReader', () => {
  it('reads through the client when it can list CIL activities, and is absent otherwise', async () => {
    expect(alpacaCashInLieuReader(undefined)).toBeUndefined();
    expect(alpacaCashInLieuReader({} as AlpacaBrokerClient)).toBeUndefined();
    const client = {
      calls: 0,
      async listCashInLieu(this: { calls: number }) {
        this.calls += 1;
        return [ACTIVITY];
      },
    };
    const reader = alpacaCashInLieuReader(client as unknown as AlpacaBrokerClient);
    await expect(reader?.read('2026-08-30')).resolves.toHaveLength(1);
    expect(client.calls).toBe(1);
  });
});
