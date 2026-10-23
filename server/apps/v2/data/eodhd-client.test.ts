import {
  assertWindow,
  dividendsUrl,
  EODHD_API_URL,
  EodhdClient,
  EodhdRequestError,
  eodhdSymbol,
  parseDividendsBody,
  parseSplitRatio,
  parseSplitsBody,
  splitsUrl,
} from './eodhd-client.js';

const API_KEY = 'secret-token-value';
const NOW = new Date('2026-10-09T21:30:00.000Z');
const HISTORY = { from: '1980-01-01', to: '2026-10-09' };

// shape of GET /api/splits/AAPL.US?fmt=json per EODHD's splits documentation; dates are Apple's splits
const AAPL_SPLITS_FIXTURE = [
  { date: '1987-06-16', split: '2.000000/1.000000' },
  { date: '2000-06-21', split: '2.000000/1.000000' },
  { date: '2005-02-28', split: '2.000000/1.000000' },
  { date: '2014-06-09', split: '7.000000/1.000000' },
  { date: '2020-08-31', split: '4.000000/1.000000' },
];

const ODD_SPLITS_FIXTURE = [
  { date: '2026-03-02', split: '1.000000/200.000000' },
  { date: '2025-06-16', split: '6.000000/5.000000' },
];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function clientReturning(response: Response | Error, seen: URL[] = []): EodhdClient {
  const fetchImpl = (async (input: URL) => {
    seen.push(input);
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return new EodhdClient(API_KEY, fetchImpl, () => NOW);
}

async function reason(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof EodhdRequestError ? error.reason : error),
  );
}

describe('eodhdSymbol', () => {
  it('suffixes the exchange and writes a share-class dot as a dash', () => {
    expect(eodhdSymbol('AAPL', 'US')).toBe('AAPL.US');
    expect(eodhdSymbol('BRK.B', 'US')).toBe('BRK-B.US');
    expect(eodhdSymbol('SGLN', 'LSE')).toBe('SGLN.LSE');
  });
});

describe('parseSplitRatio', () => {
  it('reads new over old shares', () => {
    expect(parseSplitRatio('4.000000/1.000000')).toBe(4);
    expect(parseSplitRatio('6.000000/5.000000')).toBeCloseTo(1.2, 12);
    expect(parseSplitRatio('1.000000/200.000000')).toBe(0.005);
    expect(parseSplitRatio('3/2')).toBe(1.5);
  });

  it('refuses anything that is not a positive finite ratio', () => {
    for (const text of ['4', '4:1', '0/1', '1/0', '-1/2', ' 2/1', '2/1 ', '', 4, undefined, null]) {
      expect(parseSplitRatio(text)).toBeUndefined();
    }
  });
});

describe('assertWindow', () => {
  it('accepts a one-day window and refuses inverted or malformed ones', () => {
    expect(() => assertWindow({ from: '2026-10-09', to: '2026-10-09' })).not.toThrow();
    for (const window of [
      { from: '2026-10-10', to: '2026-10-09' },
      { from: '2026-02-30', to: '2026-03-09' },
      { from: '2026-01-01', to: '2026-13-01' },
      { from: '2026-01-01', to: '2026-1-9' },
      { from: '20260101', to: '2026-01-09' },
    ]) {
      expect(() => assertWindow(window)).toThrow(EodhdRequestError);
    }
  });
});

describe('parseSplitsBody', () => {
  it('reads the recorded splits in date order', () => {
    expect(parseSplitsBody(ODD_SPLITS_FIXTURE, HISTORY)).toEqual([
      { date: '2025-06-16', ratio: 1.2 },
      { date: '2026-03-02', ratio: 0.005 },
    ]);
    expect(parseSplitsBody(AAPL_SPLITS_FIXTURE, HISTORY).map((split) => split.ratio)).toEqual([
      2, 2, 2, 7, 4,
    ]);
    expect(parseSplitsBody([], HISTORY)).toEqual([]);
  });

  it('refuses a body that is not an array of dated ratios', () => {
    for (const body of [
      undefined,
      { splits: [] },
      [null],
      ['2020-08-31'],
      [{ date: '2020-08-31' }],
      [{ date: '2020-8-31', split: '4.000000/1.000000' }],
      [{ date: '2020-08-32', split: '4.000000/1.000000' }],
      [{ date: '2020-08-31', split: '4.000000:1.000000' }],
      [
        { date: '2020-08-31', split: '4.000000/1.000000' },
        { date: '2020-08-31', split: '2.000000/1.000000' },
      ],
    ]) {
      expect(() => parseSplitsBody(body, HISTORY)).toThrow(
        expect.objectContaining({ reason: 'bad_body' }),
      );
    }
  });

  it('refuses a read holding a split outside the asked window on either side', () => {
    const window = { from: '2000-06-21', to: '2014-06-09' };
    expect(parseSplitsBody(AAPL_SPLITS_FIXTURE.slice(1, 4), window)).toHaveLength(3);
    expect(() => parseSplitsBody(AAPL_SPLITS_FIXTURE.slice(0, 4), window)).toThrow(
      expect.objectContaining({ reason: 'out_of_window' }),
    );
    expect(() => parseSplitsBody(AAPL_SPLITS_FIXTURE.slice(1), window)).toThrow(
      expect.objectContaining({ reason: 'out_of_window' }),
    );
  });
});

