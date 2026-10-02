import type {
  BrokerMode,
  FillLeg,
  MarketData,
  OrderLeg,
  OrderSide,
  SimulatedFillQuote,
  SimulatedFillRequest,
  V2Bar,
  Venue,
} from '../../../contracts/index.js';
import { calendarDaysBetween } from './cycle.js';
import { quotePerGbp } from './data/index.js';
import { adversePrice } from './execution/index.js';
import {
  bracketExit,
  quoted,
  simulateLimitEntry,
  simulateMarketExit,
  withinLimit,
} from './simulated-entry.js';

const COST_TOLERANCE = 0.25;

export interface BrokerFillPart {
  readonly leg: FillLeg;
  readonly side: OrderSide;
  readonly tradingDate: string;
  readonly qty: number;
  readonly priceGbp: number;
  readonly feeGbp: number;
}

// modelledSlippageBps is what the cycle journalled when the order went out; undefined for an order
// journalled before that, which is priced from today's tables. offsetBps: null is an entry at a limit its sleeve set itself; undefined is an exit whose
// entry the journal does not hold
export interface BrokerOrder {
  readonly clientOrderId: string;
  readonly tradingDate: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly leg: OrderLeg;
  readonly side: OrderSide;
  readonly limit: number | undefined;
  readonly trigger: number | undefined;
  readonly stop: number | undefined;
  readonly target: number | undefined;
  readonly cancelledOn: string | undefined;
  readonly modelledSlippageBps: number | undefined;
  readonly offsetBps: number | null | undefined;
  readonly fills: readonly BrokerFillPart[];
}

export type QuoteFill = (
  tradingDate: string,
  venue: Venue,
  request: SimulatedFillRequest,
) => SimulatedFillQuote;

export type Fidelity =
  | 'match'
  | 'bar_mismatch'
  | 'broker_only'
  | 'sim_only'
  | 'both_unfilled'
  | 'pending';

export interface LegCost {
  readonly notionalGbp: number;
  readonly realisedSlippageGbp: number;
  readonly realisedFeeGbp: number;
  readonly modelledSlippageGbp: number;
  readonly modelledFeeGbp: number;
}

export interface CostRow {
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly leg: FillLeg;
  readonly offsetBps: number | null | undefined;
  readonly fidelity: Fidelity;
  readonly cost: LegCost | undefined;
}

export type CostVerdict = 'pass' | 'fail' | 'insufficient';

export interface CostSample {
  readonly offsetBps: number | null | undefined;
  readonly counts: Readonly<Record<Fidelity, number>>;
  readonly realisedGbp: number;
  readonly modelledGbp: number;
  readonly ratio: number | undefined;
  readonly verdict: CostVerdict;
}

export interface CostFidelityReport {
  readonly mode: BrokerMode;
  readonly rows: readonly CostRow[];
  readonly samples: readonly CostSample[];
}

interface FillGroup {
  readonly leg: FillLeg;
  readonly side: OrderSide;
  readonly tradingDate: string;
  readonly qty: number;
  readonly priceGbp: number;
  readonly feeGbp: number;
}

type Replay =
  | { readonly kind: 'pending' }
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'filled';
      readonly barDate: string;
      readonly reference: number;
      readonly crossesSpread: boolean;
    };

const PENDING: Replay = { kind: 'pending' };
const MISS: Replay = { kind: 'miss' };

function fillGroups(parts: readonly BrokerFillPart[]): readonly FillGroup[] {
  const byLeg = new Map<FillLeg, BrokerFillPart[]>();
  for (const part of parts) byLeg.set(part.leg, [...(byLeg.get(part.leg) ?? []), part]);
  return [...byLeg.values()].map((legParts) => {
    const qty = legParts.reduce((sum, part) => sum + part.qty, 0);
    const value = legParts.reduce((sum, part) => sum + part.qty * part.priceGbp, 0);
    const [first] = legParts as [BrokerFillPart, ...BrokerFillPart[]];
    return {
      leg: first.leg,
      side: first.side,
      tradingDate: legParts.reduce(
        (latest, part) => (part.tradingDate > latest ? part.tradingDate : latest),
        first.tradingDate,
      ),
      qty,
      priceGbp: value / qty,
      feeGbp: legParts.reduce((sum, part) => sum + part.feeGbp, 0),
    };
  });
}

function barsBetween(
  market: MarketData,
  instrument: string,
  from: string,
  before: string,
): readonly V2Bar[] {
  const days = calendarDaysBetween(from, before) + 1;
  return market.barsBefore(instrument, before, days).filter((bar) => bar.date >= from);
}

function entryReplay(order: BrokerOrder, bars: readonly V2Bar[]): Replay {
  const outcome = simulateLimitEntry(
    { side: order.side, limit: order.limit as number, stop: undefined, trigger: order.trigger },
    bars,
  );
  if (outcome.kind === 'pending') return PENDING;
  if (outcome.kind === 'cancelled') return MISS;
  return {
    kind: 'filled',
    barDate: outcome.bar.date,
    reference: outcome.price,
    crossesSpread: outcome.crossesSpread,
  };
}

