import type {
  Bar,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarkRead,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar, collectMarks } from '../../providers/market-data-service/index.js';
import type { AssetClass, Clock, ClosedTrade, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { CostModel } from '../../tools/backtest/index.js';
import { realizedR } from '../feedback-loop/index.js';
import { computePortfolioView } from '../risk-manager/index.js';
import { ExecutionImpl } from './execute.js';
import { FilledZeroSizeThrottle } from './filled-zero-size-throttle.js';
import { openTestExecutionStore, type TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
} from './types.js';
import { UnrecordedVenuePositionThrottle } from './unrecorded-venue-position-throttle.js';

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

const BROKER_ROUNDING_USD = 0.01;

const MAX_TOLERATED_DRIFT_USD = 1e-9;

const MAX_TOLERATED_QTY_DRIFT_UNITS = 1e-6;

const MAX_TOLERATED_R_RELATIVE_DRIFT = 1e-11;

const TIGHT_STOP_FRACTION = 0.001;

const FILLS_PER_POLL = 37;

const SCALE_DIGITS = 24;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

function fp(decimal: string): bigint {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > SCALE_DIGITS) {
    throw new Error(`fp: '${decimal}' has more than ${SCALE_DIGITS} decimals — widen SCALE.`);
  }
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, '0') || '0');
  return negative ? -scaled : scaled;
}

function fpOf(value: number): bigint {
  return fp(value.toFixed(SCALE_DIGITS));
}

function mulFp(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

function divFp(a: bigint, b: bigint): bigint {
  return (a * SCALE) / b;
}

function absFp(a: bigint): bigint {
  return a < 0n ? -a : a;
}

function toNumber(a: bigint): number {
  return Number(a) / Number(SCALE);
}

function driftOf(actual: number, exact: bigint): number {
  return Math.abs(toNumber(fpOf(actual) - exact));
}

interface DecimalFill {
  price: string;
  qty: string;
  fee: string;
}

const NOW = new Date('2026-08-04T16:00:00Z');
const OPENED_AT = new Date('2026-08-04T09:00:00Z');

function ladder(
  count: number,
  basePrice: string,
  priceStep: string,
  baseQty: string,
  feePerFill: string,
  offsetStride: number,
): DecimalFill[] {
  const base = fp(basePrice);
  const step = fp(priceStep);
  const qty = fp(baseQty);
  return Array.from({ length: count }, (_, i) => {
    const offset = BigInt(((i * offsetStride) % 13) - 6);
    const price = base + step * offset;
    const size = qty * BigInt(1 + (i % 4));
    return { price: fpToString(price), qty: fpToString(size), fee: feePerFill };
  });
}

function fpToString(a: bigint): string {
  const negative = a < 0n;
  const digits = (negative ? -a : a).toString().padStart(SCALE_DIGITS + 1, '0');
  const whole = digits.slice(0, digits.length - SCALE_DIGITS);
  const fraction = digits.slice(digits.length - SCALE_DIGITS).replace(/0+$/, '');
  const text = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

function normalized(fills: readonly DecimalFill[], leg: NormalizedFill['leg'], tag: string) {
  return fills.map(
    (decimal, i): NormalizedFill => ({
      client_order_id: 'lot-1',
      broker_fill_id: toBrokerFillId(`${tag}-${i}`),
      leg,
      price: Number(decimal.price),
      qty: Number(decimal.qty),
      fee: Number(decimal.fee),
      timestamp: new Date(OPENED_AT.getTime() + (i + 1) * 1000),
    }),
  );
}

function exactTotals(fills: readonly DecimalFill[]): {
  qty: bigint;
  notional: bigint;
  fee: bigint;
} {
  return fills.reduce(
    (totals, decimal) => ({
      qty: totals.qty + fp(decimal.qty),
      notional: totals.notional + mulFp(fp(decimal.price), fp(decimal.qty)),
      fee: totals.fee + fp(decimal.fee),
    }),
    { qty: 0n, notional: 0n, fee: 0n },
  );
}

class ScriptedBroker implements BrokerAdapter {
  private released = 0;

  constructor(
    private readonly scriptedFills: NormalizedFill[],
    private readonly batchSize = FILLS_PER_POLL,
  ) {}

  get exhausted(): boolean {
    return this.released >= this.scriptedFills.length;
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [order.client_order_id],
      order_state: 'submitted',
    };
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    this.released = Math.min(this.released + this.batchSize, this.scriptedFills.length);
    return this.scriptedFills
      .slice(0, this.released)
      .filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {}
  async rearmProtectiveLegs(): Promise<void> {}
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.resumeFlatten: not part of the fill path');
  }
  async submitFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.submitFlatten: not part of the fill path');
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedBroker.cancel: not part of the fill path');
  }
  async getOpenPositions(): Promise<never> {
    throw new Error('ScriptedBroker.getOpenPositions: not part of the fill path');
  }
}

