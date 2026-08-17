/**
 * Money-math precision invariant (#288 / duplicate #296, decided in
 * [ADR-0005](../../docs/adr/0005-money-math-precision.md)).
 *
 * ADR-0005 keeps IEEE-754 float64 for money math through paper trading rather
 * than adopting a decimal library or integer minor units. That decision is
 * only defensible while accumulated drift stays orders of magnitude under the
 * granularity a venue itself rounds to, so the bound is pinned here as an
 * executable invariant instead of a paragraph in the ADR.
 *
 * The pipeline under test is the real one — `ExecutionImpl.ingestFills()`
 * against the SQLite-backed store, `computePortfolioView()`, and the Feedback
 * Loop's `realizedR()`. Nothing here reimplements it. What IS reimplemented is
 * the *oracle*: the same arithmetic in exact scaled-integer (BigInt)
 * fixed-point, which is what "exactly right" means for a decimal fill feed.
 * Drift is float pipeline minus exact oracle.
 *
 * Magnitudes are deliberately the two ends of the issue's stated risk: a
 * $100k+ BTC price and a sub-cent (SHIB-class) price, both filled in hundreds
 * of partial tranches with unequal sizes and fees on every tranche.
 */

import type {
  Bar,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarkRead,
} from '../../providers/market-data-service/index.js';
import { collectMarks } from '../../providers/market-data-service/index.js';
import type { Clock, ClosedTrade, OpenPosition } from '../../shared/index.js';
import type { CostModel } from '../../tools/backtest/index.js';
import { realizedR } from '../feedback-loop/index.js';
import { computePortfolioView } from '../risk-manager/index.js';
import { ExecutionImpl } from './execute.js';
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

// ---------------------------------------------------------------------------
// Thresholds. Named, explicit, and asserted against each other below so the
// ADR's claim ("drift stays far under what the venue rounds to") cannot rot
// into a vacuous test by someone loosening one number in isolation.
// ---------------------------------------------------------------------------

/**
 * Coarsest granularity money is settled at, in USD. ASSUMPTION, not a repo
 * fact: no venue precision table exists in this codebase (the only rounding
 * constant anywhere is `market-data-service/indicators.ts`'s 8-dp indicator
 * rounding, which is not money). A US equity cent is the coarsest realistic
 * increment; crypto venues quote finer, which only widens the margin.
 */
const BROKER_ROUNDING_USD = 0.01;

/**
 * The invariant: total accumulated drift on a closed lot's money fields, in
 * USD, across the workloads below. Roughly 11x the worst drift these
 * workloads actually produce (8.8e-11 USD, on the mixed-magnitude portfolio)
 * — tight enough to stay a regression detector rather than a rubber stamp.
 * Rounding an average price to the cent, or accumulating a running total
 * instead of recomputing from the persisted `Fill` rows, both blow through
 * it by many orders of magnitude.
 */
const MAX_TOLERATED_DRIFT_USD = 1e-9;

/**
 * Same invariant for quantity, in base units. Held separately because the
 * sub-cent lot's size is ~7.8e8 units, where one ulp is already ~1.2e-7 —
 * a USD-scale threshold would be unsatisfiable there for reasons that have
 * nothing to do with the accounting.
 */
const MAX_TOLERATED_QTY_DRIFT_UNITS = 1e-6;

/**
 * Same invariant for R, which is dimensionless and, per #288, the most
 * error-amplifying consumer: its denominator |entry − stop| is a subtraction
 * of two near-equal prices, so a tight stop divides the (already tiny)
 * absolute price error by a small number. Relative, since R itself is O(1).
 * ~18x the 5.5e-13 these workloads measure at a 0.1% stop.
 */
const MAX_TOLERATED_R_RELATIVE_DRIFT = 1e-11;

/** How tight the stop is in the R workload — 0.1% of entry, ~1000x amplification. */
const TIGHT_STOP_FRACTION = 0.001;

/** Fills the scripted broker releases per poll, so a lot is built over many polls. */
const FILLS_PER_POLL = 37;

// ---------------------------------------------------------------------------
// Exact fixed-point oracle. Scale 1e-24: ~13 orders finer than the drift being
// measured, so the oracle's own truncation cannot be mistaken for drift.
// Differences are converted to Number only AFTER subtraction in exact space —
// converting the operands first would round away the very quantity measured
// (ulp(1e5) is ~1.5e-11, larger than the expected drift).
// ---------------------------------------------------------------------------

const SCALE_DIGITS = 24;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** Exact decimal string → scaled BigInt. Inputs are authored as strings for this reason. */
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

/** float64 → scaled BigInt. `toFixed(24)`'s own rounding is ~1e-25, i.e. noise. */
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

/** Scaled BigInt → Number. Only ever called on a difference, never an operand. */
function toNumber(a: bigint): number {
  return Number(a) / Number(SCALE);
}

/** |float − exact|, computed in exact space. */
function driftOf(actual: number, exact: bigint): number {
  return Math.abs(toNumber(fpOf(actual) - exact));
}

// ---------------------------------------------------------------------------
// Workload construction. Fills are authored as decimal strings (what a venue
// reports) and fed to the pipeline as `Number`, to the oracle as exact fp.
// ---------------------------------------------------------------------------

