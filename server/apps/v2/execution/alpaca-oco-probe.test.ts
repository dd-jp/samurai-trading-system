import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import { TokenBucket } from '../../../shared/index.js';
import type {
  AlpacaBracketOrderRequest,
  AlpacaMarketOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaOrderLeg,
  AlpacaPosition,
} from './alpaca/alpaca-client.js';
import {
  ALPACA_PAPER_BASE_URL,
  assertAlpacaPaper,
  assertMarketHours,
  type ProbeClient,
  type ProbeDeps,
  type ProbeOptions,
  ProbeRefusal,
  probePrices,
  redact,
  runAlpacaOcoProbe,
} from './alpaca-oco-probe.js';
import { main, PROBE_USAGE, parseProbeArgs, summaryLines } from './alpaca-oco-probe-cli.js';

const OPEN = new Date('2026-10-13T15:00:00Z');
const KEY = 'alpaca-key-sentinel-41c9';
const SECRET = 'alpaca-secret-sentinel-77d0';
const ACCOUNT = 'acct-sentinel-0b5e';
const ENDED = new Set(['canceled', 'filled', 'expired', 'replaced', 'rejected', 'done_for_day']);
const OPEN_LISTED = new Set(['new', 'accepted', 'partially_filled', 'pending_new']);

interface FakeOptions {
  baseUrl?: string;
  ask?: number;
  fills?: boolean;
  ocoFails?: boolean;
  cancelFails?: boolean;
  ocoStopStatus?: string;
  preHeld?: number;
}

class FakePaper implements ProbeClient {
  readonly baseUrl: string;
  readonly calls: string[] = [];
  readonly orders: AlpacaOrder[] = [];
  readonly ocoRequests: AlpacaOcoOrderRequest[] = [];
  readonly positions = new Map<string, number>();
  private nextId = 1;

  constructor(private readonly options: FakeOptions = {}) {
    this.baseUrl = options.baseUrl ?? ALPACA_PAPER_BASE_URL;
    if (options.preHeld !== undefined) this.positions.set('SCHD', options.preHeld);
  }

  private id(): string {
    return `ord-${this.nextId++}`;
  }

  private leg(type: 'limit' | 'stop', side: 'buy' | 'sell', price: string): AlpacaOrderLeg {
    return {
      id: this.id(),
      client_order_id: `leg-${this.nextId}`,
      side,
      qty: '1',
      type,
      status: 'held',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
      ...(type === 'stop' ? { stop_price: price } : { limit_price: price }),
    };
  }

  private parent(fields: Partial<AlpacaOrder> & Pick<AlpacaOrder, 'client_order_id'>): AlpacaOrder {
    const order = {
      id: this.id(),
      symbol: 'SCHD',
      side: 'buy',
      qty: '1',
      order_class: 'simple',
      type: 'limit',
      status: 'new',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
      account_id: ACCOUNT,
      ...fields,
    } as AlpacaOrder;
    this.orders.push(order);
    return order;
  }

  private find(id: string): AlpacaOrder | AlpacaOrderLeg | undefined {
    return this.orders.flatMap((order) => [order, ...(order.legs ?? [])]).find((o) => o.id === id);
  }

  private move(symbol: string, qty: number): void {
    this.positions.set(symbol, (this.positions.get(symbol) ?? 0) + qty);
  }

  getLatestQuote() {
    this.calls.push('getLatestQuote');
    return Promise.resolve({ t: OPEN.toISOString(), ap: this.options.ask ?? 27.4, bp: 27.38 });
  }

  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder> {
    this.calls.push('submitOrder');
    const order = this.parent({
      client_order_id: request.client_order_id,
      order_class: 'bracket',
      limit_price: request.limit_price,
      legs: [
        this.leg('limit', 'sell', request.take_profit.limit_price),
        this.leg('stop', 'sell', request.stop_loss.stop_price),
      ],
    });
    return Promise.resolve(structuredClone(order));
  }

  submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> {
    this.calls.push('submitOcoOrder');
    this.ocoRequests.push(request);
    if (this.options.ocoFails === true) return Promise.reject(new Error('oco refused'));
    const stop = this.leg('stop', request.side, request.stop_loss.stop_price);
    stop.status = this.options.ocoStopStatus ?? 'held';
    const order = this.parent({
      client_order_id: request.client_order_id,
      side: request.side,
      order_class: 'oco',
      limit_price: request.take_profit.limit_price,
      legs: [stop],
    });
    return Promise.resolve(structuredClone(order));
  }

  submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder> {
    this.calls.push('submitMarketOrder');
    const order = this.parent({
      client_order_id: request.client_order_id,
      side: request.side,
      qty: request.qty,
      type: 'market',
      status: 'filled',
      filled_qty: request.qty,
    });
    this.move(request.symbol, (request.side === 'sell' ? -1 : 1) * Number(request.qty));
    return Promise.resolve(structuredClone(order));
  }

  cancelOrder(id: string): Promise<void> {
    this.calls.push(`cancelOrder:${id}`);
    if (this.options.cancelFails === true) return Promise.reject(new Error('cancel refused'));
    const order = this.find(id);
    if (order === undefined || ENDED.has(order.status)) return Promise.resolve();
    order.status = 'canceled';
    for (const leg of (order as AlpacaOrder).legs ?? []) {
      if (!ENDED.has(leg.status)) leg.status = 'canceled';
    }
    return Promise.resolve();
  }

  private fillBrackets(): void {
    if (this.options.fills === false) return;
    for (const order of this.orders) {
      if (order.order_class !== 'bracket' || order.status !== 'new') continue;
      order.status = 'filled';
      order.filled_qty = order.qty;
      order.filled_avg_price = order.limit_price ?? null;
      const target = order.legs?.find((leg) => leg.type === 'limit');
      if (target !== undefined) target.status = 'new';
      this.move(order.symbol, Number(order.qty));
    }
  }

  getOrder(id: string): Promise<AlpacaOrder> {
    this.calls.push('getOrder');
    this.fillBrackets();
    return Promise.resolve(structuredClone(this.find(id) as AlpacaOrder));
  }

  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    this.calls.push('getOrderByClientOrderId');
    const order = this.orders.find((o) => o.client_order_id === clientOrderId);
    return Promise.resolve(order === undefined ? null : structuredClone(order));
  }

  getPositions(): Promise<AlpacaPosition[]> {
    this.calls.push('getPositions');
    return Promise.resolve(
      [...this.positions]
        .filter(([, qty]) => qty !== 0)
        .map(([symbol, qty]) => ({
          symbol,
          qty: String(Math.abs(qty)),
          side: qty > 0 ? ('long' as const) : ('short' as const),
          avg_entry_price: '27.54',
        })),
    );
  }

  listOpenOrders(): Promise<AlpacaOrder[]> {
    this.calls.push('listOpenOrders');
    const flat = this.orders.flatMap((order) => [
      order,
      ...(order.legs ?? []).map(
        (leg) => ({ ...leg, symbol: order.symbol, order_class: order.order_class }) as AlpacaOrder,
      ),
    ]);
    return Promise.resolve(
      structuredClone(
        flat
          .filter((order) => OPEN_LISTED.has(order.status))
          .map((order) => ({ ...order, legs: null }) as unknown as AlpacaOrder),
      ),
    );
  }

  listOrderHistory(symbols: readonly string[]): Promise<AlpacaOrder[]> {
    this.calls.push('listOrderHistory');
    return Promise.resolve(
      structuredClone(this.orders.filter((order) => symbols.includes(order.symbol)).reverse()),
    );
  }

  getAccount() {
    this.calls.push('getAccount');
    return Promise.resolve({ cash: '7000', equity: '7000' });
  }
}

