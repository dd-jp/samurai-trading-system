import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlpacaBrokerClient, AlpacaOrder } from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { CommandRunner } from './backup.js';
import { type BarRefresh, NO_BAR_REFRESH } from './bar-refresh.js';
import type { CycleReport } from './cycle.js';
import { BarsMarketData, NO_NEWS, ParquetBarsSource, parseBoeGbpUsdCsv } from './data/index.js';
import {
  composeV2Root,
  DEFAULT_HALF_SPREAD_BPS,
  exitCodeFor,
  halfSpreadLookup,
  llmKeysPresent,
  logNewRefusals,
  main,
  nousOptionsFrom,
  parseCliArgs,
  runAfterPinCheck,
} from './index.js';
import { CapitalConfigStore } from './risk/index.js';
import type { ModelPin } from './signal/index.js';
import { BULLISH_SCRIPT, ScriptedTransport } from './signal/index.js';

interface Fixtures {
  directory: string;
  barStoreRoot: string;
  constituentsPath: string;
  fxPath: string;
  spreadsPath: string;
}

async function writeFixtures(): Promise<Fixtures> {
  const directory = mkdtempSync(join(tmpdir(), 'v2-root-'));
  const bars: DailyBar[] = [];
  const origin = Date.UTC(2026, 0, 1);
  for (let i = 0; i <= 260; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    const date = new Date(origin + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({
      date,
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
  store.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP,MISSING"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(
    spreadsPath,
    'symbol,sessions,median_half_spread_bps\n UP ,10,0\nBAD,1,abc\nNEG,1,-1\n',
  );
  return { directory, barStoreRoot, constituentsPath, fxPath, spreadsPath };
}

const LAST_CLOSE = 20 * (1 + 0.001 * 259);
const ENTRY_DATE = new Date(Date.UTC(2026, 0, 1) + 260 * 86_400_000).toISOString().slice(0, 10);
const NEXT_DATE = new Date(Date.UTC(2026, 0, 1) + 261 * 86_400_000).toISOString().slice(0, 10);

function seededStore(path = ':memory:'): StoreHandle {
  const db = openSharedStore(path);
  new CapitalConfigStore(db, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    1_000,
    1_500,
  );
  return db;
}

function count(root: { db: { prepare: (sql: string) => { get: () => unknown } } }, table: string) {
  return (root.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function scriptedFactory(transports: ScriptedTransport[]) {
  return (pin: ModelPin) => {
    const transport = new ScriptedTransport(pin, BULLISH_SCRIPT);
    transports.push(transport);
    return transport;
  };
}

function fakeAlpacaClient(clock: SimulatedClock): AlpacaBrokerClient & { orders: AlpacaOrder[] } {
  const orders: AlpacaOrder[] = [];
  const filled = (order: AlpacaOrder): AlpacaOrder => ({
    ...order,
    status: 'filled',
    filled_qty: order.qty,
    filled_avg_price: order.limit_price ?? '0',
    filled_at: clock.now().toISOString(),
  });
  return {
    orders,
    submitOrder: vi.fn((request) => {
      const order: AlpacaOrder = {
        id: `alp-${orders.length + 1}`,
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
        legs: [
          {
            id: `${orders.length + 1}-tp`,
            type: 'limit',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
          {
            id: `${orders.length + 1}-sl`,
            type: 'stop',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
        ],
      };
      orders.push(order);
      return Promise.resolve(order);
    }),
    getOrder: vi.fn((id: string) => {
      const order = orders.find((candidate) => candidate.id === id);
      return order === undefined
        ? Promise.reject(new Error(`no order ${id}`))
        : Promise.resolve(filled(order));
    }),
    getOrderByClientOrderId: vi.fn((clientOrderId: string) => {
      const order = orders.find((candidate) => candidate.client_order_id === clientOrderId);
      return Promise.resolve(order === undefined ? null : filled(order));
    }),
    submitMarketOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitOcoOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitLimitOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitStopLimitOrder: vi.fn().mockRejectedValue(new Error('unused')),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    listOpenOrders: vi.fn().mockResolvedValue([]),
    getPositions: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockRejectedValue(new Error('unused')),
  };
}

describe('composeV2Root', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('dry run: sizes, reaches the dry-run broker, submits nothing, journals every LLM call and fill', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const logger: Logger = { log: (entry) => logs.push(entry) };
    const storePath = join(fixtures.directory, 'dry.sqlite');
    seededStore(storePath).close();
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const open = (tradingDate: string) =>
      composeV2Root({ ...fixtures, tradingDate, dryRun: true, storePath, clock, logger });
    const root = open(ENTRY_DATE);
    try {
      expect(root.registry.ids()).toEqual(['debate', 'arm2']);
      expect(root.books.ids()).toEqual([
        'debate/primary',
        'debate/no-macro-gate',
        'arm2/technical-only',
      ]);
      const report = await root.run();
      expect(report).toMatchObject({
        decisions: 2,
        entries: 3,
        submitted_orders: 0,
        dry_run_refusals: 1,
        simulated_orders: 2,
        rejected_orders: 0,
        fills: 0,
        sleeves: ['debate', 'arm2'],
      });
      expect(exitCodeFor(report)).toBe(0);
      expect(report.refusals.filter((refusal) => refusal.includes('needs David'))).toHaveLength(7);
      const decision = root.db
        .prepare('SELECT action, size_shares, stop_price FROM v2_decisions WHERE book_id = ?')
        .get('debate/primary') as { action: string; size_shares: number; stop_price: number };
      expect(decision.action).toBe('enter_long');
      expect(decision.size_shares).toBeGreaterThan(0);
      expect(decision.stop_price).toBeGreaterThan(0);
      expect(root.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'refused_dry_run',
        dry_run: true,
        payload: {
          size: decision.size_shares,
          approval: `entry:v2-debate-primary-${ENTRY_DATE}-UP:${decision.size_shares}`,
        },
      });
      expect(root.journal.orderFor(`v2-debate-no-macro-gate-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'simulated',
        payload: { approval: expect.stringMatching(/^entry:v2-debate-no-macro-gate-/) },
      });
      expect(root.journal.orderFor(`v2-arm2-technical-only-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'simulated',
        payload: { approval: expect.stringMatching(/^entry:v2-arm2-technical-only-/) },
      });
      expect(count(root, 'v2_orders')).toBe(3);
      expect(count(root, 'v2_fills')).toBe(0);
      expect(report.books.map((book) => book.positions)).toEqual([0, 0, 0]);
      const llmCalls = root.scriptedTransports.reduce((n, t) => n + t.calls.length, 0);
      expect(llmCalls).toBe(3);
      expect(count(root, 'llm_spend')).toBe(llmCalls);
      expect(count(root, 'llm_call_log')).toBe(llmCalls);
      expect(logs.some((entry) => entry.event === 'v2_llm_transport_scripted')).toBe(true);
      for (const transport of root.scriptedTransports) {
        for (const call of transport.calls) {
          expect(call.prompt).not.toMatch(/api[_-]?key|ALPACA|SAXO|account/i);
        }
      }
    } finally {
      root.close();
    }
    clock.advanceTo(new Date(`${NEXT_DATE}T07:00:00.000Z`));
    const next = open(NEXT_DATE);
    try {
      const report = await next.run();
      expect(report).toMatchObject({ fills: 3, entries: 0 });
      const size = next.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)?.payload.size;
      expect(next.books.position('debate/primary', 'UP')?.qty).toBe(size);
      const fx = new BarsMarketData(
        new ParquetBarsSource(fixtures.barStoreRoot, 'alpaca'),
        parseBoeGbpUsdCsv(readFileSync(fixtures.fxPath, 'utf8')),
      ).gbpUsdAtYearStart(2026);
      const fill = next.db
        .prepare('SELECT price_gbp, fee_gbp, trading_date FROM v2_fills WHERE book_id = ?')
        .get('debate/no-macro-gate') as {
        price_gbp: number;
        fee_gbp: number;
        trading_date: string;
      };
      expect(fill.price_gbp * fx).toBeCloseTo(LAST_CLOSE, 6);
      expect(fill.fee_gbp).toBeGreaterThan(0);
      expect(fill.trading_date).toBe(NEXT_DATE);
      expect(report.books.map((book) => book.positions)).toEqual([1, 1, 1]);
    } finally {
      next.close();
    }
  });

  it('paper mode: the primary reaches AlpacaBrokerAdapter.submitBracket, the fill is ingested, and the bracket survives a restart', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'paper.sqlite');
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const alpacaClient = fakeAlpacaClient(clock);
    const transports: ScriptedTransport[] = [];
    seededStore(storePath).close();
    const open = (tradingDate: string, newsCalls: string[]) =>
      composeV2Root({
        ...fixtures,
        tradingDate,
        dryRun: false,
        storePath,
        nousBaseUrl: 'https://nous.test/v1',
        nousApiKey: 'present',
        clock,
        logger: { log: () => {} },
        transportFor: scriptedFactory(transports),
        alpacaClient,
        newsSource: {
          headlines: (symbol) => {
            newsCalls.push(symbol);
            return Promise.resolve(['UP beats on revenue']);
          },
        },
      });
    const newsCalls: string[] = [];
    const first = open(ENTRY_DATE, newsCalls);
    let report: CycleReport;
    try {
      report = await first.run();
      expect(report).toMatchObject({
        dry_run: false,
        entries: 3,
        submitted_orders: 1,
        simulated_orders: 2,
        dry_run_refusals: 0,
        fills: 1,
      });
      expect(exitCodeFor(report)).toBe(0);
      expect(newsCalls).toEqual(['UP']);
      expect(alpacaClient.submitOrder).toHaveBeenCalledTimes(1);
      expect(alpacaClient.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          client_order_id: `v2-debate-primary-${ENTRY_DATE}-UP`,
          symbol: 'UP',
          side: 'buy',
          order_class: 'bracket',
          time_in_force: 'gtc',
        }),
      );
      const qty = Number(alpacaClient.orders[0]?.qty);
      expect(qty).toBeGreaterThan(0);
      expect(first.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'submitted',
        dry_run: false,
        payload: { approval: `entry:v2-debate-primary-${ENTRY_DATE}-UP:${qty}` },
      });
      expect(first.books.position('debate/primary', 'UP')?.qty).toBe(qty);
      expect(first.books.position('debate/no-macro-gate', 'UP')).toBeUndefined();
      expect(count(first, 'v2_fills')).toBe(1);
      expect(count(first, 'broker_brackets')).toBe(1);
      expect(
        transports
          .flatMap((t) => t.calls)
          .some((call) => call.prompt.includes('UP beats on revenue')),
      ).toBe(true);
    } finally {
      first.close();
    }
    clock.advanceTo(new Date(`${NEXT_DATE}T07:00:00.000Z`));
    const second = open(NEXT_DATE, newsCalls);
    try {
      const next = await second.run();
      expect(next).toMatchObject({ skipped: false, submitted_orders: 0, entries: 0 });
      expect(alpacaClient.getOrder).toHaveBeenCalled();
      expect(alpacaClient.submitOrder).toHaveBeenCalledTimes(1);
      expect(second.books.position('debate/primary', 'UP')?.marksHeld).toBe(2);
      expect(second.books.position('debate/no-macro-gate', 'UP')).toMatchObject({
        qty: Number(alpacaClient.orders[0]?.qty),
        marksHeld: 1,
      });
      expect(second.books.position('arm2/technical-only', 'UP')).toMatchObject({
        marksHeld: 1,
      });
    } finally {
      second.close();
    }
  });

  it('refuses entries but still runs without a capital config in force', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath: ':memory:',
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger: { log: () => {} },
    });
    try {
      expect(root.books.ids()).toEqual([]);
      const report = await root.run();
      expect(report).toMatchObject({ entries: 0, submitted_orders: 0, simulated_orders: 0 });
      expect(report.refusals.some((refusal) => refusal.includes('no capital config'))).toBe(true);
      expect(
        root.db.prepare("SELECT parameter FROM v2_refusals WHERE scope = 'capital'").get(),
      ).toEqual({ parameter: 'CAPITAL_CONFIG' });
      expect(count(root, 'v2_orders')).toBe(0);
    } finally {
      root.close();
    }
  });

  it('caps LLM calls at one in flight for the whole Nous account on the real transport factory', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const urls = new Set<string>();
    const authorizations = new Set<string>();
    const models: string[] = [];
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.add(url);
        authorizations.add((init.headers as Record<string, string>).authorization);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        models.push(model);
        const body = {
          model,
          choices: [
            { message: { content: '{"stance":"bullish","rationale":"x"}' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath: ':memory:',
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'nous-secret-key',
      alpacaClient: fakeAlpacaClient(new SimulatedClock(new Date())),
      newsSource: NO_NEWS,
      logger: { log: () => {} },
    });
    try {
      const request = {
        prompt: 'hello',
        context: { analyst_views: [] },
        parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
      };
      await Promise.all([
        root.panel.debaters.sonnet.complete(request),
        root.panel.judge.complete(request),
        root.panel.debaters.gpt.complete(request),
        root.panel.debaters.deepseek.complete(request),
      ]);
      expect(peak).toBe(1);
      expect([...urls]).toEqual(['https://nous.test/v1/chat/completions']);
      expect([...authorizations]).toEqual(['Bearer nous-secret-key']);
      expect(models.sort()).toEqual([
        'anthropic/claude-opus-5.5',
        'anthropic/claude-sonnet-5',
        'deepseek/deepseek-v4-pro-0813',
        'openai/gpt-5.5',
      ]);
      expect(count(root, 'llm_spend')).toBe(4);
    } finally {
      vi.unstubAllGlobals();
      root.close();
    }
  });

  it('logs each upstream model to stderr when the root is composed without a logger', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model,
              choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath: ':memory:',
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'present',
      alpacaClient: fakeAlpacaClient(new SimulatedClock(new Date())),
      newsSource: NO_NEWS,
    });
    try {
      await root.panel.judge.complete({
        prompt: 'hello',
        context: { analyst_views: [] },
        parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
      });
      const lines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('v2_llm_upstream_model'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        event: 'v2_llm_upstream_model',
        payload: { pinned: 'anthropic/claude-opus-5.5', upstream: 'anthropic/claude-opus-5.5' },
      });
    } finally {
      vi.unstubAllGlobals();
      stderr.mockRestore();
      root.close();
    }
  });

  it('refuses a paper run without LLM keys before opening the store', async () => {
    const fixtures = await writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'never.sqlite');
    expect(() =>
      composeV2Root({ ...fixtures, tradingDate: '2026-09-25', dryRun: false, storePath }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        nousBaseUrl: '',
        nousApiKey: 'x',
      }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        nousBaseUrl: 'https://nous.test/v1',
        nousApiKey: '',
      }),
    ).toThrow(/without NOUS_BASE_URL and a Nous key \(NOUS_DEBATE_API_KEY or NOUS_API_KEY\)/);
    expect(existsSync(storePath)).toBe(false);
  });

  it('refuses live mode', () => {
    expect(() =>
      composeV2Root({
        tradingDate: '2026-09-25',
        dryRun: true,
        samuraiMode: 'live',
        storePath: ':memory:',
      }),
    ).toThrow(/refuses SAMURAI_MODE=live/);
  });

  it('parses the CLI, detects LLM keys, and fails a dry run that submitted', () => {
    expect(parseCliArgs(['--dry-run', '--date', '2026-09-23'], '2026-09-25')).toEqual({
      dryRun: true,
      tradingDate: '2026-09-23',
    });
    expect(parseCliArgs([], '2026-09-25')).toEqual({ dryRun: false, tradingDate: '2026-09-25' });
    expect(() => parseCliArgs(['--date'], '2026-09-25')).toThrow(/--date needs/);
    expect(() => parseCliArgs(['--bogus'], '2026-09-25')).toThrow(/unknown argument/);
    expect(llmKeysPresent({ tradingDate: 'd', dryRun: true })).toBe(false);
    expect(
      llmKeysPresent({ tradingDate: 'd', dryRun: true, nousBaseUrl: 'a', nousApiKey: ' ' }),
    ).toBe(false);
    expect(
      llmKeysPresent({ tradingDate: 'd', dryRun: true, nousBaseUrl: ' ', nousApiKey: 'b' }),
    ).toBe(false);
    expect(
      llmKeysPresent({
        tradingDate: 'd',
        dryRun: true,
        nousBaseUrl: 'a',
        nousApiKey: 'b',
      }),
    ).toBe(true);
    const base = { submitted_orders: 0, dry_run: true } as CycleReport;
    expect(exitCodeFor(base)).toBe(0);
    expect(exitCodeFor({ ...base, submitted_orders: 1 })).toBe(1);
    expect(exitCodeFor({ ...base, submitted_orders: 1, dry_run: false })).toBe(0);
  });
});