interface DecimalFill {
  price: string;
  qty: string;
  fee: string;
}

const NOW = new Date('2026-08-04T16:00:00Z');
const OPENED_AT = new Date('2026-08-04T09:00:00Z');

/**
 * A deterministic tranche ladder: `count` fills whose prices walk in
 * sub-tick steps around `basePrice` and whose sizes vary tranche to tranche,
 * because equal-sized tranches would sum without error and hide the thing
 * being measured.
 */
function ladder(
  count: number,
  basePrice: string,
  priceStep: string,
  baseQty: string,
  feePerFill: string,
  /**
   * Walks the price offsets. Entry and exit legs MUST pass different strides
   * (and different steps): if both legs' averages carry the same sub-grid
   * residue, a mutation that rounds both averages cancels itself out in
   * `avgExit − avgEntry` and the test silently stops detecting it.
   */
  offsetStride: number,
): DecimalFill[] {
  const base = fp(basePrice);
  const step = fp(priceStep);
  const qty = fp(baseQty);
  return Array.from({ length: count }, (_, i) => {
    // Prices oscillate rather than trend, so neither average is a plain ramp.
    const offset = BigInt(((i * offsetStride) % 13) - 6);
    const price = base + step * offset;
    // Sizes cycle through 1x..4x the base tranche.
    const size = qty * BigInt(1 + (i % 4));
    return { price: fpToString(price), qty: fpToString(size), fee: feePerFill };
  });
}

/** Scaled BigInt → exact decimal string (round-trip partner of `fp`). */
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
      broker_fill_id: `${tag}-${i}`,
      leg,
      price: Number(decimal.price),
      qty: Number(decimal.qty),
      fee: Number(decimal.fee),
      timestamp: new Date(OPENED_AT.getTime() + (i + 1) * 1000),
    }),
  );
}

/** Exact Σqty, Σ(price × qty) and Σfee over a tranche ladder. */
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

// ---------------------------------------------------------------------------
// Harness: the real `ingestFills()` path, scripted broker, SQLite store.
// ---------------------------------------------------------------------------

/**
 * Releases the scripted fills a batch per poll, because the accumulation being
 * measured is spread across polls in production: `advanceLot()` rebuilds
 * `filledSize`/`avgEntryPrice` from the persisted `Fill` rows on every poll
 * rather than carrying a running total, and that convergence is half of why
 * the bound in ADR-0005 holds. A single all-at-once poll would not test it.
 */
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
  /** #525's re-arm path — this test drives ordinary fills only. */
  async rearmProtectiveLegs(): Promise<void> {}
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  /** #519/#526's reconcile-only surface — this test drives fills only. */
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.resumeFlatten: not part of the fill path');
  }
  /** #429's intervention path — this test drives fills only. */
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
    mode: 'backtest',
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
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

/**
 * Runs one lot end to end: seed → ingest every tranche through the real
 * `ingestFills()` → return the persisted `ClosedTrade`.
 */
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
  // Poll until the feed is drained — many polls, each re-deriving the lot's
  // totals from the persisted rows, which is the production access pattern.
  while (!broker.exhausted) {
    await execution.ingestFills();
  }
  // One extra poll: a re-poll must ingest nothing and emit no second close.
  await execution.ingestFills();

  const closed = await store.getClosedTrades();
  expect(closed).toHaveLength(1);
  return closed[0] as ClosedTrade;
}

/** The exact ClosedTrade the same tranches imply, in fixed-point. */
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

// ---------------------------------------------------------------------------