function deps(client: FakePaper, start: Date = OPEN): ProbeDeps & { now: () => Date } {
  let now = start.getTime();
  return {
    client,
    clock: {
      now: () => new Date(now),
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
    now: () => new Date(now),
    calendar: new UsEquityRegularHoursCalendar(),
    logger: { log: () => {} },
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  };
}

const OPTIONS: ProbeOptions = {
  symbol: 'SCHD',
  runId: 'run-1',
  pollMs: 1_000,
  pollAttempts: 5,
  settleMs: 1_000,
};

describe('paper-only refusal', () => {
  it.each([
    'https://api.alpaca.markets',
    'https://paper-api.alpaca.markets.example.com',
    'http://paper-api.alpaca.markets',
    'https://localhost:9999',
    '',
  ])('refuses %j', (url) => {
    expect(() => assertAlpacaPaper(url)).toThrow(ProbeRefusal);
    expect(() => assertAlpacaPaper(url)).toThrow(/paper_only_refusal/);
  });

  it('accepts the paper trading host', () => {
    expect(() => assertAlpacaPaper('https://paper-api.alpaca.markets')).not.toThrow();
  });

  it('refuses the live URL before any call to the venue', async () => {
    const client = new FakePaper({ baseUrl: 'https://api.alpaca.markets' });
    await expect(runAlpacaOcoProbe(deps(client), OPTIONS)).rejects.toThrow(/paper_only_refusal/);
    expect(client.calls).toEqual([]);
  });

  it('refuses the live URL in main before any call and writes nothing', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'oco-probe-live-'));
    const client = new FakePaper({ baseUrl: 'https://api.alpaca.markets' });
    const lines: string[] = [];
    await expect(
      main(
        ['--out-dir', outDir],
        {},
        { ...deps(client), client: () => client, stdout: (l) => lines.push(l) },
      ),
    ).rejects.toThrow(/paper_only_refusal/);
    expect(client.calls).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe('market-hours refusal', () => {
  const calendar = new UsEquityRegularHoursCalendar();

  it.each([
    ['before the open', '2026-10-13T13:00:00Z'],
    ['after the close', '2026-10-13T20:30:00Z'],
    ['inside the last 20 minutes', '2026-10-13T19:45:00Z'],
    ['on a Saturday', '2026-10-17T15:00:00Z'],
    ['on Thanksgiving', '2026-11-26T16:00:00Z'],
  ])('refuses %s', (_, at) => {
    expect(() => assertMarketHours(new Date(at), calendar)).toThrow(/market_hours_refusal/);
  });

  it.each([
    ['at the open', '2026-10-13T13:30:00Z'],
    ['20 minutes before the close', '2026-10-13T19:40:00Z'],
  ])('accepts %s', (_, at) => {
    expect(() => assertMarketHours(new Date(at), calendar)).not.toThrow();
  });

  it('places nothing outside market hours', async () => {
    const client = new FakePaper();
    await expect(
      runAlpacaOcoProbe(deps(client, new Date('2026-10-13T12:00:00Z')), OPTIONS),
    ).rejects.toThrow(ProbeRefusal);
    expect(client.calls).toEqual([]);
  });
});

describe('account precondition', () => {
  it('refuses a symbol the account already holds, and places nothing', async () => {
    const client = new FakePaper({ preHeld: 3 });
    await expect(runAlpacaOcoProbe(deps(client), OPTIONS)).rejects.toThrow(
      /account_not_clean_refusal: .* holds 3 SCHD/,
    );
    expect(client.calls).not.toContain('submitOrder');
    expect(client.calls.some((call) => call.startsWith('cancelOrder'))).toBe(false);
  });
});

describe('prices', () => {
  it('buys through the ask with the stop and target 5% away and the re-arm stop at 7%', () => {
    expect(probePrices(27.4)).toEqual({
      ask: 27.4,
      entry: 27.54,
      bracketStop: 26.16,
      target: 28.92,
      rearmStop: 25.61,
    });
  });

  it.each([0, -1, Number.NaN])('refuses an ask of %d', (ask) => {
    expect(() => probePrices(ask)).toThrow(/no usable ask/);
  });
});

describe('a full probe', () => {
  it('fills a bracket, re-arms it as the adapter does, captures the wire and ends flat', async () => {
    const client = new FakePaper();
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);

    expect(evidence.failure).toBeUndefined();
    expect(evidence.cleanup.errors).toEqual([]);
    expect(evidence.passed).toBe(true);
    expect(evidence.residual).toEqual({ positionQty: 0, workingOrderIds: [] });
    expect(evidence.rearmPlacedQty).toBe(1);
    expect(evidence.ocoStopLegStatus).toBe('held');

    const order = client.calls.filter(
      (call) =>
        ['submitOrder', 'submitOcoOrder', 'submitMarketOrder'].includes(call) ||
        call.startsWith('cancelOrder'),
    );
    expect(order).toEqual([
      'submitOrder',
      'cancelOrder:ord-1',
      'cancelOrder:ord-2',
      'submitOcoOrder',
      'cancelOrder:ord-5',
      'cancelOrder:ord-4',
      'submitMarketOrder',
    ]);
    expect(client.ocoRequests).toEqual([
      {
        symbol: 'SCHD',
        side: 'sell',
        qty: '1',
        time_in_force: 'gtc',
        client_order_id: 'oco-probe-run-1:rearm',
        order_class: 'oco',
        take_profit: { limit_price: '28.92' },
        stop_loss: { stop_price: '25.61' },
      },
    ]);

    expect(evidence.snapshots.map((s) => [s.phase, s.diffs.map((d) => d.kind)])).toEqual([
      ['after_fill', []],
      ['stale_ledger_stop', ['protective_price']],
      ['after_rearm', []],
      ['after_cleanup', []],
    ]);
    const afterRearm = evidence.snapshots[2];
    const oco = afterRearm?.history.find((o) => o.order_class === 'oco');
    expect(oco?.status).toBe('new');
    expect(oco?.legs?.map((leg) => [leg.type, leg.status, leg.stop_price])).toEqual([
      ['stop', 'held', '25.61'],
    ]);
    expect(afterRearm?.open.map((o) => o.id)).toEqual([oco?.id]);
    expect(afterRearm?.reader.openOrders).toContainEqual({
      clientOrderId: oco?.legs?.[0]?.client_order_id,
      instrument: 'SCHD',
      protects: 'long',
      qty: 1,
      stopPrice: 25.61,
    });
    expect(client.positions.get('SCHD')).toBe(0);
  });

  it('records an OCO stop leg the venue rests live, and still ends flat', async () => {
    const client = new FakePaper({ ocoStopStatus: 'new' });
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.ocoStopLegStatus).toBe('new');
    expect(evidence.snapshots[2]?.open).toHaveLength(2);
    expect(evidence.passed).toBe(true);
  });
});