function marketExitReplay(bars: readonly V2Bar[]): Replay {
  const price = simulateMarketExit(bars);
  const [first] = bars;
  if (price === undefined || first === undefined) return PENDING;
  return { kind: 'filled', barDate: first.date, reference: price, crossesSpread: true };
}

function bracketReplay(order: BrokerOrder, group: FillGroup, bar: V2Bar | undefined): Replay {
  if (bar === undefined) return PENDING;
  const { open, low, high } = quoted(bar);
  const levels = {
    qty: group.side === 'sell' ? 1 : -1,
    stopGbp: order.stop,
    targetGbp: order.target,
  };
  const exit = bracketExit(levels, open, low, high);
  if (exit?.priceGbp === undefined || exit.crossesSpread !== (group.leg === 'stop')) return MISS;
  return {
    kind: 'filled',
    barDate: bar.date,
    reference: exit.priceGbp,
    crossesSpread: exit.crossesSpread,
  };
}

function replay(market: MarketData, order: BrokerOrder, group: FillGroup): Replay {
  if (group.leg === 'stop' || group.leg === 'target') {
    return bracketReplay(order, group, market.lastBarBefore(order.instrument, group.tradingDate));
  }
  const bars = barsBetween(market, order.instrument, order.tradingDate, group.tradingDate);
  return group.leg === 'entry' ? entryReplay(order, bars) : marketExitReplay(bars);
}

function fidelityOf(replayed: Replay, sessionDate: string | undefined): Fidelity {
  if (replayed.kind === 'pending') return 'pending';
  if (replayed.kind === 'miss') return 'broker_only';
  return replayed.barDate === sessionDate ? 'match' : 'bar_mismatch';
}

function legCost(
  order: BrokerOrder,
  group: FillGroup,
  reference: number,
  crossesSpread: boolean,
  quoteFill: QuoteFill,
  quotePerGbpOn: number,
): LegCost {
  const { side, qty } = group;
  const quote = quoteFill(group.tradingDate, order.venue, {
    instrument: order.instrument,
    side,
    qty,
    price: reference,
    crossesSpread,
  });
  const modelledPrice =
    order.modelledSlippageBps === undefined
      ? quote.price
      : adversePrice(reference, side, crossesSpread ? order.modelledSlippageBps : 0);
  const modelled =
    group.leg === 'entry' ? withinLimit(side, order.limit as number, modelledPrice) : modelledPrice;
  const sign = side === 'buy' ? 1 : -1;
  const referenceGbp = reference / quotePerGbpOn;
  return {
    notionalGbp: qty * referenceGbp,
    realisedSlippageGbp: sign * (group.priceGbp - referenceGbp) * qty,
    realisedFeeGbp: group.feeGbp,
    modelledSlippageGbp: (sign * (modelled - reference) * qty) / quotePerGbpOn,
    modelledFeeGbp: quote.fee / quotePerGbpOn,
  };
}

function filledRow(
  market: MarketData,
  order: BrokerOrder,
  group: FillGroup,
  quoteFill: QuoteFill,
): CostRow {
  const replayed = replay(market, order, group);
  const sessionDate = market.lastBarBefore(order.instrument, group.tradingDate)?.date;
  const fidelity = fidelityOf(replayed, sessionDate);
  const cost =
    fidelity === 'match' && replayed.kind === 'filled'
      ? legCost(
          order,
          group,
          replayed.reference,
          replayed.crossesSpread,
          quoteFill,
          quotePerGbp(market, order.venue, group.tradingDate),
        )
      : undefined;
  return rowOf(order, group.leg, fidelity, cost);
}

function rowOf(
  order: BrokerOrder,
  leg: FillLeg,
  fidelity: Fidelity,
  cost: LegCost | undefined,
): CostRow {
  return {
    clientOrderId: order.clientOrderId,
    instrument: order.instrument,
    leg,
    offsetBps: order.offsetBps,
    fidelity,
    cost,
  };
}

function unfilledEntryRow(market: MarketData, order: BrokerOrder): CostRow | undefined {
  if (order.leg !== 'entry' || order.cancelledOn === undefined) return undefined;
  const bars = barsBetween(market, order.instrument, order.tradingDate, order.cancelledOn);
  const replayed = entryReplay(order, bars);
  const fidelity: Fidelity =
    replayed.kind === 'filled'
      ? 'sim_only'
      : replayed.kind === 'miss'
        ? 'both_unfilled'
        : 'pending';
  return rowOf(order, 'entry', fidelity, undefined);
}