function makeInput(broker: BrokerAdapter, store: TestExecutionStore): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  };
  const clock: Clock = { now: () => NOW };
  return {
    trace_id: 'trace-precision',
    clock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    sessionCalendars: OPEN_SESSION_CALENDARS,
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    logger: { log: () => {} },
  };
}

function seedPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'lot-1',
    debate_id: 'debate-precision',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 0,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 0,
    target: 0,
    order_state: 'submitted',
    broker_order_ids: ['lot-1:entry', 'lot-1:stop', 'lot-1:target'],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
}

async function runLot(args: {
  entries: readonly DecimalFill[];
  exits: readonly DecimalFill[];
  position: Partial<OpenPosition>;
}): Promise<ClosedTrade> {
  const { store } = openTestExecutionStore();
  const totalQty = args.entries.reduce((sum, decimal) => sum + Number(decimal.qty), 0);
  await store.writeAheadPosition(seedPosition({ requested_size: totalQty, ...args.position }));

  const broker = new ScriptedBroker([
    ...normalized(args.entries, 'entry', 'e'),
    ...normalized(args.exits, 'stop', 'x'),
  ]);
  const execution = new ExecutionImpl(makeInput(broker, store));
  while (!broker.exhausted) {
    await execution.ingestFills();
  }
  await execution.ingestFills();

  const closed = await store.getClosedTrades();
  const [trade] = closed;
  if (closed.length !== 1 || trade === undefined) {
    throw new Error(`runLot expected exactly one closed trade, got ${closed.length}`);
  }
  return trade;
}

function exactClosedTrade(
  entries: readonly DecimalFill[],
  exits: readonly DecimalFill[],
  stop: string,
): { entry: bigint; filledSize: bigint; pnlNet: bigint; feesTotal: bigint; r: bigint } {
  const entryTotals = exactTotals(entries);
  const exitTotals = exactTotals(exits);
  const avgEntry = divFp(entryTotals.notional, entryTotals.qty);
  const avgExit = divFp(exitTotals.notional, exitTotals.qty);
  const gross = mulFp(avgExit - avgEntry, entryTotals.qty);
  const feesTotal = entryTotals.fee + exitTotals.fee;
  const pnlNet = gross - feesTotal;
  const initialRisk = mulFp(absFp(avgEntry - fp(stop)), entryTotals.qty);
  return {
    entry: avgEntry,
    filledSize: entryTotals.qty,
    pnlNet,
    feesTotal,
    r: divFp(pnlNet, initialRisk),
  };
}