describe('cleanup on failure', () => {
  it('cancels and flattens when the re-arm fails, and fails the run', async () => {
    const client = new FakePaper({ ocoFails: true });
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.failure).toMatch(/are cancelled and the replacement failed/);
    expect(evidence.passed).toBe(false);
    expect(client.calls).toContain('submitMarketOrder');
    expect(evidence.cleanup.flattenOrder?.side).toBe('sell');
    expect(evidence.residual).toEqual({ positionQty: 0, workingOrderIds: [] });
  });

  it('cancels an entry that never fills and sends no flatten', async () => {
    const client = new FakePaper({ fills: false });
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.failure).toMatch(/fill did not happen after 5 checks/);
    expect(evidence.cleanup.cancelled).toEqual(['ord-3', 'ord-1', 'ord-2']);
    expect(client.calls).not.toContain('submitMarketOrder');
    expect(client.calls).not.toContain('submitOcoOrder');
    expect(evidence.residual).toEqual({ positionQty: 0, workingOrderIds: [] });
    expect(evidence.passed).toBe(false);
  });

  it('reports the residual position and working orders when the cleanup itself fails', async () => {
    const client = new FakePaper({ cancelFails: true });
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.failure).toMatch(/did not cancel/);
    expect(evidence.cleanup.errors).toEqual([
      expect.stringMatching(/cancel refused/),
      expect.stringMatching(/flatten_skipped: 2 order\(s\) on SCHD still work/),
    ]);
    expect(client.calls).not.toContain('submitMarketOrder');
    expect(evidence.residual).toEqual({ positionQty: 1, workingOrderIds: ['ord-1', 'ord-2'] });
    expect(evidence.passed).toBe(false);
  });

  it('closes a short by buying back the quantity held', async () => {
    const client = new FakePaper({ ocoFails: true });
    const order = client.submitOcoOrder.bind(client);
    client.submitOcoOrder = (request) => {
      client.positions.set('SCHD', -1);
      return order(request);
    };
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.cleanup.flattenOrder).toMatchObject({ side: 'buy', qty: '1' });
    expect(evidence.residual).toEqual({ positionQty: 0, workingOrderIds: [] });
  });

  it('keeps the residual when the flatten does not land', async () => {
    const client = new FakePaper();
    client.submitMarketOrder = () => Promise.reject(new Error('flatten refused'));
    const evidence = await runAlpacaOcoProbe(deps(client), OPTIONS);
    expect(evidence.cleanup.errors).toEqual([expect.stringMatching(/flatten refused/)]);
    expect(evidence.residual).toEqual({ positionQty: 1, workingOrderIds: [] });
    expect(evidence.passed).toBe(false);
    expect(summaryLines(evidence, '/x.json')).toEqual([
      'probe_failed: evidence at /x.json',
      'oco stop leg status: held',
      expect.stringMatching(/^cleanup error: .*flatten refused/),
      'residual: {"positionQty":1,"workingOrderIds":[]}',
    ]);
  });
});