function rowsOf(market: MarketData, order: BrokerOrder, quoteFill: QuoteFill): readonly CostRow[] {
  if (order.fills.length === 0) return [unfilledEntryRow(market, order) ?? []].flat();
  return fillGroups(order.fills).map((group) => filledRow(market, order, group, quoteFill));
}

// Alpaca paper charges no fee while the model charges SEC, TAF and CAT, so on paper the
// comparison is slippage only; fees join it on live (#1884, 2026-10-01)
function comparedCost(
  cost: LegCost | undefined,
  mode: BrokerMode,
): { readonly realised: number; readonly modelled: number } {
  if (cost === undefined) return { realised: 0, modelled: 0 };
  const withFees = mode === 'live';
  return {
    realised: cost.realisedSlippageGbp + (withFees ? cost.realisedFeeGbp : 0),
    modelled: cost.modelledSlippageGbp + (withFees ? cost.modelledFeeGbp : 0),
  };
}

export function costVerdict(ratio: number | undefined): CostVerdict {
  if (ratio === undefined) return 'insufficient';
  return Math.abs(ratio - 1) <= COST_TOLERANCE ? 'pass' : 'fail';
}

function emptyCounts(): Record<Fidelity, number> {
  return {
    match: 0,
    bar_mismatch: 0,
    broker_only: 0,
    sim_only: 0,
    both_unfilled: 0,
    pending: 0,
  };
}

function sampleOf(
  offsetBps: CostSample['offsetBps'],
  rows: readonly CostRow[],
  mode: BrokerMode,
): CostSample {
  const counts = emptyCounts();
  let realisedGbp = 0;
  let modelledGbp = 0;
  for (const row of rows) {
    counts[row.fidelity] += 1;
    const compared = comparedCost(row.cost, mode);
    realisedGbp += compared.realised;
    modelledGbp += compared.modelled;
  }
  const ratio = modelledGbp > 0 ? realisedGbp / modelledGbp : undefined;
  return { offsetBps, counts, realisedGbp, modelledGbp, ratio, verdict: costVerdict(ratio) };
}

export function costFidelityReport(
  orders: readonly BrokerOrder[],
  market: MarketData,
  quoteFill: QuoteFill,
  mode: BrokerMode,
): CostFidelityReport {
  const rows = orders.flatMap((order) => rowsOf(market, order, quoteFill));
  const byOffset = new Map<CostSample['offsetBps'], CostRow[]>();
  for (const row of rows)
    byOffset.set(row.offsetBps, [...(byOffset.get(row.offsetBps) ?? []), row]);
  return {
    mode,
    rows,
    samples: [...byOffset].map(([offsetBps, sampleRows]) => sampleOf(offsetBps, sampleRows, mode)),
  };
}

function offsetLabel(offsetBps: CostSample['offsetBps']): string {
  if (offsetBps === null) return 'sleeve-set limit';
  return offsetBps === undefined ? 'entry not journalled' : `${offsetBps} bps offset`;
}

function gbp(value: number): string {
  return `£${value.toFixed(2)}`;
}

function basisLabel(mode: BrokerMode): string {
  return mode === 'live' ? 'slippage and fees' : 'slippage only';
}

function sampleLines(sample: CostSample, mode: BrokerMode): readonly string[] {
  const { counts } = sample;
  const ratio = sample.ratio === undefined ? 'n/a' : sample.ratio.toFixed(3);
  return [
    `${offsetLabel(sample.offsetBps)}: ${counts.match} legs scored, realised ${gbp(sample.realisedGbp)}, modelled ${gbp(sample.modelledGbp)}, ratio ${ratio}, ${sample.verdict.toUpperCase()} (±${COST_TOLERANCE * 100}%, ${basisLabel(mode)})`,
    `  fidelity: bar mismatch ${counts.bar_mismatch}, broker only ${counts.broker_only}, simulator only ${counts.sim_only}, both unfilled ${counts.both_unfilled}, pending ${counts.pending}`,
  ];
}

function rowLine(row: CostRow, mode: BrokerMode): string {
  const head = `${row.clientOrderId} ${row.leg} ${row.fidelity}`;
  const { cost } = row;
  if (cost === undefined) return head;
  const { realised, modelled } = comparedCost(cost, mode);
  const deltaBps = ((realised - modelled) / cost.notionalGbp) * 10_000;
  return `${head} realised ${gbp(cost.realisedSlippageGbp)} + fee ${gbp(cost.realisedFeeGbp)}, modelled ${gbp(cost.modelledSlippageGbp)} + fee ${gbp(cost.modelledFeeGbp)}, delta ${deltaBps.toFixed(1)} bps`;
}

export function formatCostFidelityReport(report: CostFidelityReport): string {
  if (report.rows.length === 0) return 'no broker orders in the window';
  return [
    ...report.samples.flatMap((sample) => sampleLines(sample, report.mode)),
    'per order leg:',
    ...report.rows.map((row) => rowLine(row, report.mode)),
  ].join('\n');
}
