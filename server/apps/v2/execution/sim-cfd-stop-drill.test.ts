import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTokenFile } from '../../../pipeline/execution/adapters/saxo-token-file.js';
import type { LogEntry } from '../../../shared/index.js';
import {
  assertSimGateway,
  SAXO_SIM_GATEWAY,
  SaxoSimGateway,
  SimOnlyRefusal,
} from './saxo-sim-gateway.js';
import { drillPassed, redact, renderSummary } from './sim-cfd-drill-evidence.js';
import { instrumentRules } from './sim-cfd-drill-reads.js';
import {
  DEFAULT_DRILL_OPTIONS,
  type DrillOptions,
  newEvidence,
  runSimCfdStopDrill,
  shortWithStop,
} from './sim-cfd-stop-drill.js';
import {
  type DrillDeps,
  main,
  parseDrillArgs,
  type SimTokenChoice,
  simTokenSource,
  writeEvidence,
} from './sim-cfd-stop-drill-cli.js';

const ACCOUNT_KEY = 'acct-key-sentinel-7f3a';
const CLIENT_KEY = 'client-key-sentinel-9b1c';
const TOKEN = 'sim-token-sentinel-5d2e';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
  readonly authorization: string | undefined;
}

interface Position {
  uic: number;
  assetType: string;
  amount: number;
  price: number;
}

interface Order {
  OrderId: string;
  Uic: number;
  AssetType: string;
  OpenOrderType: string;
  Status: string;
  BuySell: string;
  Amount: number;
  Price: number;
  OrderRelation: string;
}

type Reply = readonly [number, unknown];