describe('splitsUrl', () => {
  it('asks the splits endpoint for the window as JSON', () => {
    const url = splitsUrl(API_KEY, 'BRK-B.US', { from: '2020-01-01', to: '2026-10-09' });
    expect(`${url.origin}${url.pathname}`).toBe(`${EODHD_API_URL}/splits/BRK-B.US`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2020-01-01',
      to: '2026-10-09',
      fmt: 'json',
      api_token: API_KEY,
    });
  });
});

describe('EodhdClient.splits', () => {
  it('returns the read with its window and the UTC date it was made', async () => {
    const seen: URL[] = [];
    const read = await clientReturning(jsonResponse(AAPL_SPLITS_FIXTURE), seen).splits(
      'AAPL.US',
      HISTORY,
    );
    expect(seen.map(String)).toEqual([String(splitsUrl(API_KEY, 'AAPL.US', HISTORY))]);
    expect(read).toEqual({
      symbol: 'AAPL.US',
      from: HISTORY.from,
      to: HISTORY.to,
      asOf: '2026-10-09',
      splits: parseSplitsBody(AAPL_SPLITS_FIXTURE, HISTORY),
    });
  });

  it('refuses a bad window before any request', async () => {
    const seen: URL[] = [];
    const client = clientReturning(jsonResponse([]), seen);
    expect(await reason(client.splits('AAPL.US', { from: '2026-10-09', to: '2026-10-08' }))).toBe(
      'bad_window',
    );
    expect(seen).toEqual([]);
  });

  it('maps HTTP, body, network and timeout failures to reasons that never carry the token', async () => {
    const timeout = new Error(`timed out ${EODHD_API_URL}?api_token=${API_KEY}`);
    timeout.name = 'TimeoutError';
    const cases: [Response | Error, string][] = [
      [jsonResponse({ error: 'Unauthenticated' }, 401), 'http_401'],
      [jsonResponse([], 429), 'http_429'],
      [new Response('not json', { status: 200 }), 'bad_body'],
      [jsonResponse({ code: 'AAPL.US' }), 'bad_body'],
      [new TypeError(`fetch failed for ?api_token=${API_KEY}`), 'network'],
      [timeout, 'timeout'],
    ];
    for (const [response, expected] of cases) {
      const outcome = await clientReturning(response).splits('AAPL.US', HISTORY).catch(String);
      expect(outcome).toBe(`Error: ${expected}`);
    }
  });

  it('passes a timeout signal to the transport', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: URL, init?: RequestInit) => {
      signal = init?.signal;
      return jsonResponse([]);
    }) as typeof fetch;
    await new EodhdClient(API_KEY, fetchImpl, () => NOW).splits('AAPL.US', HISTORY);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

const DIVIDEND_WINDOW = { from: '2026-01-01', to: '2026-10-09' };

// shape of GET /api/div/{SYMBOL}?fmt=json per EODHD's dividends documentation
function dividendRecord(date: string, unadjustedValue: number, currency: string, value = 0.01) {
  return {
    date,
    declarationDate: '2025-12-01',
    recordDate: date,
    paymentDate: '2026-11-01',
    period: 'Interim',
    value,
    unadjustedValue,
    currency,
  };
}

describe('parseDividendsBody', () => {
  it('reads an LSE dividend in GBP, GBX or GBp as pounds per share from unadjustedValue', () => {
    const body = [
      dividendRecord('2026-06-04', 2.5, 'GBX'),
      dividendRecord('2026-02-05', 0.04, 'GBP', 0.02),
      dividendRecord('2026-09-03', 3, 'GBp'),
    ];
    expect(parseDividendsBody(body, 'VOD.LSE', DIVIDEND_WINDOW)).toEqual([
      { exDate: '2026-02-05', perShare: 0.04 },
      { exDate: '2026-06-04', perShare: 0.025 },
      { exDate: '2026-09-03', perShare: 0.03 },
    ]);
  });

  it('reads a US dividend in USD per share', () => {
    expect(
      parseDividendsBody([dividendRecord('2026-08-11', 0.26, 'USD')], 'AAPL.US', DIVIDEND_WINDOW),
    ).toEqual([{ exDate: '2026-08-11', perShare: 0.26 }]);
  });

  it('keeps a regular and a special dividend that share an ex-date', () => {
    const body = [
      dividendRecord('2026-08-11', 0.26, 'USD'),
      dividendRecord('2026-08-11', 1, 'USD'),
    ];
    expect(parseDividendsBody(body, 'AAPL.US', DIVIDEND_WINDOW)).toHaveLength(2);
  });

  it('refuses a currency the venue does not quote in', () => {
    const cases: [string, string][] = [
      ['VOD.LSE', 'USD'],
      ['VOD.LSE', 'EUR'],
      ['AAPL.US', 'GBP'],
      ['AAPL.US', 'GBX'],
    ];
    for (const [symbol, currency] of cases) {
      expect(() =>
        parseDividendsBody([dividendRecord('2026-08-11', 1, currency)], symbol, DIVIDEND_WINDOW),
      ).toThrow('bad_currency');
    }
  });

  it('refuses a symbol on an exchange it has no currency table for', () => {
    expect(() => parseDividendsBody([], 'VOD.XETRA', DIVIDEND_WINDOW)).toThrow('bad_symbol');
  });

  it('refuses a dividend outside the asked window', () => {
    for (const date of ['2025-12-31', '2026-10-10']) {
      expect(() =>
        parseDividendsBody([dividendRecord(date, 1, 'USD')], 'AAPL.US', DIVIDEND_WINDOW),
      ).toThrow('out_of_window');
    }
  });

  it('refuses a body that is not a list of well-formed dividends', () => {
    const bad: unknown[] = [
      { code: 'AAPL.US' },
      [null],
      [{ ...dividendRecord('2026-08-11', 1, 'USD'), date: '2026-13-01' }],
      [{ ...dividendRecord('2026-08-11', 1, 'USD'), unadjustedValue: '1' }],
      [dividendRecord('2026-08-11', 0, 'USD')],
      [dividendRecord('2026-08-11', -1, 'USD')],
      [dividendRecord('2026-08-11', 1, 'USD'), dividendRecord('2026-08-11', 1, 'USD')],
    ];
    for (const body of bad) {
      expect(() => parseDividendsBody(body, 'AAPL.US', DIVIDEND_WINDOW)).toThrow('bad_body');
    }
  });
});

describe('EodhdClient.dividends', () => {
  it('reads the div endpoint over the window and returns the parsed read', async () => {
    const seen: URL[] = [];
    const body = [dividendRecord('2026-08-11', 0.26, 'USD')];
    const read = await clientReturning(jsonResponse(body), seen).dividends(
      'AAPL.US',
      DIVIDEND_WINDOW,
    );
    expect(seen.map(String)).toEqual([String(dividendsUrl(API_KEY, 'AAPL.US', DIVIDEND_WINDOW))]);
    expect(seen[0]?.pathname).toBe('/api/div/AAPL.US');
    expect(read).toEqual({
      symbol: 'AAPL.US',
      ...DIVIDEND_WINDOW,
      asOf: '2026-10-09',
      dividends: [{ exDate: '2026-08-11', perShare: 0.26 }],
    });
  });

  it('refuses a bad window before any request and maps a bad body', async () => {
    const seen: URL[] = [];
    const client = clientReturning(jsonResponse({}), seen);
    expect(
      await reason(client.dividends('AAPL.US', { from: '2026-10-09', to: '2026-10-08' })),
    ).toBe('bad_window');
    expect(seen).toEqual([]);
    expect(await reason(client.dividends('AAPL.US', DIVIDEND_WINDOW))).toBe('bad_body');
  });
});
