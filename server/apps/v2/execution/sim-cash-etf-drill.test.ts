import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryApproval } from '../../../../contracts/index.js';
import { TokenBucket } from '../../../shared/index.js';
import { V2RiskGate } from '../risk/index.js';
import type { SaxoOrderActivity, SaxoOrderRequest } from './saxo/saxo-client.js';
import { SaxoHttpBrokerClient } from './saxo/saxo-http-client.js';
import { StaticSaxoTokenSource } from './saxo/saxo-token-source.js';
import { saxoWireReference } from './saxo/saxo-wire-reference.js';
import { SAXO_SIM_GATEWAY, SaxoSimGateway } from './saxo-sim-gateway.js';
import { countPlacements, FILL_PRICE_BAND, fillMismatches } from './sim-cash-etf-drill.js';
import { renderSummary } from './sim-cfd-drill-evidence.js';
import type { SimAccount, SimQuote } from './sim-cfd-drill-reads.js';
import {
  DEFAULT_DRILL_OPTIONS,
  type DrillOptions,
  runSimCfdStopDrill,
} from './sim-cfd-stop-drill.js';
import { type DrillDeps, main, parseDrillArgs, simHttpBroker } from './sim-cfd-stop-drill-cli.js';

const ACCOUNT_KEY = 'acct-key-sentinel-cash';
const CLIENT_KEY = 'client-key-sentinel-cash';
const TOKEN = 'sim-token-sentinel-cash';

type Row = Record<string, unknown>;
type Reply = readonly [number, unknown];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Row | undefined;
}

class FakeCashSim {
  readonly calls: Call[] = [];
  isComplex: unknown = false;
  currency = 'GBP';
  marketOpen = true;
  tradable = true;
  orderTypes = ['Market', 'Limit', 'StopIfTraded'];
  bid = 1044;
  ask = 1046;
  fillPrice = 1045;
  placeStatus = 200;
  echoReference = true;
  fillSide: string | undefined;
  strayActivityOnRead: number | undefined;
  positions: { uic: number; assetType: string; amount: number }[] = [];
  activities: Row[] = [];
  private activityReads = 0;
  private sequence = 0;