class FakeSaxoSim {
  readonly calls: Call[] = [];
  trial = true;
  etfListed = false;
  marketOpen = true;
  supportedOrderTypes = ['Market', 'Limit', 'StopIfTraded'];
  fillPrice = 200;
  stopPriceDrift = 0;
  amendStatuses: number[] = [];
  amendTriggers = true;
  entryStatus = 200;
  tradable = true;
  shortDisabled = false;
  bid = 199.9;
  cancelStatus = 200;
  flattenStatus = 200;
  fillsEntry = true;
  positions: Position[] = [];
  orders: Order[] = [];
  activities: Record<string, unknown>[] = [];
  private sequence = 0;

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith(`${SAXO_SIM_GATEWAY}/`)) throw new Error(`left the SIM gateway: ${url}`);
    const path = url.slice(SAXO_SIM_GATEWAY.length);
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({
      method: String(init.method),
      path,
      body,
      authorization: headers.authorization,
    });
    const [status, payload] = this.route(String(init.method), path, body);
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status });
  };

  trades(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  private route(method: string, path: string, body: Record<string, unknown> | undefined): Reply {
    const bare = path.split('?')[0] ?? '';
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    if (method === 'GET') return this.read(bare, query);
    if (method === 'POST') return this.place(body ?? {});
    if (method === 'PATCH') return this.amend(body ?? {});
    return this.cancel(bare.split('/').pop() ?? '');
  }

  private read(bare: string, query: URLSearchParams): Reply {
    if (bare === '/port/v1/accounts/me') {
      return [
        200,
        {
          Data: [
            {
              AccountKey: ACCOUNT_KEY,
              ClientKey: CLIENT_KEY,
              Currency: 'EUR',
              IsTrialAccount: this.trial,
            },
          ],
        },
      ];
    }
    if (bare === '/ref/v1/instruments')
      return [200, { Data: this.listing(query.get('AssetTypes')) }];
    if (bare.startsWith('/ref/v1/instruments/details/')) {
      return [
        200,
        {
          IsTradable: this.tradable,
          MinimumTradeSize: 1,
          SupportedOrderTypes: this.supportedOrderTypes,
          TickSizeScheme: {
            DefaultTickSize: 0.01,
            Elements: [
              { HighPrice: 10, TickSize: 0.001 },
              { HighPrice: 1, TickSize: 0.0001 },
            ],
          },
          OrderDistances: { StopIfTradedOrder: 0.5 },
        },
      ];
    }
    if (bare === '/trade/v1/infoprices') {
      return [
        200,
        {
          Quote: { Bid: this.bid, Ask: 200.1, DelayedByMinutes: 0 },
          InstrumentPriceDetails: {
            IsMarketOpen: this.marketOpen,
            ShortTradeDisabled: this.shortDisabled,
          },
        },
      ];
    }
    if (bare === '/port/v1/netpositions/me') return [200, { Data: this.positions.map(netRow) }];
    if (bare === '/port/v1/orders/me') return [200, { Data: this.orders }];
    if (bare === '/cs/v1/audit/orderactivities') return [200, { Data: this.activities }];
    return [404, undefined];
  }

  private listing(assetType: string | null): unknown[] {
    const rows = [
      { Symbol: 'AAPL:xnas', Identifier: 211, AssetType: 'CfdOnStock' },
      { Symbol: 'AAPL:xmil', Identifier: 999, AssetType: 'CfdOnStock' },
      ...(this.etfListed ? [{ Symbol: 'ISF:xlon', Identifier: 311, AssetType: 'CfdOnEtf' }] : []),
    ];
    return rows.filter((row) => row.AssetType === assetType);
  }

  private place(body: Record<string, unknown>): Reply {
    const uic = Number(body.Uic);
    const assetType = String(body.AssetType);
    const amount = Number(body.Amount);
    if (!Array.isArray(body.Orders)) {
      if (this.flattenStatus !== 200) return [this.flattenStatus, undefined];
      this.positions = this.positions.filter((row) => row.uic !== uic);
      return [200, { OrderId: `f-${uic}` }];
    }
    if (this.entryStatus !== 200)
      return [this.entryStatus, { ErrorInfo: { ErrorCode: 'Rejected', AccountKey: ACCOUNT_KEY } }];
    const [stop, target] = body.Orders as Record<string, unknown>[];
    if (this.fillsEntry)
      this.positions.push({ uic, assetType, amount: -amount, price: this.fillPrice });
    const leg = (id: string, type: string, price: unknown): Order => ({
      OrderId: id,
      Uic: uic,
      AssetType: assetType,
      OpenOrderType: type,
      Status: this.fillsEntry ? 'Working' : 'NotWorking',
      BuySell: 'Buy',
      Amount: amount,
      Price: Number(price) + (type === 'StopIfTraded' ? this.stopPriceDrift : 0),
      OrderRelation: 'Oco',
    });
    this.orders.push(
      leg(`s-${uic}`, 'StopIfTraded', stop?.OrderPrice),
      leg(`t-${uic}`, 'Limit', target?.OrderPrice),
    );
    this.sequence += 1;
    return [
      200,
      {
        OrderId: `m-${uic}-${this.sequence}`,
        Orders: [{ OrderId: `s-${uic}` }, { OrderId: `t-${uic}` }],
      },
    ];
  }

  private amend(body: Record<string, unknown>): Reply {
    const status = this.amendStatuses.shift() ?? 200;
    if (status !== 200) return [status, { ErrorInfo: { ErrorCode: 'OrderPriceWrongSide' } }];
    const order = this.orders.find((row) => row.OrderId === body.OrderId);
    if (order === undefined) return [404, undefined];
    if (this.amendTriggers) {
      this.positions = this.positions.filter((row) => row.uic !== order.Uic);
      this.orders = this.orders.filter((row) => row.Uic !== order.Uic);
      this.activities.push({
        OrderId: order.OrderId,
        Status: 'FinalFill',
        ActivityTime: '2026-10-01T14:40:05.000Z',
        AveragePrice: 199.5,
        FillAmount: order.Amount,
        AccountKey: ACCOUNT_KEY,
      });
    }
    return [200, { OrderId: order.OrderId }];
  }

  private cancel(orderId: string): Reply {
    if (this.cancelStatus !== 200) return [this.cancelStatus, undefined];
    const before = this.orders.length;
    this.orders = this.orders.filter((row) => row.OrderId !== orderId);
    return before === this.orders.length
      ? [404, undefined]
      : [200, { Orders: [{ OrderId: orderId }] }];
  }
}