describe('halfSpreadLookup', () => {
  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('merges alpaca (positional) and saxo (p25_half_spread_bps column) spreads, defaulting the rest', () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-spreads-'));
    const alpacaPath = join(directory, 'alpaca-spreads.csv');
    writeFileSync(alpacaPath, 'symbol,sessions,median_half_spread_bps\nAAPL,10,3\nBAD,1,abc\n');
    const saxoPath = join(directory, 'saxo-spreads.csv');
    writeFileSync(
      saxoPath,
      'symbol,uic,samples,p25_half_spread_bps,median_half_spread_bps,measured_at\nISF,4361,10,4,5,2026-09-23\nNEG,1,1,-1,-1,x\n',
    );
    const lookup = halfSpreadLookup(alpacaPath, saxoPath);
    expect(lookup('AAPL')).toBe(3);
    expect(lookup('ISF')).toBe(4);
    expect(lookup('BAD')).toBe(DEFAULT_HALF_SPREAD_BPS);
    expect(lookup('NEG')).toBe(DEFAULT_HALF_SPREAD_BPS);
    expect(lookup('UNKNOWN')).toBe(DEFAULT_HALF_SPREAD_BPS);
  });

  it('defaults every saxo instrument when the file is missing or lacks the p25 column', () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-spreads-'));
    const alpacaPath = join(directory, 'alpaca-spreads.csv');
    writeFileSync(alpacaPath, 'symbol,sessions,median_half_spread_bps\nAAPL,10,3\n');
    const missingPath = join(directory, 'absent.csv');
    expect(existsSync(missingPath)).toBe(false);
    expect(halfSpreadLookup(alpacaPath, missingPath)('ISF')).toBe(DEFAULT_HALF_SPREAD_BPS);
    const noColumnPath = join(directory, 'no-column.csv');
    writeFileSync(noColumnPath, 'symbol,uic\nISF,4361\n');
    expect(halfSpreadLookup(alpacaPath, noColumnPath)('ISF')).toBe(DEFAULT_HALF_SPREAD_BPS);
  });
});