  readonly fetch = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const href = String(url);
    if (!href.startsWith(`${SAXO_SIM_GATEWAY}/`)) throw new Error(`left the SIM gateway: ${href}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const fromGateway = headers['x-request-id']?.startsWith('sim-cfd-stop-drill-') === true;
    if (fromGateway && init.redirect !== 'error') throw new Error('gateway call without redirect');
    if (headers.authorization !== `Bearer ${TOKEN}`) throw new Error('missing SIM bearer');
    const path = href.slice(SAXO_SIM_GATEWAY.length);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : undefined;
    const method = String(init.method ?? 'GET');
    this.calls.push({ method, path, body });
    const [status, payload] = this.route(method, path, body);
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status });
  };

  trades(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  private route(method: string, path: string, body: Row | undefined): Reply {
    const [bare = '', search = ''] = path.split('?');
    if (method === 'POST') return this.place(body ?? {});
    if (method !== 'GET') return [404, undefined];
    return this.read(bare, new URLSearchParams(search));
  }

  private read(bare: string, query: URLSearchParams): Reply {
    if (bare === '/port/v1/accounts/me') {
      const account = {
        AccountKey: ACCOUNT_KEY,
        ClientKey: CLIENT_KEY,
        Currency: 'EUR',
        IsTrialAccount: true,
      };
      return [200, { Data: [account] }];
    }
    if (bare === '/ref/v1/instruments') return [200, { Data: this.listing(query) }];
    if (bare.startsWith('/ref/v1/instruments/details/')) return [200, this.details(bare)];
    if (bare === '/trade/v1/infoprices') return [200, this.quote()];
    if (bare.startsWith('/port/v1/netpositions')) return [200, { Data: this.netRows() }];
    if (bare.startsWith('/port/v1/orders')) return [200, { Data: [] }];
    if (bare === '/cs/v1/audit/orderactivities') return [200, { Data: this.readActivities() }];
    return [404, undefined];
  }

  private listing(query: URLSearchParams): Row[] {
    return [
      { Symbol: 'ISF:xlon', Identifier: 311, AssetType: 'Etf' },
      { Symbol: 'SGLN:xlon', Identifier: 312, AssetType: 'Etc' },
    ].filter((row) => row.AssetType === query.get('AssetTypes'));
  }

  private details(bare: string): Row {
    const [uic, assetType] = bare.split('/').slice(-2);
    return {
      Uic: Number(uic),
      AssetType: assetType,
      IsTradable: this.tradable,
      ...(this.isComplex === undefined ? {} : { IsComplex: this.isComplex }),
      SupportedOrderTypes: this.orderTypes,
      CurrencyCode: this.currency,
      PriceCurrency: 'GBX',
      PriceToContractFactor: 0.01,
    };
  }

  private quote(): Row {
    return {
      Quote: { Bid: this.bid, Ask: this.ask, DelayedByMinutes: 15 },
      InstrumentPriceDetails: { IsMarketOpen: this.marketOpen },
    };
  }

  private netRows(): Row[] {
    return this.positions.map((position) => ({
      NetPositionId: `${position.uic}__${position.assetType}`,
      NetPositionBase: {
        Uic: position.uic,
        AssetType: position.assetType,
        Amount: position.amount,
      },
      NetPositionView: { AverageOpenPrice: this.fillPrice },
    }));
  }

  private readActivities(): Row[] {
    this.activityReads += 1;
    if (this.activityReads === this.strayActivityOnRead) {
      const stray = { BuySell: 'Buy', Amount: 1, Uic: 999, AssetType: 'Stock' };
      this.activities.push(this.activity(stray, 'stray'));
    }
    return this.activities;
  }

  private activity(body: Row, orderId: string): Row {
    this.sequence += 1;
    return {
      ActivityTime: '2026-10-01T09:00:05.000Z',
      LogId: `log-${this.sequence}`,
      OrderId: orderId,
      ...(this.echoReference ? { ExternalReference: body.ExternalReference } : {}),
      Status: 'FinalFill',
      Amount: body.Amount,
      FillAmount: body.Amount,
      AveragePrice: this.fillPrice,
      BuySell: this.fillSide ?? body.BuySell,
      Uic: body.Uic,
      AssetType: body.AssetType,
      AccountKey: ACCOUNT_KEY,
    };
  }

  private place(body: Row): Reply {
    if (this.placeStatus !== 200) {
      return [this.placeStatus, { ErrorInfo: { ErrorCode: 'Rejected', Message: 'refused' } }];
    }
    const orderId = `o-${this.sequence + 1}`;
    const signed = Number(body.Amount) * (body.BuySell === 'Buy' ? 1 : -1);
    const held = this.positions.find(
      (row) => row.uic === body.Uic && row.assetType === body.AssetType,
    );
    if (held === undefined) {
      this.positions.push({
        uic: Number(body.Uic),
        assetType: String(body.AssetType),
        amount: signed,
      });
    } else held.amount += signed;
    this.positions = this.positions.filter((row) => row.amount !== 0);
    this.activities.push(this.activity(body, orderId));
    return [200, { OrderId: orderId }];
  }
}

class FakeClock {
  private millis = Date.parse('2026-10-01T09:00:00.000Z');
  readonly now = (): Date => new Date(this.millis);
  readonly sleep = async (ms: number): Promise<void> => {
    this.millis += ms;
  };
}

const CASH_ISF = { symbol: 'ISF:xlon', assetType: 'Etf', side: 'long' } as const;

const OPTIONS: DrillOptions = {
  ...DEFAULT_DRILL_OPTIONS,
  targets: [CASH_ISF],
  runId: 'r1',
  pollIntervalMs: 1_000,
  fillTimeoutMs: 5_000,
};

function brokerFor(account: SimAccount): SaxoHttpBrokerClient {
  return new SaxoHttpBrokerClient({
    environment: 'sim',
    baseUrl: SAXO_SIM_GATEWAY,
    tokenSource: new StaticSaxoTokenSource(TOKEN),
    accountKey: account.accountKey,
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    logger: { log: () => {} },
  });
}

let fake: FakeCashSim;

beforeEach(() => {
  fake = new FakeCashSim();
  vi.stubGlobal('fetch', fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function drill(options: DrillOptions = OPTIONS, withBroker = true) {
  const clock = new FakeClock();
  const gateway = new SaxoSimGateway({
    baseUrl: SAXO_SIM_GATEWAY,
    accessToken: async () => TOKEN,
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: () => clock.now().getTime(),
  });
  const signal = new AbortController().signal;
  const result = await runSimCfdStopDrill(
    gateway,
    options,
    clock,
    signal,
    withBroker ? brokerFor : undefined,
  );
  return { ...result, gateway, record: result.evidence.instruments[0] };
}

describe('the cash ETF leg (#1400 AC3, AC6)', () => {
  it('pairs the gate, buys one share by wire key, reads the fill back and sells flat', async () => {
    const { evidence, record, gateway } = await drill();
    expect(evidence.passed).toBe(true);
    expect(record).toMatchObject({ assetType: 'Etf', outcome: 'passed', uic: 311, amount: 1 });
    const entryRef = saxoWireReference('drill-r1-311');
    const exitRef = saxoWireReference('drill-r1-311:flat');
    expect(entryRef.length).toBeLessThanOrEqual(50);
    expect(fake.trades().map((call) => call.body)).toEqual([
      expect.objectContaining({
        AccountKey: ACCOUNT_KEY,
        Uic: 311,
        AssetType: 'Etf',
        BuySell: 'Buy',
        Amount: 1,
        OrderType: 'Market',
        ExternalReference: entryRef,
      }),
      expect.objectContaining({ BuySell: 'Sell', Amount: 1, ExternalReference: exitRef }),
    ]);
    expect(fake.trades().some((call) => call.body?.Orders !== undefined)).toBe(false);
    expect(gateway.tradeRequests).toBe(0);
    expect(record?.entry).toMatchObject({ externalReference: entryRef, fillPrice: 1045 });
    expect(record?.cash?.exitFill).toMatchObject({ BuySell: 'Sell', FillAmount: 1 });
    expect(evidence.flatBefore).toMatchObject({ netPositions: 0, openOrders: 0 });
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0, openOrders: 0 });
    expect(fake.positions).toEqual([]);
  });

  it('records the paired gate: the unbreached book is approved, the halted one refused', async () => {
    const { record } = await drill();
    const gate = record?.cash?.gate;
    expect(gate?.control.size).toBeGreaterThan(0);
    expect(gate?.control.refusal).toBeUndefined();
    expect(gate?.control.book).toMatchObject({ halted: false, ytdLossGbp: 0 });
    expect(gate?.breached).toMatchObject({
      size: 0,
      refusal: 'zero_size',
      book: { halted: true, sizeMultiplier: 0, ytdLossGbp: 1_501 },
    });
    expect(gate).toMatchObject({ tradeRequestsDuringBreach: 0, newActivitiesDuringBreach: 0 });
    expect(record?.cash).toMatchObject({
      isComplex: false,
      priceCurrency: 'GBX',
      priceToContractFactor: 0.01,
      fillPriceBand: FILL_PRICE_BAND,
    });
  });

  it('fails the leg when an order activity lands during the breached check', async () => {
    fake.strayActivityOnRead = 2;
    const { evidence, record } = await drill();
    expect(record).toMatchObject({ outcome: 'failed', reason: 'cash_etf_breach_sent_request' });
    expect(record?.cash?.gate?.newActivitiesDuringBreach).toBe(1);
    expect(fake.trades()).toHaveLength(0);
    expect(evidence.passed).toBe(false);
  });

  it('fails the leg when a wrong gate approves the breached book, counting its placement', async () => {
    const realApprove = V2RiskGate.prototype.approveEntry;
    let first: EntryApproval | undefined;
    vi.spyOn(V2RiskGate.prototype, 'approveEntry').mockImplementation(function (
      this: V2RiskGate,
      request,
    ) {
      first ??= realApprove.call(this, request);
      return first;
    });
    const { evidence, record } = await drill();
    vi.restoreAllMocks();
    expect(record).toMatchObject({ outcome: 'failed', reason: 'cash_etf_breach_sent_request' });
    expect(record?.cash?.gate?.tradeRequestsDuringBreach).toBe(1);
    expect(evidence.passed).toBe(false);
    expect(fake.positions).toEqual([]);
  });

  it('records a leg that fails before the gate as failed, not running', async () => {
    fake.currency = 'USD';
    const { record } = await drill();
    expect(record).toMatchObject({ outcome: 'failed', reason: 'cash_etf_not_gbp' });
    expect(fake.trades()).toHaveLength(0);
  });

  it.each([
    ['complex', true, 'cash_etf_complex'],
    ['missing', undefined, 'cash_etf_complex'],
    ['not a boolean', 'false', 'cash_etf_complex'],
  ])('refuses an IsComplex flag that is %s and places nothing', async (_label, flag, reason) => {
    fake.isComplex = flag;
    const { evidence, record } = await drill();
    expect(record).toMatchObject({ outcome: 'failed', reason });
    expect(record?.cash?.isComplex).toBe(flag);
    expect(fake.trades()).toHaveLength(0);
    expect(evidence.passed).toBe(false);
  });

  it('looks the line up as Etf only, so an ETC with the same TIDM is not drilled', async () => {
    const { record } = await drill({ ...OPTIONS, targets: [{ ...CASH_ISF, symbol: 'SGLN:xlon' }] });
    expect(record).toMatchObject({ outcome: 'skipped', reason: 'instrument_not_found' });
    expect(fake.calls.find((call) => call.path.startsWith('/ref/v1/instruments?'))?.path).toContain(
      'AssetTypes=Etf',
    );
    expect(fake.trades()).toHaveLength(0);
  });

  it.each([
    ['the market is closed', (sim: FakeCashSim) => (sim.marketOpen = false), 'market_closed'],
    [
      'the line is not tradable',
      (sim: FakeCashSim) => (sim.tradable = false),
      'instrument_not_tradable',
    ],
  ])('skips when %s', async (_label, arrange, reason) => {
    arrange(fake);
    const { record } = await drill();
    expect(record).toMatchObject({ outcome: 'skipped', reason });
    expect(fake.trades()).toHaveLength(0);
  });

  it('skips a TIDM SIM does not list as Etf', async () => {
    const { record } = await drill({ ...OPTIONS, targets: [{ ...CASH_ISF, symbol: 'NOPE:xlon' }] });
    expect(record).toMatchObject({ outcome: 'skipped', reason: 'instrument_not_found' });
  });

  it.each([
    ['a non-GBP line', (sim: FakeCashSim) => (sim.currency = 'USD'), 'cash_etf_not_gbp'],
    [
      'no Market order type',
      (sim: FakeCashSim) => (sim.orderTypes = ['Limit']),
      'market_order_unsupported',
    ],
    ['an unusable quote', (sim: FakeCashSim) => (sim.bid = 0), 'quote_unusable'],
    [
      'a price no unbreached book can size',
      (sim: FakeCashSim) => (sim.ask = 2_000_000),
      'cash_etf_control_refused',
    ],
  ])('fails on %s before any order', async (_label, arrange, reason) => {
    arrange(fake);
    const { record } = await drill();
    expect(record?.reason).toBe(reason);
    expect(fake.trades()).toHaveLength(0);
  });

  it('fails without a SIM broker for the cash leg', async () => {
    const { record } = await drill(OPTIONS, false);
    expect(record?.reason).toBe('cash_etf_broker_missing');
    expect(fake.trades()).toHaveLength(0);
  });

  it('fails a rejected buy and records the venue error', async () => {
    fake.placeStatus = 400;
    const { evidence, record } = await drill();
    expect(record?.reason).toBe('cash_etf_buy_rejected');
    expect(evidence.steps.map((step) => step.code)).toContain('cash_etf_buy_rejected');
  });

  it('does not take a fill whose activity lacks the wire key, and cleanup sells it flat', async () => {
    fake.echoReference = false;
    const { evidence, record, gateway } = await drill();
    expect(record?.reason).toBe('cash_etf_fill_unmatched');
    expect(record?.cash?.unmatchedActivities).toHaveLength(1);
    expect(gateway.tradeRequests).toBe(1);
    expect(evidence.cleanup.flattened).toEqual(['Etf:311']);
    expect(evidence.flatAfter).toMatchObject({ netPositions: 0 });
  });

  it('fails a fill on the wrong side', async () => {
    fake.fillSide = 'Sell';
    const { record } = await drill();
    expect(record?.reason).toBe('cash_etf_fill_mismatch(side)');
  });

  it('renders the gate pair and both fills in the summary', async () => {
    const { evidence } = await drill();
    const summary = renderSummary(evidence, 'x.json');
    expect(summary).toContain('IsComplex read false; price unit GBX × 0.01');
    expect(summary).toMatch(/unbreached book approved \d+ \(refusal -\)/);
    expect(summary).toContain('halted yes, YTD loss £1501) refused with zero_size');
    expect(summary).toContain(
      'SIM trade requests during the refused check: 0, new order activities: 0',
    );
    expect(summary).toContain('entry Buy 1/1 FinalFill at 1045');
    expect(summary).toContain('flatten Sell 1/1 FinalFill at 1045');
  });
});

describe('fill against order', () => {
  const order: SaxoOrderRequest = {
    Uic: 311,
    AssetType: 'Etf',
    BuySell: 'Buy',
    Amount: 1,
    OrderType: 'Market',
    OrderDuration: { DurationType: 'DayOrder' },
    ManualOrder: false,
    ExternalReference: 'ref',
  };
  const quote: SimQuote = {
    bid: 1044,
    ask: 1046,
    isMarketOpen: true,
    shortTradeDisabled: false,
    delayedByMinutes: 15,
  };
  const fill: SaxoOrderActivity = {
    ActivityTime: 't',
    LogId: 'l',
    OrderId: 'o',
    ExternalReference: 'ref',
    Status: 'FinalFill',
    Amount: 1,
    FillAmount: 1,
    AveragePrice: 1045,
    BuySell: 'Buy',
    Uic: 311,
    AssetType: 'Etf',
  };

  it('accepts a matching fill within the band of the quoted unit', () => {
    expect(fillMismatches(fill, order, quote)).toEqual([]);
    expect(fillMismatches({ ...fill, AveragePrice: undefined, Price: 1045 }, order, quote)).toEqual(
      [],
    );
  });

  it.each([
    [{ Uic: 312 }, ['uic']],
    [{ AssetType: 'CfdOnEtf' }, ['asset_type']],
    [{ BuySell: 'Sell' as const }, ['side']],
    [{ Amount: 2, FillAmount: 2 }, ['amount']],
    [{ FillAmount: 0.5 }, ['fill_amount']],
    [{ AveragePrice: 10.45 }, ['price']],
    [{ AveragePrice: undefined }, ['price']],
  ])('flags %j', (change, expected) => {
    expect(fillMismatches({ ...fill, ...change }, order, quote)).toEqual(expected);
  });
});

describe('placement counter', () => {
  it('counts placeOrder calls and nothing else', async () => {
    const inner = {
      getInstrumentDetails: vi.fn(),
      listOrderActivities: vi.fn().mockResolvedValue([]),
      placeOrder: vi.fn().mockResolvedValue({ OrderId: 'o' }),
    };
    const counted = countPlacements(inner);
    await counted.broker.listOrderActivities(new Date(0));
    await counted.broker.getInstrumentDetails(1, 'Etf');
    expect(counted.placed()).toBe(0);
    await counted.broker.placeOrder({} as SaxoOrderRequest, 'r');
    expect(counted.placed()).toBe(1);
    expect(inner.placeOrder).toHaveBeenCalledWith({}, 'r');
  });
});

describe('simHttpBroker', () => {
  it.each([
    'https://gateway.saxobank.com/openapi',
    'https://gateway.saxobank.com/sim/openapi.evil.example',
  ])('refuses a base URL that is not the SIM gateway: %s', (baseUrl) => {
    expect(() =>
      simHttpBroker({
        baseUrl,
        tokenSource: new StaticSaxoTokenSource(TOKEN),
        accountKey: ACCOUNT_KEY,
        logger: { log: () => {} },
      }),
    ).toThrow();
  });
});

describe('--cash-etf', () => {
  it('is off by default and adds an Etf long when named', () => {
    expect(parseDrillArgs([]).targets.some((target) => target.assetType === 'Etf')).toBe(false);
    expect(
      parseDrillArgs(['--stock', 'none', '--etf', 'none', '--uk-long', 'none', '--cash-etf', 'ISF'])
        .targets,
    ).toEqual([CASH_ISF]);
  });

  it.each([
    [['--stock', 'none', '--etf', 'none', '--uk-long', 'none', '--cash-etf', 'none']],
    [['--cash-etf', 'ISF', '--phase', 'place']],
    [['--resume', '/tmp/p.json', '--cash-etf', 'ISF']],
  ])('refuses %j', (argv) => {
    expect(() => parseDrillArgs(argv)).toThrow(/usage/);
  });

  it('runs from main through the injected SIM broker and writes a -cash-etf record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-cash-etf-'));
    const brokers: string[] = [];
    const deps: DrillDeps = {
      fetch: fake.fetch,
      clock: new FakeClock(),
      logger: { log: () => {} },
      tokens: () => ({
        source: new StaticSaxoTokenSource(TOKEN),
        origin: 'env_token',
        secrets: async () => [TOKEN],
      }),
      onInterrupt: () => () => {},
      simBroker: (options) => {
        brokers.push(`${options.baseUrl} ${options.accountKey === ACCOUNT_KEY}`);
        return brokerFor({ accountKey: options.accountKey, clientKey: '', currency: '' });
      },
    };
    try {
      const argv = ['--stock', 'none', '--etf', 'none', '--uk-long', 'none', '--cash-etf', 'ISF'];
      expect(await main([...argv, '--out-dir', dir], {}, deps)).toBe(0);
      expect(brokers).toEqual([`${SAXO_SIM_GATEWAY} true`]);
      const files = readdirSync(dir).sort();
      expect(files).toEqual([
        'sim-cfd-stop-drill-2026-10-01T090000Z-cash-etf.json',
        'sim-cfd-stop-drill-2026-10-01T090000Z-cash-etf.md',
      ]);
      const record = readFileSync(join(dir, files[0] ?? ''), 'utf8');
      expect(record).not.toContain(ACCOUNT_KEY);
      expect(record).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