describe('redaction', () => {
  it('blanks account ids and every credential substring, at any depth', () => {
    expect(
      redact(
        {
          account_id: ACCOUNT,
          list: [{ account_number: 'PA3NUMBER', note: `x${KEY}y`, error: `${ACCOUNT} PA3NUMBER` }],
          n: 1,
          z: null,
        },
        [KEY, ''],
      ),
    ).toEqual({
      account_id: '[redacted]',
      list: [
        { account_number: '[redacted]', note: 'x[redacted]y', error: '[redacted] [redacted]' },
      ],
      n: 1,
      z: null,
    });
  });
});

describe('main', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'oco-probe-'));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('writes the raw evidence with no account id or credential and prints its path', async () => {
    const client = new FakePaper({ ask: Number(`27.4`) });
    const order = client.submitOrder.bind(client);
    client.submitOrder = async (request) =>
      ({ ...(await order(request)), note: KEY }) as AlpacaOrder;
    const lines: string[] = [];
    const code = await main(
      ['--out-dir', outDir],
      { ALPACA_API_KEY: KEY, ALPACA_API_SECRET: SECRET },
      { ...deps(client), client: () => client, stdout: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    const [file] = readdirSync(outDir);
    const path = join(outDir, file ?? '');
    expect(file).toBe('alpaca-oco-probe-2026-10-13T150000Z.json');
    expect(lines[0]).toBe(`probe_passed: evidence at ${path}`);
    expect(lines[1]).toBe('oco stop leg status: held');
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCOUNT);
    expect(JSON.parse(text).snapshots[2].history[0].order_class).toBe('oco');
  });

  it('scrubs an account id carried inside an error message from the file and stdout', async () => {
    const client = new FakePaper();
    const history = client.listOrderHistory.bind(client);
    let reads = 0;
    client.listOrderHistory = (symbols) => {
      reads += 1;
      if (reads !== 3) return history(symbols);
      return Promise.reject(new Error(`malformed response body: {"account_id":"${ACCOUNT}"}`));
    };
    const lines: string[] = [];
    const code = await main(
      ['--out-dir', outDir],
      {},
      { ...deps(client), client: () => client, stdout: (line) => lines.push(line) },
    );
    expect(code).toBe(1);
    const text = readFileSync(join(outDir, readdirSync(outDir)[0] ?? ''), 'utf8');
    expect(text).not.toContain(ACCOUNT);
    expect(lines.join('\n')).not.toContain(ACCOUNT);
    expect(lines).toContainEqual(expect.stringMatching(/^failure: .*\[redacted\]/));
  });

  it('exits 1 when the run fails', async () => {
    const client = new FakePaper({ ocoFails: true });
    const lines: string[] = [];
    const code = await main(
      ['--out-dir', outDir],
      {},
      {
        ...deps(client),
        client: () => client,
        stdout: (line) => lines.push(line),
      },
    );
    expect(code).toBe(1);
    expect(lines).toContainEqual(expect.stringMatching(/^failure: .*replacement failed/));
    expect(existsSync(outDir)).toBe(true);
  });
});

describe('arguments', () => {
  it('defaults to SCHD under data/alpaca-oco-probe', () => {
    const args = parseProbeArgs([]);
    expect(args.symbol).toBe('SCHD');
    expect(args.outDir).toMatch(/data\/alpaca-oco-probe$/);
  });

  it('takes a symbol and an out dir', () => {
    expect(parseProbeArgs(['--symbol', 'xlf', '--out-dir', '/tmp/x'])).toEqual({
      symbol: 'XLF',
      outDir: '/tmp/x',
    });
  });

  it.each([['--live'], ['--symbol']])('refuses %j', (...argv) => {
    expect(() => parseProbeArgs(argv)).toThrow(PROBE_USAGE);
  });
});