describe('money-math precision (ADR-0005)', () => {
  it('keeps the pinned tolerance far under the granularity a venue rounds to', () => {
    expect(MAX_TOLERATED_DRIFT_USD).toBeLessThan(BROKER_ROUNDING_USD / 1e6);
  });

  it('holds a BTC-magnitude lot within tolerance across 250 partial fills per leg', async () => {
    const entries = ladder(250, '119873.41', '0.07', '0.00071', '0.4137', 7);
    const exits = ladder(250, '121904.29', '0.11', '0.00071', '0.5219', 5);
    const stop = '118000.13';

    const trade = await runLot({ entries, exits, position: { stop: Number(stop) } });
    const exact = exactClosedTrade(entries, exits, stop);

    expect(driftOf(trade.entry, exact.entry)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.fees_total, exact.feesTotal)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.realized_pnl_net, exact.pnlNet)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.filled_size, exact.filledSize)).toBeLessThan(
      MAX_TOLERATED_QTY_DRIFT_UNITS,
    );
  });

  it('holds a sub-cent crypto lot within tolerance across 250 partial fills per leg', async () => {
    const entries = ladder(250, '0.00001234', '0.00000001', '1250000.5', '0.0217', 7);
    const exits = ladder(250, '0.00001307', '0.00000003', '1250000.5', '0.0231', 5);
    const stop = '0.00001180';

    const trade = await runLot({
      entries,
      exits,
      position: { instrument: 'SHIB-USD', stop: Number(stop) },
    });
    const exact = exactClosedTrade(entries, exits, stop);

    expect(driftOf(trade.entry, exact.entry)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.realized_pnl_net, exact.pnlNet)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.filled_size, exact.filledSize)).toBeLessThan(
      MAX_TOLERATED_QTY_DRIFT_UNITS,
    );
  });

  it('holds R within tolerance when a tight stop amplifies the entry-price error', async () => {
    const entries = ladder(250, '119873.41', '0.07', '0.00071', '0.4137', 7);
    const exits = ladder(250, '121904.29', '0.11', '0.00071', '0.5219', 5);
    const stop = fpToString(fp('119873.41') - mulFp(fp('119873.41'), fpOf(TIGHT_STOP_FRACTION)));

    const trade = await runLot({ entries, exits, position: { stop: Number(stop) } });
    const exact = exactClosedTrade(entries, exits, stop);

    const r = realizedR(trade);
    expect(r).not.toBeNull();
    const relativeDrift = driftOf(r as number, exact.r) / Math.abs(toNumber(exact.r));
    expect(relativeDrift).toBeLessThan(MAX_TOLERATED_R_RELATIVE_DRIFT);
  });

  it('holds portfolio equity within tolerance across a 7-order-of-magnitude book', async () => {
    const positions: OpenPosition[] = [
      seedPosition({
        idempotency_key: 'btc',
        instrument: 'BTC-USD',
        filled_size: Number('0.17750000'),
      }),
      seedPosition({
        idempotency_key: 'shib',
        instrument: 'SHIB-USD',
        filled_size: Number('312500125.0'),
      }),
    ];
    const marks: Record<string, string> = {
      'BTC-USD': '119873.41',
      'SHIB-USD': '0.00001234',
    };
    const notOnThisPath = (method: string) => async (): Promise<never> => {
      throw new Error(`computePortfolioView called ${method}: equity must price off marks only`);
    };
    const getMark = vi.fn(
      async (instrument: string, _a: Date): Promise<Mark> => ({
        price: Number(marks[instrument]),
        observed_at: NOW,
        source: 'test',
        asset_class: 'crypto',
      }),
    );
    const marketData: MarketDataService = {
      getBars: vi.fn(notOnThisPath('getBars') as () => Promise<Bar[]>),
      getIndicator: vi.fn(notOnThisPath('getIndicator') as () => Promise<IndicatorValue>),
      getMark,
      getMarks: vi.fn(
        async (instruments: readonly string[], at: Date): Promise<Map<string, MarkRead>> =>
          collectMarks(getMark, instruments, at),
      ),
      getSpreadEstimate: vi.fn(notOnThisPath('getSpreadEstimate') as () => Promise<number | null>),
      getQuote: vi.fn(notOnThisPath('getQuote') as () => Promise<null>),
      getADV: vi.fn(notOnThisPath('getADV') as () => Promise<number>),
    };

    const cash = '1234567.89';
    const view = await computePortfolioView({
      positions,
      marketData,
      asOf: NOW,
      clock: { now: () => NOW },
      cash: Number(cash),
      peak_equity: 2_000_000,
      daily_basis: {
        crypto: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
        stocks: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
        portfolio: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
      },
      consecutive_losses: 0,
      max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    });

    const exactEquity = positions.reduce(
      (sum, position) =>
        sum + mulFp(fpOf(position.filled_size), fp(marks[position.instrument] as string)),
      fp(cash),
    );
    expect(driftOf(view.equity, exactEquity)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
  });

  it('closes a lot flat when its exit tranches are shaped differently from its entries', async () => {
    const entries = ['0.3', '0.3', '0.4'].map((qty) => ({ price: '100', qty, fee: '0.1' }));
    const exits = ['0.7', '0.2', '0.1'].map((qty) => ({ price: '110', qty, fee: '0.1' }));
    expect(exits.reduce((sum, f) => sum + Number(f.qty), 0)).toBeLessThan(
      entries.reduce((sum, f) => sum + Number(f.qty), 0),
    );

    const trade = await runLot({ entries, exits, position: { stop: 95 } });
    const exact = exactClosedTrade(entries, exits, '95');

    expect(trade.close_reason).toBe('stop');
    expect(driftOf(trade.realized_pnl_net, exact.pnlNet)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
  });

  it('leaves a lot open when the exit shortfall is above the tolerance, not float noise', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(seedPosition({ requested_size: 1, stop: 95 }));
    const entries = [{ price: '100', qty: '1', fee: '0.1' }];
    const exits = [{ price: '110', qty: '0.999999999', fee: '0.1' }];

    const broker = new ScriptedBroker([
      ...normalized(entries, 'entry', 'e'),
      ...normalized(exits, 'stop', 'x'),
    ]);
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect(await store.getClosedTrades()).toHaveLength(0);
    const position = await store.getPosition('lot-1');
    expect(position?.order_state).toBe('filled');
    expect((await store.getOpenPositions()).map((p) => p.idempotency_key)).toContain('lot-1');
  });

  it('reads an entry as filled when its tranches sum a hair under the requested size', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(seedPosition({ requested_size: 1, stop: 95 }));
    const entries = ['0.7', '0.2', '0.1'].map((qty) => ({ price: '100', qty, fee: '0.1' }));
    expect(entries.reduce((sum, f) => sum + Number(f.qty), 0)).toBeLessThan(1);

    const broker = new ScriptedBroker(normalized(entries, 'entry', 'e'));
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect((await store.getPosition('lot-1'))?.order_state).toBe('filled');
  });
});