describe('nousOptionsFrom', () => {
  it('reads the Nous env exactly as v1 does: trimmed, NOUS_DEBATE_API_KEY first, NOUS_API_KEY as fallback', () => {
    expect(nousOptionsFrom({})).toEqual({ nousBaseUrl: undefined, nousApiKey: undefined });
    expect(
      nousOptionsFrom({ NOUS_BASE_URL: 'https://nous.test/v1', NOUS_DEBATE_API_KEY: '  ' }),
    ).toEqual({
      nousBaseUrl: undefined,
      nousApiKey: undefined,
    });
    expect(nousOptionsFrom({ NOUS_BASE_URL: '  ', NOUS_DEBATE_API_KEY: 'k' })).toEqual({
      nousBaseUrl: undefined,
      nousApiKey: undefined,
    });
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: ' https://nous.test/v1 ',
        NOUS_DEBATE_API_KEY: ' debate-key ',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
    expect(
      nousOptionsFrom({ NOUS_BASE_URL: 'https://nous.test/v1', NOUS_API_KEY: 'shared' }),
    ).toEqual({
      nousBaseUrl: 'https://nous.test/v1',
      nousApiKey: 'shared',
    });
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: 'https://nous.test/v1',
        NOUS_DEBATE_API_KEY: 'debate-key',
        NOUS_API_KEY: 'shared',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
  });

  it("ignores v1's model knobs: an unpriced NOUS_DEBATE_MODEL does not stop a v2 run", () => {
    expect(
      nousOptionsFrom({
        NOUS_BASE_URL: 'https://nous.test/v1',
        NOUS_DEBATE_API_KEY: 'debate-key',
        NOUS_DEBATE_MODEL: 'vendor/unpriced-model',
      }),
    ).toEqual({ nousBaseUrl: 'https://nous.test/v1', nousApiKey: 'debate-key' });
  });
});

