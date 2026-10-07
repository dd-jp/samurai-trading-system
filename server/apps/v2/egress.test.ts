import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import type { DailyBar, LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import type {
  AlpacaAccount,
  AlpacaBrokerClient,
  AlpacaOrder,
} from './execution/alpaca/alpaca-client.js';
import { writeTokenFile } from './execution/saxo/saxo-token-file.js';
import { composeV2Root, rootOptionsFor, type V2Root } from './index.js';
import { CapitalConfigStore } from './risk/index.js';
import { isLseInstrument } from './signal/index.js';
import { LSE_LIQUIDITY_SCREEN } from './signal/parameters.js';
import { SECRET_ENV_NAMES } from './signal/secret-guard.js';

const tokenFiles = vi.hoisted(() => ({ directory: undefined as string | undefined }));

vi.mock('./execution/saxo/saxo-token-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execution/saxo/saxo-token-file.js')>();
  return {
    ...actual,
    tokenFilePath: (environment: Parameters<typeof actual.tokenFilePath>[0]) =>
      tokenFiles.directory === undefined
        ? actual.tokenFilePath(environment)
        : join(tokenFiles.directory, `${environment}.json`),
  };
});

const NOUS_BASE_URL = 'https://nous.egress.test/v1';
const NOUS_KEY = 'sentinel-nous-debate-key-5c1e';

const SECRET_ENV: Readonly<Record<string, string>> = {
  ALPACA_API_KEY: 'sentinel-alpaca-api-key-0a1b',
  ALPACA_API_SECRET: 'sentinel-alpaca-api-secret-2c3d',
  ALPACA_LIVE_API_KEY: 'sentinel-alpaca-live-key-4e5f',
  ALPACA_LIVE_API_SECRET: 'sentinel-alpaca-live-secret-6a7b',
  SAXO_SIM_ACCESS_TOKEN: 'sentinel-saxo-sim-access-8c9d',
  SAXO_LIVE_ACCESS_TOKEN: 'sentinel-saxo-live-access-0e1f',
  SAXO_SIM_ACCOUNT_KEY: 'sentinel-saxo-sim-account-key-7d1c',
  SAXO_LIVE_ACCOUNT_KEY: 'sentinel-saxo-live-account-key-9f3a',
  SAXO_SIM_APP_KEY: 'sentinel-saxo-sim-app-key-2a3b',
  SAXO_SIM_APP_SECRET: 'sentinel-saxo-sim-app-secret-4c5d',
  SAXO_LIVE_APP_KEY: 'sentinel-saxo-live-app-key-6e7f',
  SAXO_LIVE_APP_SECRET: 'sentinel-saxo-live-app-secret-8a9b',
  SAXO_TOKEN: 'sentinel-saxo-token-0c1d',
  SAXO_APP_KEY: 'sentinel-saxo-app-key-2e3f',
  TELEGRAM_BOT_TOKEN: 'sentinel-telegram-bot-token-4a5b',
  HEALTHCHECKS_PING_URL: 'https://hc-ping.egress.test/sentinel-ping-6c7d',
  HEALTHCHECKS_TELEGRAM_PING_URL: 'https://hc-ping.egress.test/sentinel-telegram-9e2f',
  HEALTHCHECKS_SIGNALS_PING_URL: 'https://hc-ping.egress.test/sentinel-signals-3d7a',
  LITESTREAM_SSE_C_KEY: 'sentinel-litestream-sse-c-key-8e9f',
  POLYGON_API_KEY: 'sentinel-polygon-api-key-0a2b',
  MARKETAUX_API_TOKEN: 'sentinel-marketaux-api-token-1c3d',
  MARKETAUX_API_KEY: 'sentinel-marketaux-api-key-5b2e',
  NOUS_API_KEY: 'sentinel-nous-shared-key-4e6f',
  NOUS_SENTIMENT_API_KEY: 'sentinel-nous-sentiment-key-7a8b',
  TIINGO_API_KEY: 'sentinel-tiingo-api-key-9c0e',
  R2_ACCESS_KEY_ID: 'sentinel-r2-access-key-id-1f2a',
  R2_SECRET_ACCESS_KEY: 'sentinel-r2-secret-access-key-3b4c',
  SAMURAI_DASHBOARD_TOKEN: 'sentinel-dashboard-token-5d6e',
};