describe('money-math precision (ADR-0005)', () => {
  it('keeps the pinned tolerance far under the granularity a venue rounds to', () => {
    // Guards the ADR's actual claim: the tolerance is not merely "some number
    // below a cent", it is orders of magnitude below one.
    expect(MAX_TOLERATED_DRIFT_USD).toBeLessThan(BROKER_ROUNDING_USD / 1e6);
  });

  it('holds a BTC-magnitude lot within tolerance across 250 partial fills per leg', async () => {
    // ~$119,873 with sub-cent tranche prices; 250 in, 250 out.
    const entries = ladder(250, '119873.41', '0.07', '0.00071', '0.4137', 7);
    const exits = ladder(250, '121904.29', '0.11', '0.00071', '0.5219', 5);
    const stop = '118000.13';

    const trade = await runLot({ entries, exits, position: { stop: Number(stop) } });
    const exact = exactClosedTrade(entries, exits, stop);

    expect(driftOf(trade.entry, exact.entry)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.fees_total, exact.feesTotal)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    expect(driftOf(trade.realized_pnl_net, exact.pnlNet)).toBeLessThan(MAX_TOLERATED_DRIFT_USD);
    // Quantity is money too — it multiplies every price above.
    expect(driftOf(trade.filled_size, exact.filledSize)).toBeLessThan(
      MAX_TOLERATED_QTY_DRIFT_UNITS,
    );
  });

  it('holds a sub-cent crypto lot within tolerance across 250 partial fills per leg', async () => {
    // SHIB-class: 8-dp price, 7-figure tranche sizes — the other end of the
    // 7-orders-of-magnitude spread #288 names as the risk.
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
    // Size here is ~7.8e8 units, where one ulp is already ~1.2e-7: the
    // threshold below leaves room for a handful of ulps and nothing more.
    expect(driftOf(trade.filled_size, exact.filledSize)).toBeLessThan(
      MAX_TOLERATED_QTY_DRIFT_UNITS,
    );
  });

  it('holds R within tolerance when a tight stop amplifies the entry-price error', async () => {
    const entries = ladder(250, '119873.41', '0.07', '0.00071', '0.4137', 7);
    const exits = ladder(250, '121904.29', '0.11', '0.00071', '0.5219', 5);
    // Stop 0.1% under entry: |entry − stop| is ~1/1000th of entry, so any
    // absolute error in the computed average entry is amplified ~1000x in R.
    const stop = fpToString(fp('119873.41') - mulFp(fp('119873.41'), fpOf(TIGHT_STOP_FRACTION)));

    const trade = await runLot({ entries, exits, position: { stop: Number(stop) } });
    const exact = exactClosedTrade(entries, exits, stop);

    const r = realizedR(trade);
    expect(r).not.toBeNull();
    const relativeDrift = driftOf(r as number, exact.r) / Math.abs(toNumber(exact.r));
    expect(relativeDrift).toBeLessThan(MAX_TOLERATED_R_RELATIVE_DRIFT);
  });

  it('holds portfolio equity within tolerance across a 7-order-of-magnitude book', async () => {
    // One $100k-price lot and one sub-cent lot in the same sum: the small
    // position's value is the one at risk of being rounded away by the large
    // one's exponent.
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
    // Every method except `getMark` throws rather than returning a bland
    // stub value: `computePortfolioView` reads marks and nothing else, and
    // this test's whole claim is that the equity it produces came from those
    // marks. If the implementation later starts pricing off bars, an
    // indicator, a spread or ADV, a permissive stub would let it keep
    // measuring drift against an oracle that no longer describes the code.
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
      getADV: vi.fn(notOnThisPath('getADV') as () => Promise<number>),
    };

    const cash = '1234567.89';
    const view = await computePortfolioView({
      positions,
      marketData,
      asOf: NOW,
      cash: Number(cash),
      peak_equity: 2_000_000,
      daily_basis: {
        crypto: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
        stocks: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
        portfolio: { known: true, open_equity: 2_000_000, realized_pnl: 0 },
      },
      consecutive_losses: 0,
      // This test is about float drift in the valuation arithmetic, not about
      // freshness; the stub observes every mark at `NOW`, so any positive
      // bound passes.
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
    // 0.3+0.3+0.4 sums to exactly 1 in float64; 0.7+0.2+0.1 sums to
    // 0.9999999999999999. Both describe the same fully-exited lot, and a bare
    // `>=` between the two sums declares the lot still open forever — no
    // ClosedTrade, no exit from `getOpenPositions()`. `ingestFills()` compares
    // with a relative epsilon for exactly this reason.
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
    // The other side of the epsilon, and the dangerous one: `coversQty()`
    // declares a lot terminally `closed`, and `reconcile()` only inspects
    // pending/submitted lots, so a tolerance that grew to swallow a REAL
    // remainder would strand quantity at the broker with the store believing
    // the lot flat. 1e-9 of the lot is 1000x the 1e-12 tolerance and still
    // far below any venue's minimum increment — it must read as unfilled.
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(seedPosition({ requested_size: 1, stop: 95 }));
    const entries = [{ price: '100', qty: '1', fee: '0.1' }];
    // 1 − 1e-9 exits: a genuine, if small, unfilled remainder.
    const exits = [{ price: '110', qty: '0.999999999', fee: '0.1' }];

    const broker = new ScriptedBroker([
      ...normalized(entries, 'entry', 'e'),
      ...normalized(exits, 'stop', 'x'),
    ]);
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect(await store.getClosedTrades()).toHaveLength(0);
    const position = await store.getPosition('lot-1');
    expect(position?.order_state).toBe('filled');
    // Still live: Risk must keep seeing the exposure that is genuinely open.
    expect((await store.getOpenPositions()).map((p) => p.idempotency_key)).toContain('lot-1');
  });

  it('reads an entry as filled when its tranches sum a hair under the requested size', async () => {
    // Same defect class as the flat comparison, milder consequence: a lot
    // requested at 1.0 and filled 0.7 + 0.2 + 0.1 (float sum
    // 0.9999999999999999) is complete, and a bare `>=` reports it forever as
    // `partially_filled` — a state the rest of the system reads as "the venue
    // still owes us quantity".
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(seedPosition({ requested_size: 1, stop: 95 }));
    const entries = ['0.7', '0.2', '0.1'].map((qty) => ({ price: '100', qty, fee: '0.1' }));
    expect(entries.reduce((sum, f) => sum + Number(f.qty), 0)).toBeLessThan(1);

    const broker = new ScriptedBroker(normalized(entries, 'entry', 'e'));
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect((await store.getPosition('lot-1'))?.order_state).toBe('filled');
  });
});
