import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALPACA_ACTIVITY_MAX_PAGES } from './alpaca-activity-pages.js';
import { AlpacaBrokerProviderError } from './alpaca-broker-errors.js';
import {
  AlpacaCashActivityReader,
  alpacaCashActivityReader,
  alpacaNonTradeCashTypes,
} from './alpaca-cash-activities.js';
import type { AlpacaBrokerClient, AlpacaCashActivity } from './alpaca-client.js';
import { ALPACA_ACTIVITY_PAGE_SIZE, AlpacaHttpBrokerClient } from './alpaca-http-client.js';

const ACTIVITY: AlpacaCashActivity = {
  id: '20261005000000000::div-1',
  activity_type: 'DIV',
  date: '2026-10-05',
  net_amount: '4.20',
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

describe('alpacaNonTradeCashTypes', () => {
  it('leaves out fills, cash in lieu, operator moves, corporate actions, crypto and MISC', () => {
    const excluded = ['FILL', 'CIL', 'CSD', 'CSW', 'JNLC', 'JNL', 'TRANS', 'MA', 'REORG', 'SPIN'];
    for (const type of [...excluded, 'SSO', 'SSP', 'CFEE', 'MISC']) {
      expect(alpacaNonTradeCashTypes()).not.toContain(type);
    }
    expect(alpacaNonTradeCashTypes()).toEqual([
      'DIV',
      'DIVCGL',
      'DIVCGS',
      'DIVFEE',
      'DIVFT',
      'DIVNRA',
      'DIVROC',
      'DIVTW',
      'DIVTXEX',
      'INT',
      'INTNRA',
      'INTTW',
      'FEE',
      'PTC',
      'PTR',
    ]);
  });
});

describe('AlpacaHttpBrokerClient.listCashActivities', () => {
  it('reads the named activity types after a date, oldest first, one page at a time', async () => {
    const { client, fetchMock } = clientServing([ACTIVITY]);
    await expect(client.listCashActivities(['DIV', 'FEE'], '2026-10-01')).resolves.toEqual([
      ACTIVITY,
    ]);
    await client.listCashActivities(['DIV'], '2026-10-01', 'tok::1');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://paper-api.alpaca.markets/v2/account/activities?activity_types=DIV%2CFEE&after=2026-10-01&direction=asc&page_size=100',
      'https://paper-api.alpaca.markets/v2/account/activities?activity_types=DIV&after=2026-10-01&direction=asc&page_size=100&page_token=tok%3A%3A1',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it.each([
    ['a body that is not an array', { activities: [] }, 'expected an array'],
    ['a row that is not an object', ['DIV'], 'an activity was not an object'],
    ['an empty id', [{ ...ACTIVITY, id: '' }], 'id must be a non-empty string'],
    ['a date-time', [{ ...ACTIVITY, date: '2026-10-05T00:00:00Z' }], 'date must be YYYY-MM-DD'],
    [
      'a numeric net amount',
      [{ ...ACTIVITY, net_amount: 4.2 }],
      'net_amount must be a numeric string',
    ],
    [
      'a status of pending',
      [{ ...ACTIVITY, status: 'pending' }],
      "status must be 'executed', 'correct' or 'canceled'",
    ],
    [
      'a type it did not ask for',
      [{ ...ACTIVITY, activity_type: 'CSD' }],
      'activity_type must be one of DIV, FEE',
    ],
    [
      'a missing type',
      [{ ...ACTIVITY, activity_type: undefined }],
      'activity_type must be one of DIV, FEE',
    ],
  ])('refuses %s', async (_name, body, detail) => {
    const { client } = clientServing(body);
    const read = client.listCashActivities(['DIV', 'FEE'], '2026-10-01');
    await expect(read).rejects.toBeInstanceOf(AlpacaBrokerProviderError);
    await expect(read).rejects.toThrow(
      `malformed response body (listCashActivities): ${detail} — `,
    );
  });
});

describe('AlpacaCashActivityReader', () => {
  it('asks for the non-trade cash types and maps each row to a signed amount', async () => {
    const list = vi.fn(
      async (): Promise<AlpacaCashActivity[]> => [
        ACTIVITY,
        { ...ACTIVITY, id: 'fee-1', activity_type: 'FEE', net_amount: '-0.03', status: 'canceled' },
      ],
    );
    const reader = new AlpacaCashActivityReader(list);
    expect(reader.venue).toBe('alpaca');
    await expect(reader.read('2026-10-01')).resolves.toEqual([
      {
        activity_id: '20261005000000000::div-1',
        activity_type: 'DIV',
        activity_date: '2026-10-05',
        amount: 4.2,
        status: 'executed',
      },
      {
        activity_id: 'fee-1',
        activity_type: 'FEE',
        activity_date: '2026-10-05',
        amount: -0.03,
        status: 'canceled',
      },
    ]);
    expect(list).toHaveBeenCalledWith(alpacaNonTradeCashTypes(), '2026-10-01', undefined);
  });

  it('pages on the last id until a short page', async () => {
    const full = Array.from({ length: ALPACA_ACTIVITY_PAGE_SIZE }, (_, i) => ({
      ...ACTIVITY,
      id: `a-${i}`,
    }));
    const pages = [full, [ACTIVITY]];
    const list = vi.fn(async () => pages.shift() ?? []);
    await expect(new AlpacaCashActivityReader(list).read('2026-10-01')).resolves.toHaveLength(
      ALPACA_ACTIVITY_PAGE_SIZE + 1,
    );
    expect(list.mock.calls.map((call) => call.slice(1))).toEqual([
      ['2026-10-01', undefined],
      ['2026-10-01', `a-${ALPACA_ACTIVITY_PAGE_SIZE - 1}`],
    ]);
  });
});

describe('AlpacaCashActivityReader page limit', () => {
  it('fails rather than truncate a read that runs past the page limit', async () => {
    const page = Array.from({ length: ALPACA_ACTIVITY_PAGE_SIZE }, () => ACTIVITY);
    await expect(new AlpacaCashActivityReader(async () => page).read('2026-10-01')).rejects.toThrow(
      `Alpaca non-trade cash activities since 2026-10-01 run past ${ALPACA_ACTIVITY_MAX_PAGES} pages`,
    );
  });
});

describe('alpacaCashActivityReader', () => {
  it('reads through the client when it can list activities, and is absent otherwise', async () => {
    expect(alpacaCashActivityReader(undefined)).toBeUndefined();
    expect(alpacaCashActivityReader({} as AlpacaBrokerClient)).toBeUndefined();
    const client = {
      calls: 0,
      async listCashActivities(this: { calls: number }) {
        this.calls += 1;
        return [ACTIVITY];
      },
    };
    const reader = alpacaCashActivityReader(client as unknown as AlpacaBrokerClient);
    await expect(reader?.read('2026-10-01')).resolves.toHaveLength(1);
    expect(client.calls).toBe(1);
  });
});