const ENV: Readonly<Record<string, string>> = {
  ...SECRET_ENV,
  NOUS_BASE_URL,
  NOUS_DEBATE_API_KEY: NOUS_KEY,
};

const SAXO_TOKENS = {
  accessToken: 'sentinel-saxo-file-access-9c0d',
  refreshToken: 'sentinel-saxo-file-refresh-1e2f',
};

const ACCOUNT = {
  account_number: 'PA-SENTINEL-ACCT-3a4b',
  id: 'sentinel-alpaca-account-id-5c6d',
  cash: '918273.64',
  equity: '827364.55',
  buying_power: '736455.46',
  portfolio_value: '645546.37',
};

const START_CAPITAL_GBP = 4_321.87;
const LOSS_CAP_GBP = 1_234.56;

const ACCOUNT_DATA = [
  ...Object.values(ACCOUNT),
  String(START_CAPITAL_GBP),
  String(LOSS_CAP_GBP),
  'v2-debate-primary-',
  'alp-1',
];

const FORBIDDEN = [...Object.values(SECRET_ENV), ...Object.values(SAXO_TOKENS), ...ACCOUNT_DATA];

const HEADLINE = 'UP beats on revenue';
const ORIGIN = Date.UTC(2026, 0, 1);
const dateAt = (index: number) => new Date(ORIGIN + index * 86_400_000).toISOString().slice(0, 10);
const ENTRY_DATE = dateAt(260);
const NEXT_DATE = dateAt(261);

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

