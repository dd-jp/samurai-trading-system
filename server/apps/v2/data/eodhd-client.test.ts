import {
  assertWindow,
  EODHD_API_URL,
  EodhdClient,
  EodhdRequestError,
  eodhdSymbol,
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