describe('runAfterPinCheck', () => {
  it('runs no cycle when the pin check refuses', async () => {
    const run = vi.fn();
    await expect(
      runAfterPinCheck({ run }, () => Promise.reject(new Error('snapshot swapped'))),
    ).rejects.toThrow('snapshot swapped');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the cycle only after the pin check settles', async () => {
    const order: string[] = [];
    const report = { dry_run: false } as CycleReport;
    const result = await runAfterPinCheck(
      {
        run: () => {
          order.push('run');
          return Promise.resolve(report);
        },
      },
      async () => {
        await Promise.resolve();
        order.push('pins');
      },
    );
    expect(order).toEqual(['pins', 'run']);
    expect(result).toBe(report);
  });
});

describe('logNewRefusals', () => {
  it('warns once with the new refusals, and stays silent without any', () => {
    const entries: LogEntry[] = [];
    const logger = { log: (entry: LogEntry) => entries.push(entry) };
    const refusal = (parameter: string, message: string) => ({
      trading_date: '2026-09-28',
      scope: 'data',
      parameter,
      ticket: '#1',
      message,
    });
    const days: Record<string, ReturnType<typeof refusal>[]> = {
      '2026-09-28': [refusal('A', 'a'), refusal('B', 'b')],
    };
    const journal = { newRefusals: (date: string) => days[date] ?? [] };
    logNewRefusals(journal, '2026-09-28', logger);
    logNewRefusals(journal, '2026-09-29', logger);
    expect(entries).toEqual([
      {
        trace_id: 'v2-2026-09-28',
        stage: 'v2',
        level: 'warn',
        event: 'v2_new_refusals',
        message: 'A: a\nB: b',
      },
    ]);
  });
});

