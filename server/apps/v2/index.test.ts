import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlpacaBrokerClient, AlpacaOrder } from '../../pipeline/execution/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { CycleReport } from './cycle.js';
import { parseBoeGbpUsdCsv, yearStartGbpUsd } from './fx.js';
import { composeV2Root, exitCodeFor, llmKeysPresent, parseCliArgs } from './index.js';
import type { FetchLike } from './llm-transport.js';
import type { ModelPin } from './models.js';
import { NO_NEWS } from './news.js';
import { BULLISH_SCRIPT, ScriptedTransport } from './scripted-transport.js';

const HEADER = 'date,open,high,low,close,volume,raw_close';

interface Fixtures {
  directory: string;
  barsDirectory: string;
  constituentsPath: string;
  fxPath: string;
  spreadsPath: string;
}

function writeFixtures(): Fixtures {
  const directory = mkdtempSync(join(tmpdir(), 'v2-root-'));
  const rows: string[] = [HEADER];
  const origin = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 260; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    const date = new Date(origin + i * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${date},${close},${close * 1.01},${close * 0.99},${close},1000000,${close}`);
  }
  writeFileSync(join(directory, 'UP.csv'), `${rows.join('\n')}\n`);
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP,MISSING"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2024,1.25\n02 Jan 2025,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(
    spreadsPath,
    'symbol,sessions,median_half_spread_bps\n UP ,10,0\nBAD,1,abc\nNEG,1,-1\n',
  );
  return { directory, barsDirectory: directory, constituentsPath, fxPath, spreadsPath };
}

const LAST_CLOSE = 20 * (1 + 0.001 * 259);
const ENTRY_DATE = new Date(Date.UTC(2025, 0, 1) + 260 * 86_400_000).toISOString().slice(0, 10);
const NEXT_DATE = new Date(Date.UTC(2025, 0, 1) + 261 * 86_400_000).toISOString().slice(0, 10);

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
    const fixtures = writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const logger: Logger = { log: (entry) => logs.push(entry) };
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath: ':memory:',
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger,
    });
    try {
      expect(root.registry.ids()).toEqual(['debate']);
      expect(root.books.ids()).toEqual(['debate/primary', 'debate/no-macro-gate']);
      const report = await root.run();
      expect(report).toMatchObject({
        decisions: 1,
        entries: 2,
        submitted_orders: 0,
        dry_run_refusals: 1,
        simulated_orders: 1,
        rejected_orders: 0,
        fills: 2,
        sleeves: ['debate'],
      });
      expect(exitCodeFor(report)).toBe(0);
      expect(report.refusals.filter((refusal) => refusal.includes('needs David'))).toHaveLength(5);
      const decision = root.db
        .prepare('SELECT action, size_shares, stop_price FROM v2_decisions WHERE book_id = ?')
        .get('debate/primary') as { action: string; size_shares: number; stop_price: number };
      expect(decision.action).toBe('enter_long');
      expect(decision.size_shares).toBeGreaterThan(0);
      expect(decision.stop_price).toBeGreaterThan(0);
      expect(root.journal.orderFor(`v2-debate-primary-${ENTRY_DATE}-UP`)).toMatchObject({
        outcome: 'refused_dry_run',
        dry_run: true,
        payload: { size: decision.size_shares },
      });
      expect(count(root, 'v2_orders')).toBe(2);
      expect(count(root, 'v2_fills')).toBe(2);
      expect(root.books.position('debate/primary', 'UP')?.qty).toBe(decision.size_shares);
      const fx = yearStartGbpUsd(parseBoeGbpUsdCsv(readFileSync(fixtures.fxPath, 'utf8')), 2025);
      const fill = root.db
        .prepare('SELECT price_gbp FROM v2_fills WHERE book_id = ?')
        .get('debate/no-macro-gate') as { price_gbp: number };
      expect(fill.price_gbp * fx).toBeCloseTo(LAST_CLOSE, 9);
      expect(report.books.map((book) => book.positions)).toEqual([1, 1]);
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
  });

  it('paper mode: the primary reaches AlpacaBrokerAdapter.submitBracket, the fill is ingested, and the bracket survives a restart', async () => {
    const fixtures = writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'paper.sqlite');
    const clock = new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`));
    const alpacaClient = fakeAlpacaClient(clock);
    const transports: ScriptedTransport[] = [];
    const open = (tradingDate: string, newsCalls: string[]) =>
      composeV2Root({
        ...fixtures,
        tradingDate,
        dryRun: false,
        storePath,
        anthropicApiKey: 'present',
        openrouterApiKey: 'present',
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
        entries: 2,
        submitted_orders: 1,
        simulated_orders: 1,
        dry_run_refusals: 0,
        fills: 2,
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
      });
      expect(first.books.position('debate/primary', 'UP')?.qty).toBe(qty);
      expect(first.books.position('debate/no-macro-gate', 'UP')?.qty).toBe(qty);
      expect(count(first, 'v2_fills')).toBe(2);
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
    } finally {
      second.close();
    }
  });

  it('caps LLM calls at one in flight per provider account on the real transport factory', async () => {
    const fixtures = writeFixtures();
    directory = fixtures.directory;
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    const fetchImpl: FetchLike = async (url, init) => {
      const host = new URL(url).host;
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      peak.set(host, Math.max(peak.get(host) ?? 0, inFlight.get(host) ?? 0));
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight.set(host, (inFlight.get(host) ?? 0) - 1);
      const model = (JSON.parse(init.body as string) as { model: string }).model;
      const body = host.includes('anthropic')
        ? {
            model,
            content: [{ type: 'text', text: '{"stance":"bullish","rationale":"x"}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
          }
        : {
            model,
            choices: [
              {
                message: { content: '{"stance":"bullish","rationale":"x"}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: false,
      storePath: ':memory:',
      anthropicApiKey: 'present',
      openrouterApiKey: 'present',
      fetchImpl,
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
      expect(peak.get('api.anthropic.com')).toBe(1);
      expect(peak.get('openrouter.ai')).toBe(1);
      expect(count(root, 'llm_spend')).toBe(4);
    } finally {
      root.close();
    }
  });

  it('refuses a paper run without LLM keys before opening the store', () => {
    const fixtures = writeFixtures();
    directory = fixtures.directory;
    const storePath = join(fixtures.directory, 'never.sqlite');
    expect(() =>
      composeV2Root({ ...fixtures, tradingDate: '2026-09-25', dryRun: false, storePath }),
    ).toThrow(/without ANTHROPIC_API_KEY/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        anthropicApiKey: '',
        openrouterApiKey: 'x',
      }),
    ).toThrow(/without ANTHROPIC_API_KEY/);
    expect(() =>
      composeV2Root({
        ...fixtures,
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath,
        anthropicApiKey: 'x',
        openrouterApiKey: '',
      }),
    ).toThrow(/without ANTHROPIC_API_KEY/);
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
      llmKeysPresent({
        tradingDate: 'd',
        dryRun: true,
        anthropicApiKey: 'a',
        openrouterApiKey: 'b',
      }),
    ).toBe(true);
    const base = { submitted_orders: 0, dry_run: true } as CycleReport;
    expect(exitCodeFor(base)).toBe(0);
    expect(exitCodeFor({ ...base, submitted_orders: 1 })).toBe(1);
    expect(exitCodeFor({ ...base, submitted_orders: 1, dry_run: false })).toBe(0);
  });
});
