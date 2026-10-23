import type {
  BookDay,
  BookSpec,
  CapitalYear,
  EntryApproval,
  EntryRequest,
  LossBudgetState,
  MarketData,
  SleeveDecision,
  SleeveSpec,
  V2Bar,
} from '../../../../contracts/index.js';
import { consumeApproval, LossBudget, V2RiskGate } from '../risk/index.js';
import type {
  SaxoBuySell,
  SaxoOpenApiClient,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo/saxo-client.js';
import { saxoWireReference } from './saxo/saxo-wire-reference.js';
import type { SaxoSimGateway } from './saxo-sim-gateway.js';
import type { CashEtfEvidence, GateCheck, InstrumentEvidence } from './sim-cfd-drill-evidence.js';
import {
  type DrillInstrument,
  findInstrument,
  instrumentRules,
  isOn,
  netPositions,
  quoteOf,
  type SimQuote,
} from './sim-cfd-drill-reads.js';

export type CashEtfBroker = Pick<
  SaxoOpenApiClient,
  'getInstrumentDetails' | 'placeOrder' | 'listOrderActivities'
>;

export interface CashEtfLeg {
  readonly gateway: SaxoSimGateway;
  readonly broker: CashEtfBroker;
  readonly runId: string;
  readonly fillTimeoutMs: number;
  readonly now: () => Date;
  readonly note: (code: string, detail?: unknown) => void;
  readonly poll: <T>(
    timeoutMs: number,
    probe: () => Promise<T | undefined>,
  ) => Promise<T | undefined>;
  readonly fail: (reason: string) => never;
}

interface Prepared {
  readonly cash: CashEtfEvidence;
  readonly instrument: DrillInstrument;
  readonly quote: SimQuote;
  readonly priceToContractFactor: number;
}

const DRILL_SHARES = 1;
const MS_PER_DAY = 86_400_000;
const FINAL_FILLS = new Set(['FinalFill', 'Filled']);

// The SIM quote is 15 minutes delayed (doc 44), so a strict bid/ask bound would fail a sound
// fill; the band still catches a fill read back 100x off the quoted unit (doc 44 §2.1a)
export const FILL_PRICE_BAND = 0.05;

// Drill-only sizing inputs, not a capital setting (D8): they only have to let an unbreached book
// approve a few shares of an LSE ETF so the pair isolates the loss-budget halt
const DRILL_CAPITAL = { startCapitalGbp: 10_000, lossCapGbp: 1_500 } as const;
const DRILL_ATR_FRACTION = 0.02;
const DRILL_ADV_SHARES = 1_000_000;
const DRILL_BOOK: BookSpec = {
  id: 'sim-cash-etf-drill/primary',
  sleeve: 'sim-cash-etf-drill',
  variant: 'primary',
  instantiated: true,
};
const DRILL_SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: false,
  sizing: {
    riskFraction: 0.005,
    stopAtrMultiple: 2,
    targetAtrMultiple: 3,
    timeStopTradingDays: 10,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [],
};

function tidmOf(symbol: string): string {
  return symbol.split(':')[0] ?? symbol;
}

function skip(leg: CashEtfLeg, record: InstrumentEvidence, reason: string): undefined {
  record.outcome = 'skipped';
  record.reason = reason;
  leg.note('drill_instrument_skipped', { symbol: record.symbol, reason });
  return undefined;
}

async function checkComplex(
  leg: CashEtfLeg,
  record: InstrumentEvidence,
  cash: CashEtfEvidence,
  instrument: DrillInstrument,
): Promise<boolean> {
  const flags = await instrumentRules(leg.gateway, instrument);
  cash.isComplex = flags.isComplex;
  leg.note('drill_cash_etf_complex_read', { symbol: record.symbol, isComplex: flags.isComplex });
  if (flags.isComplex !== false) leg.fail('cash_etf_complex');
  if (!flags.supportedOrderTypes.includes('Market')) leg.fail('market_order_unsupported');
  return flags.isTradable;
}

async function gbpFactor(leg: CashEtfLeg, cash: CashEtfEvidence, uic: number): Promise<number> {
  const details = await leg.broker.getInstrumentDetails(uic, 'Etf');
  cash.priceToContractFactor = details.PriceToContractFactor;
  cash.priceCurrency = details.PriceCurrency;
  if (details.CurrencyCode !== 'GBP') leg.fail('cash_etf_not_gbp');
  return details.PriceToContractFactor;
}

async function prepare(leg: CashEtfLeg, record: InstrumentEvidence): Promise<Prepared | undefined> {
  const instrument = await findInstrument(leg.gateway, record.symbol, 'Etf');
  if (instrument === undefined) return skip(leg, record, 'instrument_not_found');
  record.uic = instrument.uic;
  const cash: CashEtfEvidence = { fillPriceBand: FILL_PRICE_BAND };
  record.cash = cash;
  if (!(await checkComplex(leg, record, cash, instrument))) {
    return skip(leg, record, 'instrument_not_tradable');
  }
  const priceToContractFactor = await gbpFactor(leg, cash, instrument.uic);
  const quote = await quoteOf(leg.gateway, instrument);
  record.quote = quote;
  if (!quote.isMarketOpen) return skip(leg, record, 'market_closed');
  if (!(quote.bid > 0 && quote.ask >= quote.bid)) leg.fail('quote_unusable');
  return { cash, instrument, quote, priceToContractFactor };
}

function drillBars(tradingDate: string, closeGbp: number): V2Bar[] {
  const window = DRILL_SPEC.sizing.advWindowBars;
  return Array.from({ length: window }, (_, index) => ({
    date: new Date(Date.parse(tradingDate) + (index - window) * MS_PER_DAY)
      .toISOString()
      .slice(0, 10),
    open: closeGbp,
    high: closeGbp,
    low: closeGbp,
    close: closeGbp,
    volume: DRILL_ADV_SHARES,
    rawClose: closeGbp,
  }));
}

function drillMarket(tradingDate: string, closeGbp: number): MarketData {
  const bars = drillBars(tradingDate, closeGbp);
  return {
    lastBarBefore: () => bars.at(-1),
    barsBefore: (_instrument, _date, count) => bars.slice(-count),
    // The LSE venue quotes in GBP, so the gate never converts through this rate
    gbpUsdAtYearStart: () => Number.NaN,
    gbpUsdYearStartFixDate: (year) => `${year - 1}-12-31`,
  };
}

function bookDay(tradingDate: string, state: LossBudgetState): BookDay {
  const equityGbp = state.referenceEquityGbp - state.ytdLossGbp;
  return {
    bookId: DRILL_BOOK.id,
    tradingDate,
    equityGbp,
    cashGbp: equityGbp,
    investedGbp: 0,
    custodyAccrualGbp: 0,
    cfdFinancingAccrualGbp: 0,
    cfdBorrowAccrualGbp: 0,
    recordedAt: `${tradingDate}T00:00:00.000Z`,
    state,
  };
}

function markedBook(capital: CapitalYear, equityGbp: number): LossBudgetState {
  return new LossBudget(capital.startCapitalGbp).markClose(equityGbp, equityGbp, capital);
}

function approve(request: EntryRequest, capital: CapitalYear, state: LossBudgetState) {
  return new V2RiskGate({
    books: { lastDay: () => bookDay(request.tradingDate, state) },
    capital: { inForce: () => capital },
    cfdSleeveIds: [],
    market: drillMarket(request.tradingDate, request.decision.price),
    spec: () => DRILL_SPEC,
  }).approveEntry(request);
}

function entryRequest(leg: CashEtfLeg, record: InstrumentEvidence, prepared: Prepared) {
  // LSE continuous trading sits inside one UTC day, so the UTC date is the London one
  const tradingDate = leg.now().toISOString().slice(0, 10);
  const priceGbp = prepared.quote.ask * prepared.priceToContractFactor;
  const atr = priceGbp * DRILL_ATR_FRACTION;
  const decision: SleeveDecision = {
    sleeve_id: DRILL_BOOK.sleeve,
    instrument: tidmOf(record.symbol),
    venue: 'saxo',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'SIM cash ETF drill (#1400 AC3, AC6)',
    price: priceGbp,
    atr,
    stop_price: priceGbp - DRILL_SPEC.sizing.stopAtrMultiple * atr,
    inputs_hash: `sim-cash-etf-drill-${leg.runId}`,
    debate_id: undefined,
    payload: {},
  };
  const request: EntryRequest = {
    book: DRILL_BOOK,
    decision,
    clientOrderId: `drill-${leg.runId}-${prepared.instrument.uic}`,
    tradingDate,
    equityGbp: DRILL_CAPITAL.startCapitalGbp,
    macroDay: false,
  };
  const year = Number(tradingDate.slice(0, 4));
  const capital: CapitalYear = { year, effectiveFrom: `${year}-01-01`, ...DRILL_CAPITAL };
  return { request, capital };
}

function gateCheck(approval: EntryApproval, book: LossBudgetState): GateCheck {
  return {
    size: approval.size,
    refusal: approval.order === undefined ? approval.refusal : undefined,
    book,
  };
}

interface CountedBroker {
  readonly broker: CashEtfBroker;
  readonly placed: () => number;
}

export function countPlacements(inner: CashEtfBroker): CountedBroker {
  let placed = 0;
  return {
    placed: () => placed,
    broker: {
      getInstrumentDetails: (uic, assetType) => inner.getInstrumentDetails(uic, assetType),
      listOrderActivities: (from) => inner.listOrderActivities(from),
      placeOrder: (request, requestId) => {
        placed += 1;
        return inner.placeOrder(request, requestId);
      },
    },
  };
}

interface Sent {
  readonly request: SaxoOrderRequest;
  readonly placement: SaxoOrderPlacement;
  readonly since: Date;
}

async function breachedCheck(
  leg: CashEtfLeg,
  counted: CountedBroker,
  submit: () => Promise<Sent | undefined>,
): Promise<{ sent: Sent | undefined; trades: number; activities: number }> {
  const since = new Date(leg.now().getTime() - 60_000);
  const trades = () => leg.gateway.tradeRequests + counted.placed();
  const tradesBefore = trades();
  const rowsBefore = (await counted.broker.listOrderActivities(since)).length;
  const sent = await submit();
  const rowsAfter = (await counted.broker.listOrderActivities(since)).length;
  return { sent, trades: trades() - tradesBefore, activities: rowsAfter - rowsBefore };
}

// Both books go through this one path, so the breached proof counts the path that places the
// control's order; the drill sends one share of what the gate sized
async function submitApproved(
  leg: CashEtfLeg,
  prepared: Prepared,
  broker: CashEtfBroker,
  request: EntryRequest,
  approval: EntryApproval,
): Promise<Sent | undefined> {
  const order = approval.order;
  if (order === undefined) return undefined;
  const matches =
    order.kind === 'bracket_entry' &&
    order.side === 'buy' &&
    order.instrument === request.decision.instrument &&
    order.size >= DRILL_SHARES;
  if (!matches || !consumeApproval(order)) leg.fail('cash_etf_control_refused');
  return send(leg, prepared, { broker, side: 'Buy', clientOrderId: order.clientOrderId });
}

async function gatePair(
  leg: CashEtfLeg,
  prepared: Prepared,
  counted: CountedBroker,
  entry: { request: EntryRequest; capital: CapitalYear },
): Promise<Sent> {
  const { request, capital } = entry;
  const unbreached = markedBook(capital, capital.startCapitalGbp);
  const breached = markedBook(capital, capital.startCapitalGbp - capital.lossCapGbp - 1);
  const control = approve(request, capital, unbreached);
  const refusal = approve(request, capital, breached);
  const refused = await breachedCheck(leg, counted, () =>
    submitApproved(leg, prepared, counted.broker, request, refusal),
  );
  const gate = {
    tradingDate: request.tradingDate,
    control: gateCheck(control, unbreached),
    breached: gateCheck(refusal, breached),
    tradeRequestsDuringBreach: refused.trades,
    newActivitiesDuringBreach: refused.activities,
  };
  prepared.cash.gate = gate;
  leg.note('drill_cash_etf_gate_pair', { symbol: request.decision.instrument, ...gate });
  if (refused.sent !== undefined || refused.trades + refused.activities !== 0)
    leg.fail('cash_etf_breach_sent_request');
  if (refusal.order !== undefined || refusal.refusal !== 'zero_size' || !breached.halted)
    leg.fail('cash_etf_breach_not_refused');
  const sent = await submitApproved(leg, prepared, counted.broker, request, control);
  return sent ?? leg.fail('cash_etf_control_refused');
}

function marketOrder(prepared: Prepared, side: SaxoBuySell, reference: string): SaxoOrderRequest {
  return {
    Uic: prepared.instrument.uic,
    AssetType: 'Etf',
    BuySell: side,
    Amount: DRILL_SHARES,
    OrderType: 'Market',
    OrderDuration: { DurationType: 'DayOrder' },
    ManualOrder: false,
    ExternalReference: reference,
  };
}

async function place(
  leg: CashEtfLeg,
  broker: CashEtfBroker,
  request: SaxoOrderRequest,
  rejected: string,
): Promise<SaxoOrderPlacement> {
  try {
    const placement = await broker.placeOrder(request, request.ExternalReference);
    leg.note('drill_cash_etf_order_placed', { request, placement });
    return placement;
  } catch (error) {
    leg.note(rejected, error instanceof Error ? error.message : String(error));
    return leg.fail(rejected);
  }
}

function withinBand(price: number | undefined, quote: SimQuote): boolean {
  const mid = (quote.bid + quote.ask) / 2;
  return price !== undefined && Math.abs(price / mid - 1) <= FILL_PRICE_BAND;
}

export function fillMismatches(
  fill: SaxoOrderActivity,
  order: SaxoOrderRequest,
  quote: SimQuote,
): string[] {
  const checks: readonly (readonly [string, boolean])[] = [
    ['uic', fill.Uic === order.Uic],
    ['asset_type', fill.AssetType === order.AssetType],
    ['side', fill.BuySell === order.BuySell],
    ['amount', fill.Amount === order.Amount],
    ['fill_amount', fill.FillAmount === fill.Amount],
    ['price', withinBand(fill.AveragePrice ?? fill.Price, quote)],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

async function readFill(
  leg: CashEtfLeg,
  cash: CashEtfEvidence,
  broker: CashEtfBroker,
  placement: { readonly orderId: string; readonly reference: string; readonly since: Date },
): Promise<SaxoOrderActivity> {
  const ours = (row: SaxoOrderActivity) => row.OrderId === placement.orderId;
  const fill = await leg.poll(leg.fillTimeoutMs, async () =>
    (await broker.listOrderActivities(placement.since)).find(
      (row) =>
        ours(row) && row.ExternalReference === placement.reference && FINAL_FILLS.has(row.Status),
    ),
  );
  if (fill !== undefined) return fill;
  const seen = (await broker.listOrderActivities(placement.since)).filter(ours);
  cash.unmatchedActivities = seen;
  return leg.fail(seen.length > 0 ? 'cash_etf_fill_unmatched' : 'cash_etf_fill_not_read');
}

async function send(
  leg: CashEtfLeg,
  prepared: Prepared,
  ticket: { broker: CashEtfBroker; side: SaxoBuySell; clientOrderId: string },
): Promise<Sent> {
  const request = marketOrder(prepared, ticket.side, saxoWireReference(ticket.clientOrderId));
  const since = new Date(leg.now().getTime() - 60_000);
  const placement = await place(
    leg,
    ticket.broker,
    request,
    `cash_etf_${ticket.side.toLowerCase()}_rejected`,
  );
  return { request, placement, since };
}

async function settle(
  leg: CashEtfLeg,
  record: InstrumentEvidence,
  prepared: Prepared,
  ticket: { broker: CashEtfBroker; sent: Sent },
): Promise<SaxoOrderActivity> {
  const { request, placement, since } = ticket.sent;
  const fill = await readFill(leg, prepared.cash, ticket.broker, {
    orderId: placement.OrderId,
    reference: request.ExternalReference,
    since,
  });
  leg.note('drill_cash_etf_filled', { symbol: record.symbol, fill });
  const mismatches = fillMismatches(fill, request, prepared.quote);
  if (mismatches.length > 0) leg.fail(`cash_etf_fill_mismatch(${mismatches.join(',')})`);
  return fill;
}

async function awaitHolding(
  leg: CashEtfLeg,
  instrument: DrillInstrument,
  amount: number,
  missing: string,
): Promise<void> {
  const held = await leg.poll(leg.fillTimeoutMs, async () => {
    const rows = (await netPositions(leg.gateway)).filter(isOn(instrument));
    return rows.reduce((total, row) => total + row.amount, 0) === amount ? true : undefined;
  });
  if (held === undefined) leg.fail(missing);
}

async function settleThenFlatten(
  leg: CashEtfLeg,
  record: InstrumentEvidence,
  prepared: Prepared,
  ticket: { broker: CashEtfBroker; placedAt: string; sent: Sent; clientOrderId: string },
): Promise<void> {
  const { cash } = prepared;
  const entry = await settle(leg, record, prepared, ticket);
  cash.entryFill = entry;
  record.entry = {
    orderId: entry.OrderId,
    externalReference: entry.ExternalReference ?? '',
    placedAt: ticket.placedAt,
    relatedOrderIds: [],
    fillPrice: entry.AveragePrice ?? entry.Price,
    filledAt: entry.ActivityTime,
  };
  await awaitHolding(leg, prepared.instrument, DRILL_SHARES, 'cash_etf_position_not_held');
  const exit = await send(leg, prepared, {
    broker: ticket.broker,
    side: 'Sell',
    clientOrderId: `${ticket.clientOrderId}:flat`,
  });
  cash.exitFill = await settle(leg, record, prepared, { broker: ticket.broker, sent: exit });
  await awaitHolding(leg, prepared.instrument, 0, 'drill_position_not_closed');
}

export async function drillCashEtf(leg: CashEtfLeg, record: InstrumentEvidence): Promise<void> {
  record.outcome = 'failed';
  const prepared = await prepare(leg, record);
  if (prepared === undefined) return;
  const counted = countPlacements(leg.broker);
  const entry = entryRequest(leg, record, prepared);
  record.amount = DRILL_SHARES;
  const placedAt = leg.now().toISOString();
  const sent = await gatePair(leg, prepared, counted, entry);
  await settleThenFlatten(leg, record, prepared, {
    broker: counted.broker,
    placedAt,
    sent,
    clientOrderId: entry.request.clientOrderId,
  });
  record.outcome = 'passed';
  leg.note('drill_instrument_passed', { symbol: record.symbol, leg: 'cash-etf' });
}