describe('main', () => {
  const R2 = {
    R2_ACCESS_KEY_ID: 'a',
    R2_SECRET_ACCESS_KEY: 'b',
    R2_ENDPOINT: 'https://c.example',
    R2_BUCKET: 'd',
    LITESTREAM_SSE_C_KEY: 'e',
  };

  async function mainQuietly(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    run?: CommandRunner,
    barRefresh?: BarRefresh,
  ) {
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      return await main(argv, env, run, undefined, barRefresh);
    } finally {
      written.mockRestore();
    }
  }

  it('reports a bad argument before asking for backup variables', async () => {
    await expect(mainQuietly(['--bogus'], {})).rejects.toThrow('unknown argument --bogus');
  });

  it('refuses a paper run without its backup variables', async () => {
    await expect(mainQuietly(['--date', '2026-09-28'], {})).rejects.toThrow(
      /paper run refuses without its Litestream backup/,
    );
  });

  it('restores missing stores before the cycle and still backs up when the cycle fails', async () => {
    const commands: string[] = [];
    const run: CommandRunner = (_bin, args) => {
      commands.push(args[0] ?? '');
      return Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    };
    const calls: string[] = [];
    const barRefresh: BarRefresh = {
      run: () => {
        calls.push('refreshed');
        return Promise.resolve({ attempted: 0, updated: [], noNewBars: [], failed: [] });
      },
    };
    const research = join(mkdtempSync(join(tmpdir(), 'main-backup-')), 'research.sqlite');
    await expect(
      mainQuietly(
        ['--date', '2026-09-28'],
        { ...R2, SAMURAI_RESEARCH_STORE: research },
        run,
        barRefresh,
      ),
    ).rejects.toThrow(/without NOUS_BASE_URL and a Nous key/);
    expect(commands).toEqual(['version', 'restore', 'restore']);
    expect(calls).toEqual(['refreshed']);
  });

  it('restores the stores before refusing a paper run without Alpaca keys', async () => {
    const commands: string[] = [];
    const run: CommandRunner = (_bin, args) => {
      commands.push(args[0] ?? '');
      return Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    };
    const research = join(mkdtempSync(join(tmpdir(), 'main-backup-')), 'research.sqlite');
    await expect(
      mainQuietly(['--date', '2026-09-28'], { ...R2, SAMURAI_RESEARCH_STORE: research }, run),
    ).rejects.toThrow(/ALPACA_API_KEY and ALPACA_API_SECRET must be set/);
    expect(commands).toEqual(['version', 'restore', 'restore']);
  });

  it('sends a failed cycle to Telegram as critical and its warnings silently', async () => {
    const run: CommandRunner = (_bin, args) =>
      Promise.resolve({ code: 0, output: args[0] === 'version' ? '0.5.17' : '' });
    const research = join(mkdtempSync(join(tmpdir(), 'main-alerts-')), 'research.sqlite');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const env = {
      ...R2,
      SAMURAI_RESEARCH_STORE: research,
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: 'chat',
    };
    const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        main(['--date', '2026-09-28'], env, run, fetchImpl, NO_BAR_REFRESH),
      ).rejects.toThrow(/without NOUS_BASE_URL/);
    } finally {
      written.mockRestore();
    }
    const sent = fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
    expect(sent.map(([url]) => url)).toEqual([
      'https://api.telegram.org/botbot-token/sendMessage',
      'https://api.telegram.org/botbot-token/sendMessage',
    ]);
    const [critical, warning] = sent.map(([, body]) => body);
    expect(critical.disable_notification).toBe(false);
    expect(critical.text).toMatch(
      /^Samurai v2 CRITICAL\nv2_cycle_failed: v2 root refuses a paper run without NOUS_BASE_URL/,
    );
    expect(warning).toMatchObject({ chat_id: 'chat', disable_notification: true });
    expect(warning.text).toContain('v2_heartbeat_unset: HEALTHCHECKS_PING_URL is not set');
  });
});