function netRow(position: Position): unknown {
  return {
    NetPositionId: `${position.uic}__${position.assetType}`,
    NetPositionBase: { Uic: position.uic, AssetType: position.assetType, Amount: position.amount },
    NetPositionView: { AverageOpenPrice: position.price },
  };
}

class FakeClock {
  private millis = Date.parse('2026-10-01T14:35:00.000Z');
  readonly sleeps: number[] = [];
  readonly now = (): Date => new Date(this.millis);
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.millis += ms;
  };
}

const OPTIONS: DrillOptions = {
  ...DEFAULT_DRILL_OPTIONS,
  targets: [
    { symbol: 'AAPL:xnas', assetType: 'CfdOnStock' },
    { symbol: 'ISF:xlon', assetType: 'CfdOnEtf' },
  ],
  runId: 'r1',
  pollIntervalMs: 1_000,
  fillTimeoutMs: 5_000,
  triggerTimeoutMs: 10_000,
};

function gatewayFor(fake: FakeSaxoSim, clock: FakeClock): SaxoSimGateway {
  return new SaxoSimGateway({
    baseUrl: SAXO_SIM_GATEWAY,
    accessToken: async () => TOKEN,
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: () => clock.now().getTime(),
  });
}

async function drill(fake: FakeSaxoSim, options: DrillOptions = OPTIONS) {
  const clock = new FakeClock();
  const result = await runSimCfdStopDrill(gatewayFor(fake, clock), options, clock);
  return { ...result, clock };
}