async function writeFixtures(directory: string) {
  const bars: DailyBar[] = [];
  for (let i = 0; i <= 261; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    bars.push({
      date: dateAt(i),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  const barStoreRoot = join(directory, 'parquet');
  const store = await ParquetBarStore.open(barStoreRoot);
  await store.write('alpaca', [
    { symbol: 'UP', bars },
    { symbol: 'SPY', bars },
  ]);
  await store.write('saxo', [
    { symbol: 'ISF', bars },
    { symbol: 'IUSA', bars },
  ]);
  store.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\nUP,10,0\n');
  return {
    barStoreRoot,
    constituentsPath,
    fxPath,
    spreadsPath,
    saxoSpreadsPath: join(directory, 'no-saxo-spreads.csv'),
  };
}

function fakeAlpacaClient(clock: SimulatedClock): AlpacaBrokerClient {
  const orders: AlpacaOrder[] = [];
  const filled = (order: AlpacaOrder): AlpacaOrder => ({
    ...order,
    status: 'filled',
    filled_qty: order.qty,
    filled_avg_price: order.limit_price ?? '0',
    filled_at: clock.now().toISOString(),
  });
  const leg = (id: string, type: 'limit' | 'stop') => ({
    id,
    type,
    status: 'held',
    filled_qty: '0',
    filled_avg_price: null,
    filled_at: null,
  });
  return {
    submitOrder: (request) => {
      const id = `alp-${orders.length + 1}`;
      const order: AlpacaOrder = {
        id,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'bracket',
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.limit_price,
        legs: [leg(`${id}-tp`, 'limit'), leg(`${id}-sl`, 'stop')],
      };
      orders.push(order);
      return Promise.resolve(order);
    },
    getOrder: (id) => {
      const order = orders.find((candidate) => candidate.id === id);
      return order === undefined
        ? Promise.reject(new Error(`no order ${id}`))
        : Promise.resolve(filled(order));
    },
    getOrderByClientOrderId: (clientOrderId) => {
      const order = orders.find((candidate) => candidate.client_order_id === clientOrderId);
      return Promise.resolve(order === undefined ? null : filled(order));
    },
    submitMarketOrder: () => Promise.reject(new Error('unused')),
    submitOcoOrder: () => Promise.reject(new Error('unused')),
    cancelOrder: () => Promise.resolve(),
    listOpenOrders: () => Promise.resolve([]),
    listOrderHistory: () => Promise.resolve([]),
    getPositions: () => Promise.resolve([]),
    getAccount: () => Promise.resolve(ACCOUNT as AlpacaAccount),
  };
}

function nousReply(model: string, prompt: string): Response {
  const content = prompt.includes('Mediator persona')
    ? '{"stance":"bullish","rationale":"egress","converged":true}'
    : '{"stance":"bullish","rationale":"egress"}';
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
}

function captureEgress(captured: CapturedRequest[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : '';
      captured.push({ url, headers: { ...(init.headers as Record<string, string>) }, body });
      if (url !== `${NOUS_BASE_URL}/chat/completions`) {
        return Promise.reject(new Error(`unexpected egress to ${url}`));
      }
      const request = JSON.parse(body) as {
        model: string;
        messages: Array<{ content: string }>;
      };
      return Promise.resolve(nousReply(request.model, request.messages[0]?.content ?? ''));
    }),
  );
}

function writeSaxoTokenFiles(directory: string, now: Date): void {
  for (const environment of ['sim', 'live'] as const) {
    writeTokenFile(join(directory, `${environment}.json`), {
      environment,
      ...SAXO_TOKENS,
      accessTokenExpiresAt: new Date(now.getTime() + 1_200_000).toISOString(),
      refreshTokenExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      obtainedAt: new Date(now.getTime() - 60_000).toISOString(),
    });
  }
}

function heldPositionOf(root: V2Root): string[] {
  const held = root.books.position('debate/primary', 'UP');
  if (held === undefined || held.stopGbp === undefined) {
    throw new Error('egress test: day 2 must open with a stopped UP position in debate/primary');
  }
  return [`${held.qty} shares`, String(held.avgPriceGbp), String(held.stopGbp)];
}

function leaksIn(text: string, held: readonly string[] = []): string[] {
  return [...FORBIDDEN, ...held].filter((value) => text.includes(value));
}

function seedCapital(storePath: string, clock: SimulatedClock): void {
  const seed = migratedMemoryStore();
  new CapitalConfigStore(seed, clock).setYear(2026, START_CAPITAL_GBP, LOSS_CAP_GBP);
  writeFileSync(storePath, seed.serialize());
  seed.close();
}

describe('LLM egress (doc 67 Step 4b, keys and egress)', () => {
  let directory: string;
  const configuredScreen = LSE_LIQUIDITY_SCREEN.value;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'v2-egress-'));
    tokenFiles.directory = directory;
    Object.assign(LSE_LIQUIDITY_SCREEN, { value: 1 });
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  });

  afterEach(() => {
    Object.assign(LSE_LIQUIDITY_SCREEN, { value: configuredScreen });
    tokenFiles.directory = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  it('carries no key, token or account data in any request over two paper days, US and LSE', async () => {
    const fixtures = await writeFixtures(directory);
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    writeSaxoTokenFiles(directory, clock.now());
    const storePath = join(directory, 'paper.sqlite');
    seedCapital(storePath, clock);
    const alpacaClient = fakeAlpacaClient(clock);
    const captured: CapturedRequest[] = [];
    captureEgress(captured);

    const debatedSymbols: string[][] = [];
    const heldPosition: string[] = [];
    for (const tradingDate of [ENTRY_DATE, NEXT_DATE]) {
      clock.advanceTo(new Date(`${tradingDate}T07:00:00.000Z`));
      const newsCalls: string[] = [];
      const root = composeV2Root({
        ...rootOptionsFor(false, tradingDate, { ...ENV }, clock, { log: () => {} }),
        ...fixtures,
        storePath,
        alpacaClient,
        newsSource: {
          headlines: (symbol) => {
            newsCalls.push(symbol);
            return Promise.resolve([`${symbol === 'UP' ? HEADLINE : `${symbol} steady`}`]);
          },
        },
      });
      const before = captured.length;
      try {
        if (tradingDate === NEXT_DATE) heldPosition.push(...heldPositionOf(root));
        await root.run();
      } finally {
        root.close();
      }
      expect(captured.length - before).toBeGreaterThanOrEqual(3 * newsCalls.length);
      debatedSymbols.push(newsCalls);
    }

    expect(debatedSymbols[0]).toContain('UP');
    expect(debatedSymbols[0]?.some(isLseInstrument)).toBe(true);
    expect(debatedSymbols[1]).toContain('UP');
    expect(captured.every((request) => request.url === `${NOUS_BASE_URL}/chat/completions`)).toBe(
      true,
    );
    expect(captured.some((request) => request.body.includes(HEADLINE))).toBe(true);
    expect(heldPosition).toHaveLength(3);
    for (const request of captured) {
      expect(leaksIn(request.url, heldPosition)).toEqual([]);
      expect(leaksIn(request.body, heldPosition)).toEqual([]);
      expect(request.headers).toEqual({
        'content-type': 'application/json',
        authorization: `Bearer ${NOUS_KEY}`,
      });
    }
  });

  it('would catch a leak: a body carrying a sentinel is reported', () => {
    expect(leaksIn(`{"messages":[{"content":"cash ${ACCOUNT.cash}"}]}`)).toEqual([ACCOUNT.cash]);
    expect(leaksIn(`token ${SAXO_TOKENS.refreshToken}`)).toEqual([SAXO_TOKENS.refreshToken]);
    expect(leaksIn(`key ${SECRET_ENV.ALPACA_API_SECRET}`)).toEqual([SECRET_ENV.ALPACA_API_SECRET]);
    expect(leaksIn('stop 19.34432', ['19.34432'])).toEqual(['19.34432']);
  });

  it('guards the same secret names the test seeds', () => {
    expect([...Object.keys(SECRET_ENV), 'NOUS_DEBATE_API_KEY'].sort()).toEqual(
      [...SECRET_ENV_NAMES].sort(),
    );
  });

  it('refuses a debate whose prompt would carry a secret and logs only its name', async () => {
    const fixtures = await writeFixtures(directory);
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    writeSaxoTokenFiles(directory, clock.now());
    const captured: CapturedRequest[] = [];
    captureEgress(captured);
    const logs: LogEntry[] = [];
    const planted: Record<string, string> = {
      UP: `${HEADLINE} ${SECRET_ENV.ALPACA_API_SECRET}`,
      ISF: `ISF steady ${SAXO_TOKENS.accessToken}`,
    };
    const debated: string[] = [];
    const storePath = join(directory, 'paper.sqlite');
    seedCapital(storePath, clock);
    const root = composeV2Root({
      ...rootOptionsFor(false, ENTRY_DATE, { ...ENV }, clock, { log: (entry) => logs.push(entry) }),
      ...fixtures,
      storePath,
      alpacaClient: fakeAlpacaClient(clock),
      newsSource: {
        headlines: (symbol) => {
          debated.push(symbol);
          return Promise.resolve([planted[symbol] ?? `${symbol} steady`]);
        },
      },
    });
    let upReasons: string[] = [];
    try {
      await root.run();
      upReasons = (
        root.db
          .prepare(
            "SELECT reason FROM v2_decisions WHERE instrument = 'UP' AND book_id LIKE 'debate/%'",
          )
          .all() as { reason: string }[]
      ).map((row) => row.reason);
    } finally {
      root.close();
    }

    expect(upReasons.length).toBeGreaterThan(0);
    for (const reason of upReasons) {
      expect(reason).toContain('llm_error:');
      expect(reason).toContain('ALPACA_API_SECRET');
      expect(reason).not.toContain(SECRET_ENV.ALPACA_API_SECRET);
    }
    const values = Object.values(planted).map((headline) => headline.split(' ').at(-1) ?? '');
    for (const request of captured) {
      for (const value of values) expect(request.body).not.toContain(value);
    }
    const refused = logs
      .filter((entry) => entry.event === 'v2_llm_secret_refused')
      .map((entry) => (entry.payload as { secret: string }).secret);
    expect(new Set(refused)).toEqual(
      new Set(['ALPACA_API_SECRET', 'saxo-tokens/sim.json accessToken']),
    );
    expect(debated.filter((symbol) => planted[symbol] === undefined).length).toBeGreaterThan(0);
    expect(captured.length).toBeGreaterThan(0);
    for (const value of values) expect(JSON.stringify(logs)).not.toContain(value);
  });
});