describe('SIM-only refusal', () => {
  it.each([
    'https://gateway.saxobank.com/openapi',
    'https://gateway.saxobank.com/sim/openapi.evil.test',
    'http://gateway.saxobank.com/sim/openapi',
    'https://example.test/sim/openapi',
  ])('refuses the gateway %s before any request', (baseUrl) => {
    const fake = new FakeSaxoSim();
    expect(
      () =>
        new SaxoSimGateway({
          baseUrl,
          accessToken: async () => TOKEN,
          fetch: fake.fetch,
          sleep: async () => {},
          now: () => 0,
        }),
    ).toThrow(SimOnlyRefusal);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts the SIM gateway with a trailing slash', () => {
    expect(() => assertSimGateway(`${SAXO_SIM_GATEWAY}/`)).not.toThrow();
  });

  it('refuses a path that could leave the SIM host', async () => {
    const fake = new FakeSaxoSim();
    const gateway = gatewayFor(fake, new FakeClock());
    await expect(gateway.send('GET', '//evil.test/x')).rejects.toThrow(SimOnlyRefusal);
    await expect(gateway.send('GET', 'port/v1/accounts/me')).rejects.toThrow(SimOnlyRefusal);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a live account and places nothing', async () => {
    const fake = new FakeSaxoSim();
    fake.trial = false;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toMatch(/^sim_only_refusal/);
    expect(evidence.passed).toBe(false);
    expect(fake.trades()).toHaveLength(0);
  });

  it('refuses a live main() gateway before reading any token', async () => {
    const fake = new FakeSaxoSim();
    let tokensRead = 0;
    const deps = cliDeps(fake, new FakeClock(), () => {
      tokensRead += 1;
      return staticTokens();
    });
    await expect(
      main(
        ['--out-dir', '/nonexistent'],
        { SAXO_SIM_GATEWAY: 'https://gateway.saxobank.com/openapi' },
        deps,
      ),
    ).rejects.toThrow(SimOnlyRefusal);
    expect(tokensRead).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('the gateway', () => {
  it('spaces trade requests at least 1.1 s apart and sends a bearer and a request id', async () => {
    const fake = new FakeSaxoSim();
    const clock = new FakeClock();
    const gateway = gatewayFor(fake, clock);
    await gateway.send('DELETE', '/trade/v2/orders/x');
    await gateway.send('DELETE', '/trade/v2/orders/y');
    await gateway.get('/port/v1/orders/me');
    expect(clock.sleeps).toEqual([1_100]);
    expect(fake.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('turns a 401 into an ask-David error', async () => {
    const gateway = new SaxoSimGateway({
      baseUrl: SAXO_SIM_GATEWAY,
      accessToken: async () => TOKEN,
      fetch: async () => new Response('', { status: 401 }),
      sleep: async () => {},
      now: () => 0,
    });
    await expect(gateway.get('/port/v1/accounts/me')).rejects.toThrow(/saxo_sim_unauthorized/);
  });

  it('fails a read that is not 200 and keeps a non-JSON body as text', async () => {
    const gateway = new SaxoSimGateway({
      baseUrl: SAXO_SIM_GATEWAY,
      accessToken: async () => TOKEN,
      fetch: async () => new Response('gateway down', { status: 503 }),
      sleep: async () => {},
      now: () => 0,
    });
    await expect(gateway.get('/port/v1/orders/me?x=1')).rejects.toThrow(
      'saxo_sim_read_failed: 503 on /port/v1/orders/me',
    );
    await expect(gateway.send('POST', '/trade/v2/orders', {})).resolves.toEqual({
      status: 503,
      body: 'gateway down',
    });
  });
});

describe('the order payload', () => {
  it('is a market short with a GTC StopIfTraded buy and a GTC limit buy as related orders', () => {
    const payload = shortWithStop(
      { accountKey: ACCOUNT_KEY, clientKey: CLIENT_KEY, currency: 'EUR' },
      { uic: 211, assetType: 'CfdOnStock' },
      1,
      { stop: 220.12, target: 179.91 },
      'drill-r1-211',
    );
    expect(payload).toEqual({
      AccountKey: ACCOUNT_KEY,
      Uic: 211,
      AssetType: 'CfdOnStock',
      BuySell: 'Sell',
      Amount: 1,
      OrderType: 'Market',
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: 'drill-r1-211',
      Orders: [
        {
          Uic: 211,
          AssetType: 'CfdOnStock',
          BuySell: 'Buy',
          Amount: 1,
          OrderType: 'StopIfTraded',
          OrderPrice: 220.12,
          OrderDuration: { DurationType: 'GoodTillCancel' },
          ManualOrder: false,
          ExternalReference: 'drill-r1-211:stop',
        },
        {
          Uic: 211,
          AssetType: 'CfdOnStock',
          BuySell: 'Buy',
          Amount: 1,
          OrderType: 'Limit',
          OrderPrice: 179.91,
          OrderDuration: { DurationType: 'GoodTillCancel' },
          ManualOrder: false,
          ExternalReference: 'drill-r1-211:target',
        },
      ],
    });
  });

  it('is what the drill posts, with the stop 10% above the ask on the tick grid', async () => {
    const fake = new FakeSaxoSim();
    await drill(fake);
    const [entry] = fake.trades();
    expect(entry?.path).toBe('/trade/v2/orders');
    expect(entry?.body?.Orders).toEqual([
      expect.objectContaining({ OrderType: 'StopIfTraded', OrderPrice: 220.11, BuySell: 'Buy' }),
      expect.objectContaining({ OrderType: 'Limit', OrderPrice: 179.91, BuySell: 'Buy' }),
    ]);
    expect(String(entry?.body?.ExternalReference).length).toBeLessThanOrEqual(50);
  });
});

describe('a full drill', () => {
  it('passes when the stop rests, the amend crosses the market and the stop fills flat', async () => {
    const fake = new FakeSaxoSim();
    const { evidence } = await drill(fake);
    expect(evidence.passed).toBe(true);
    expect(evidence.flatBefore).toMatchObject({ netPositions: 0, openOrders: 0 });
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0, openOrders: 0 });
    const [stock, etf] = evidence.instruments;
    expect(etf).toMatchObject({ outcome: 'skipped', reason: 'instrument_not_found' });
    expect(stock).toMatchObject({
      outcome: 'passed',
      uic: 211,
      amount: 1,
      entry: { orderId: 'm-211-1', fillPrice: 200, relatedOrderIds: ['s-211', 't-211'] },
      stop: {
        placedPrice: 220.11,
        orderId: 's-211',
        rest: { status: 'Working', buySell: 'Buy', amount: 1, price: 220.11 },
        amendAttempts: [{ price: 199, status: 200 }],
        triggerStatus: 'FinalFill',
        triggerFillPrice: 199.5,
      },
      positionClosedAfterTrigger: true,
    });
    expect(fake.trades().map((call) => call.method)).toEqual(['POST', 'PATCH']);
    expect(fake.trades()[1]?.body).toEqual({
      AccountKey: ACCOUNT_KEY,
      OrderId: 's-211',
      AssetType: 'CfdOnStock',
      OrderType: 'StopIfTraded',
      OrderPrice: 199,
      Amount: 1,
      OrderDuration: { DurationType: 'GoodTillCancel' },
    });
  });

  it('drills the UK ETF CFD too when SIM lists one', async () => {
    const fake = new FakeSaxoSim();
    fake.etfListed = true;
    const { evidence } = await drill(fake);
    expect(evidence.instruments.map((record) => record.outcome)).toEqual(['passed', 'passed']);
    expect(evidence.passed).toBe(true);
  });

  it('falls back to a stop just above the fill when the crossing amend is rejected', async () => {
    const fake = new FakeSaxoSim();
    fake.amendStatuses = [400];
    const { evidence } = await drill(fake);
    expect(evidence.instruments[0]?.stop?.amendAttempts?.map((a) => [a.price, a.status])).toEqual([
      [199, 400],
      [200.1, 200],
    ]);
    expect(evidence.passed).toBe(true);
  });

  it('skips a closed market and fails the run for want of a drilled instrument', async () => {
    const fake = new FakeSaxoSim();
    fake.marketOpen = false;
    const { evidence } = await drill(fake);
    expect(evidence.instruments[0]).toMatchObject({ outcome: 'skipped', reason: 'market_closed' });
    expect(fake.trades()).toHaveLength(0);
    expect(evidence.passed).toBe(false);
  });

  it('fails when the CFD does not support StopIfTraded, before any order', async () => {
    const fake = new FakeSaxoSim();
    fake.supportedOrderTypes = ['Market', 'Limit', 'Stop'];
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('stop_if_traded_unsupported: AAPL:xnas');
    expect(evidence.instruments[0]?.supportedOrderTypes).toEqual(['Market', 'Limit', 'Stop']);
    expect(fake.trades()).toHaveLength(0);
  });

  it.each([
    ['tradable', false, 'instrument_not_tradable'],
    ['shortDisabled', true, 'short_disabled'],
  ] as const)('skips when %s is %s', async (knob, value, reason) => {
    const fake = new FakeSaxoSim();
    fake[knob] = value;
    const { evidence } = await drill(fake);
    expect(evidence.instruments[0]).toMatchObject({ outcome: 'skipped', reason });
    expect(fake.trades()).toHaveLength(0);
  });

  it('fails on a quote with no usable bid', async () => {
    const fake = new FakeSaxoSim();
    fake.bid = 0;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('quote_unusable: AAPL:xnas');
    expect(fake.trades()).toHaveLength(0);
  });

  it('refuses to start on an account that is not flat, and touches nothing', async () => {
    const fake = new FakeSaxoSim();
    fake.positions.push({ uic: 42, assetType: 'Stock', amount: 3, price: 10 });
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_account_not_flat');
    expect(fake.trades()).toHaveLength(0);
    expect(fake.positions).toHaveLength(1);
  });
});

describe('cleanup on failure', () => {
  it('records cancel and flatten refusals as cleanup errors', async () => {
    const fake = new FakeSaxoSim();
    fake.amendTriggers = false;
    fake.cancelStatus = 500;
    fake.flattenStatus = 500;
    const { evidence } = await drill(fake, { ...OPTIONS, targets: OPTIONS.targets.slice(0, 1) });
    expect(evidence.cleanup.errors).toEqual([
      'drill_cancel_failed: s-211 500',
      'drill_cancel_failed: t-211 500',
      'drill_flatten_failed: CfdOnStock:211 500',
    ]);
    expect(evidence.flatAfter).toMatchObject({ netPositions: 1, openOrders: 2 });
    expect(evidence.passed).toBe(false);
  });

  it('fails when Saxo rejects both amends and still cleans up', async () => {
    const fake = new FakeSaxoSim();
    fake.amendStatuses = [400, 400];
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_stop_amend_rejected: AAPL:xnas');
    expect(evidence.cleanup.cancelled.sort()).toEqual(['s-211', 't-211']);
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0, openOrders: 0 });
  });

  it('cancels both legs and flattens when the resting stop does not match what was sent', async () => {
    const fake = new FakeSaxoSim();
    fake.stopPriceDrift = 1;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_stop_mismatch: AAPL:xnas');
    expect(evidence.cleanup.cancelled.sort()).toEqual(['s-211', 't-211']);
    expect(evidence.cleanup.flattened).toEqual(['CfdOnStock:211']);
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0, openOrders: 0 });
    expect(fake.trades().at(-1)?.body).toMatchObject({
      BuySell: 'Buy',
      Amount: 1,
      OrderType: 'Market',
    });
    expect(evidence.passed).toBe(false);
  });

  it('cancels before it flattens, so a stray buy stop cannot reopen a position', async () => {
    const fake = new FakeSaxoSim();
    fake.amendTriggers = false;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_stop_not_triggered: AAPL:xnas');
    expect(fake.trades().map((call) => call.method)).toEqual([
      'POST',
      'PATCH',
      'DELETE',
      'DELETE',
      'POST',
    ]);
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0, openOrders: 0 });
  });

  it('records an entry that never fills and cleans up the resting master legs', async () => {
    const fake = new FakeSaxoSim();
    fake.fillsEntry = false;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_entry_not_filled: AAPL:xnas');
    expect(evidence.cleanup.cancelled.sort()).toEqual(['s-211', 't-211']);
    expect(fake.orders).toHaveLength(0);
  });

  it('records a rejected entry with its reason', async () => {
    const fake = new FakeSaxoSim();
    fake.entryStatus = 400;
    const { evidence } = await drill(fake);
    expect(evidence.failure).toBe('drill_entry_rejected: AAPL:xnas');
    expect(evidence.steps.find((step) => step.code === 'drill_entry_placed')?.detail).toMatchObject(
      {
        status: 400,
      },
    );
  });

  it('keeps the original failure when cleanup itself errors', async () => {
    const fake = new FakeSaxoSim();
    fake.amendTriggers = false;
    const clock = new FakeClock();
    let failReads = false;
    const gateway = new SaxoSimGateway({
      baseUrl: SAXO_SIM_GATEWAY,
      accessToken: async () => TOKEN,
      fetch: async (url, init) => {
        if (failReads && url.includes('/port/v1/')) return new Response('', { status: 500 });
        if (init.method === 'PATCH') failReads = true;
        return fake.fetch(url, init);
      },
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    const { evidence } = await runSimCfdStopDrill(gateway, OPTIONS, clock);
    expect(evidence.failure).toBe('drill_stop_not_triggered: AAPL:xnas');
    expect(evidence.cleanup.errors).toEqual([
      'drill_cancel_error: saxo_sim_read_failed: 500 on /port/v1/orders/me',
      'drill_flatten_error: saxo_sim_read_failed: 500 on /port/v1/netpositions/me',
      'drill_flat_check_error: saxo_sim_read_failed: 500 on /port/v1/netpositions/me',
    ]);
    expect(evidence.passed).toBe(false);
  });
});

describe('instrument rules', () => {
  it('reads the tick from the scheme element that covers the price, else the default', async () => {
    const fake = new FakeSaxoSim();
    const rules = await instrumentRules(gatewayFor(fake, new FakeClock()), {
      uic: 211,
      assetType: 'CfdOnStock',
    });
    expect(rules.tickSize(0.5)).toBe(0.0001);
    expect(rules.tickSize(200)).toBe(0.01);
    expect(rules.minimumAmount).toBe(1);
  });
});

describe('redaction', () => {
  it('blanks identity keys and every secret substring, at any depth', () => {
    expect(
      redact(
        {
          AccountKey: 'x',
          nested: [{ ClientKey: 'y', note: `token ${TOKEN} and ${ACCOUNT_KEY}` }],
          count: 3,
        },
        [TOKEN, ACCOUNT_KEY, ''],
      ),
    ).toEqual({
      AccountKey: '[redacted]',
      nested: [{ ClientKey: '[redacted]', note: 'token [redacted] and [redacted]' }],
      count: 3,
    });
  });

  it('leaves no account key, client key or token in the written evidence', async () => {
    const fake = new FakeSaxoSim();
    fake.entryStatus = 400;
    const { evidence } = await drill(fake);
    const dir = mkdtempSync(join(tmpdir(), 'sim-drill-'));
    try {
      const written = writeEvidence(evidence, dir, [TOKEN, ACCOUNT_KEY, CLIENT_KEY]);
      const text = readFileSync(written.json, 'utf8') + readFileSync(written.markdown, 'utf8');
      expect(written.json).toBe(join(dir, 'sim-cfd-stop-drill-2026-10-01.json'));
      for (const secret of [TOKEN, ACCOUNT_KEY, CLIENT_KEY]) expect(text).not.toContain(secret);
      expect(JSON.stringify(evidence)).toContain(ACCOUNT_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the verdict and summary', () => {
  it('passes only with no failure, no cleanup error, a flat account and every drilled instrument passed', async () => {
    const { evidence } = await drill(new FakeSaxoSim());
    expect(drillPassed(evidence)).toBe(true);
    expect(drillPassed({ ...evidence, cleanup: { ...evidence.cleanup, errors: ['x'] } })).toBe(
      false,
    );
    expect(
      drillPassed({ ...evidence, flatAfter: { at: 'a', netPositions: 1, openOrders: 0 } }),
    ).toBe(false);
    expect(drillPassed({ ...evidence, failure: 'x' })).toBe(false);
  });

  it('renders a table row per instrument and names the JSON record', async () => {
    const { evidence } = await drill(new FakeSaxoSim());
    const summary = renderSummary(evidence, 'sim-cfd-stop-drill-2026-10-01.json');
    expect(summary).toContain('Verdict: **PASSED**');
    expect(summary).toContain(
      '| AAPL:xnas | CfdOnStock | passed | - | 200 | 220.11 | Working | 199 | FinalFill | 199.5 |',
    );
    expect(summary).toContain('| ISF:xlon | CfdOnEtf | skipped | instrument_not_found |');
    expect(summary).toContain('Full record: sim-cfd-stop-drill-2026-10-01.json');
  });

  it('says what was not read on a refused run', () => {
    const clock = new FakeClock();
    const evidence = { ...newEvidence(clock), failure: 'sim_only_refusal: x' };
    const summary = renderSummary(evidence, 'r.json');
    expect(summary).toContain('Verdict: **FAILED**');
    expect(summary).toContain('- Flat before: not read');
    expect(summary).toContain('- Failure: sim_only_refusal: x');
  });
});

describe('CLI arguments', () => {
  it('defaults to AAPL and ISF CFDs written under docs/reviews', () => {
    const args = parseDrillArgs([]);
    expect(args.targets).toEqual([
      { symbol: 'AAPL:xnas', assetType: 'CfdOnStock' },
      { symbol: 'ISF:xlon', assetType: 'CfdOnEtf' },
    ]);
    expect(args.outDir.endsWith(join('docs', 'reviews'))).toBe(true);
  });

  it('takes overrides and none', () => {
    expect(
      parseDrillArgs(['--stock', 'MSFT:xnas', '--etf', 'none', '--out-dir', '/tmp/x']),
    ).toEqual({
      targets: [{ symbol: 'MSFT:xnas', assetType: 'CfdOnStock' }],
      outDir: '/tmp/x',
    });
  });

  it.each([[['--stock']], [['--bogus', 'x']], [['--stock', 'none', '--etf', 'none']]])(
    'refuses %j',
    (argv) => {
      expect(() => parseDrillArgs(argv)).toThrow(/usage/);
    },
  );
});

describe('SIM token source', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sim-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const logger = { log: () => {} };

  function saved(environment: 'sim' | 'live', refreshInMs: number): string {
    const path = join(dir, `${environment}.json`);
    writeTokenFile(path, {
      environment,
      accessToken: 'file-access',
      refreshToken: 'file-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + refreshInMs).toISOString(),
      obtainedAt: new Date().toISOString(),
    });
    return path;
  }

  it('refuses a token file that holds a live session', () => {
    expect(() => simTokenSource({}, logger, saved('live', 3_600_000))).toThrow(SimOnlyRefusal);
  });

  it('uses the pasted SIM token when no session file exists', async () => {
    const choice = simTokenSource(
      { SAXO_SIM_ACCESS_TOKEN: ` ${TOKEN} ` },
      logger,
      join(dir, 'none.json'),
    );
    expect(choice.origin).toBe('env_token');
    await expect(choice.source.getAccessToken()).resolves.toBe(TOKEN);
    await expect(choice.secrets()).resolves.toEqual([TOKEN, TOKEN]);
  });

  it('prefers a live SIM session file', async () => {
    const env = { SAXO_SIM_APP_KEY: 'k', SAXO_SIM_APP_SECRET: 's', SAXO_SIM_ACCESS_TOKEN: TOKEN };
    const choice = simTokenSource(env, logger, saved('sim', 3_600_000));
    expect(choice.origin).toBe('token_file');
    await expect(choice.source.getAccessToken()).resolves.toBe('file-access');
    await choice.source.stop();
  });

  it('falls back to the pasted token when the session file refresh token has expired', () => {
    const env = { SAXO_SIM_APP_KEY: 'k', SAXO_SIM_APP_SECRET: 's', SAXO_SIM_ACCESS_TOKEN: TOKEN };
    expect(simTokenSource(env, logger, saved('sim', -1_000)).origin).toBe('env_token');
  });

  it('says where to put a token when there is none', () => {
    expect(() => simTokenSource({}, logger, join(dir, 'none.json'))).toThrow(
      /saxo_sim_token_missing/,
    );
  });
});

function staticTokens(): SimTokenChoice {
  return {
    source: {
      getAccessToken: async () => TOKEN,
      sessionState: () => ({ status: 'unrefreshable' }),
      stop: async () => {},
    },
    origin: 'env_token',
    secrets: async () => [TOKEN],
  };
}

function cliDeps(
  fake: FakeSaxoSim,
  clock: FakeClock,
  tokens: () => SimTokenChoice = staticTokens,
  entries: LogEntry[] = [],
): DrillDeps {
  return { fetch: fake.fetch, clock, logger: { log: (entry) => entries.push(entry) }, tokens };
}

describe('main', () => {
  it('runs the drill, writes redacted evidence and exits 0 on a pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-drill-main-'));
    const entries: LogEntry[] = [];
    try {
      const code = await main(
        ['--etf', 'none', '--out-dir', dir],
        {},
        cliDeps(new FakeSaxoSim(), new FakeClock(), staticTokens, entries),
      );
      expect(code).toBe(0);
      const record = JSON.parse(
        readFileSync(join(dir, 'sim-cfd-stop-drill-2026-10-01.json'), 'utf8'),
      );
      expect(record.passed).toBe(true);
      expect(JSON.stringify(record)).not.toContain(ACCOUNT_KEY);
      expect(entries.map((entry) => entry.event)).toEqual([
        'sim_cfd_drill_token',
        'sim_cfd_drill_passed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 on a failed drill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-drill-main-'));
    const fake = new FakeSaxoSim();
    fake.trial = false;
    try {
      expect(await main(['--out-dir', dir], {}, cliDeps(fake, new FakeClock()))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
