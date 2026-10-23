import { SAXO_SIM_GATEWAY, type SaxoSimGateway } from './saxo-sim-gateway.js';
import { type CashEtfBroker, type CashEtfLeg, drillCashEtf } from './sim-cash-etf-drill.js';
import {
  type AccountFlatness,
  type DrillEvidence,
  type DrillExit,
  type DrillMode,
  type DrillSide,
  type DrivenLeg,
  drillPassed,
  type InstrumentEvidence,
  isFlat,
} from './sim-cfd-drill-evidence.js';
import {
  type DrillAssetType,
  type DrillInstrument,
  findInstrument,
  type InstrumentRules,
  instrumentRules,
  isOn,
  netPositions,
  type OpenOrder,
  type OrderActivity,
  openOrders,
  orderActivities,
  quoteOf,
  type SimAccount,
  type SimQuote,
  trialAccount,
} from './sim-cfd-drill-reads.js';

export interface DrillTarget {
  readonly symbol: string;
  readonly assetType: DrillAssetType;
  readonly side?: DrillSide;
}

export const DEFAULT_STOCK_SHORT: DrillTarget = { symbol: 'AAPL:xnas', assetType: 'CfdOnStock' };
export const DEFAULT_ETF_SHORT: DrillTarget = { symbol: 'ISF:xlon', assetType: 'CfdOnEtf' };
// The only drill of a Sell stop resting under a CFD long; without it `CFD_RESTING_STOP_VERIFIED`
// rests on short-only evidence for UK single-stock longs (#1914 comment 6179140977)
export const DEFAULT_UK_LONG: DrillTarget = {
  symbol: 'RR:xlon',
  assetType: 'CfdOnStock',
  side: 'long',
};

function isLong(record: { readonly side?: DrillSide }): boolean {
  return record.side === 'long';
}

export interface DrillOptions {
  readonly targets: readonly DrillTarget[];
  readonly runId: string;
  readonly restDistance: number;
  readonly crossDistance: number;
  readonly nearDistance: number;
  readonly pollIntervalMs: number;
  readonly fillTimeoutMs: number;
  readonly triggerTimeoutMs: number;
  readonly ratchetIntervalMs: number;
  readonly exit: DrillExit;
  readonly phase: DrillPhase;
}

export type DrillPhase = 'full' | 'place';

export const DEFAULT_DRILL_OPTIONS: Omit<DrillOptions, 'targets' | 'runId'> = {
  restDistance: 0.1,
  crossDistance: 0.005,
  nearDistance: 0.0005,
  pollIntervalMs: 2_000,
  fillTimeoutMs: 60_000,
  triggerTimeoutMs: 600_000,
  ratchetIntervalMs: 30_000,
  exit: 'stop',
  phase: 'full',
};

export interface DrillClock {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

interface Drill {
  readonly gateway: SaxoSimGateway;
  readonly options: DrillOptions;
  readonly clock: DrillClock;
  readonly evidence: DrillEvidence;
  readonly account: SimAccount;
  readonly interrupt: AbortSignal;
  readonly cashBroker?: ((account: SimAccount) => CashEtfBroker) | undefined;
}

const FILLED_STATUSES = new Set(['FinalFill', 'Filled']);

class DrillFailure extends Error {}

function stamp(drill: Pick<Drill, 'clock'>): string {
  return drill.clock.now().toISOString();
}

function note(drill: Pick<Drill, 'clock' | 'evidence'>, code: string, detail?: unknown): void {
  drill.evidence.steps.push({
    at: stamp(drill),
    code,
    ...(detail === undefined ? {} : { detail }),
  });
}

function stopIfInterrupted(drill: Pick<Drill, 'interrupt'>): void {
  if (drill.interrupt.aborted) throw new DrillFailure('drill_interrupted');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function poll<T>(
  drill: Drill,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = drill.clock.now().getTime() + timeoutMs;
  for (;;) {
    stopIfInterrupted(drill);
    const found = await probe();
    if (found !== undefined || drill.clock.now().getTime() >= deadline) return found;
    await drill.clock.sleep(drill.options.pollIntervalMs);
  }
}

function toTick(price: number, tick: number, direction: 'up' | 'down'): number {
  const steps =
    direction === 'up' ? Math.ceil(price / tick - 1e-9) : Math.floor(price / tick + 1e-9);
  return Number((steps * tick).toFixed(10));
}

async function flatness(gateway: SaxoSimGateway, at: string): Promise<AccountFlatness> {
  const [positions, orders] = await Promise.all([netPositions(gateway), openOrders(gateway)]);
  return {
    at,
    netPositions: positions.filter((position) => position.amount !== 0).length,
    openOrders: orders.length,
  };
}

function skip(record: InstrumentEvidence, reason: string): undefined {
  record.outcome = 'skipped';
  record.reason = reason;
  return undefined;
}

function fail(record: InstrumentEvidence, reason: string): never {
  record.reason = reason;
  throw new DrillFailure(`${reason}: ${record.symbol}`);
}

const REQUIRED_ORDER_TYPES = ['Market', 'StopIfTraded'];

async function tradableRules(
  drill: Drill,
  record: InstrumentEvidence,
  instrument: DrillInstrument,
): Promise<InstrumentRules | undefined> {
  const rules = await instrumentRules(drill.gateway, instrument);
  record.supportedOrderTypes = rules.supportedOrderTypes;
  record.orderDistances = rules.orderDistances;
  if (!rules.isTradable) return skip(record, 'instrument_not_tradable');
  if (!REQUIRED_ORDER_TYPES.every((type) => rules.supportedOrderTypes.includes(type))) {
    fail(record, 'stop_if_traded_unsupported');
  }
  return rules;
}

async function openQuote(
  drill: Drill,
  record: InstrumentEvidence,
  instrument: DrillInstrument,
): Promise<SimQuote | undefined> {
  const quote = await quoteOf(drill.gateway, instrument);
  record.quote = quote;
  if (!quote.isMarketOpen) return skip(record, 'market_closed');
  if (!isLong(record) && quote.shortTradeDisabled) return skip(record, 'short_disabled');
  if (!(quote.bid > 0 && quote.ask >= quote.bid)) fail(record, 'quote_unusable');
  return quote;
}

async function prepare(
  drill: Drill,
  record: InstrumentEvidence,
): Promise<{ instrument: DrillInstrument; rules: InstrumentRules; quote: SimQuote } | undefined> {
  const instrument = await findInstrument(drill.gateway, record.symbol, record.assetType);
  if (instrument === undefined) return skip(record, 'instrument_not_found');
  record.uic = instrument.uic;
  const rules = await tradableRules(drill, record, instrument);
  const quote = rules === undefined ? undefined : await openQuote(drill, record, instrument);
  return rules === undefined || quote === undefined ? undefined : { instrument, rules, quote };
}

export function entryWithStop(
  side: DrillSide,
  account: SimAccount,
  instrument: DrillInstrument,
  amount: number,
  prices: { stop: number; target: number },
  reference: string,
): Record<string, unknown> {
  const exitSide = side === 'long' ? 'Sell' : 'Buy';
  const leg = (OrderType: 'StopIfTraded' | 'Limit', OrderPrice: number, suffix: string) => ({
    Uic: instrument.uic,
    AssetType: instrument.assetType,
    BuySell: exitSide,
    Amount: amount,
    OrderType,
    OrderPrice,
    OrderDuration: { DurationType: 'GoodTillCancel' },
    ManualOrder: false,
    ExternalReference: `${reference}:${suffix}`,
  });
  return {
    AccountKey: account.accountKey,
    Uic: instrument.uic,
    AssetType: instrument.assetType,
    BuySell: side === 'long' ? 'Buy' : 'Sell',
    Amount: amount,
    OrderType: 'Market',
    OrderDuration: { DurationType: 'DayOrder' },
    ManualOrder: false,
    ExternalReference: reference,
    Orders: [leg('StopIfTraded', prices.stop, 'stop'), leg('Limit', prices.target, 'target')],
  };
}

function placementIds(body: unknown): { orderId: string; related: string[] } {
  const row = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const related = Array.isArray(row.Orders) ? row.Orders : [];
  return {
    orderId: typeof row.OrderId === 'string' ? row.OrderId : '',
    related: related.map((order) => String((order as Record<string, unknown>)?.OrderId ?? '')),
  };
}

async function placeEntry(
  drill: Drill,
  record: InstrumentEvidence,
  prepared: { instrument: DrillInstrument; rules: InstrumentRules; quote: SimQuote },
): Promise<void> {
  const { instrument, rules, quote } = prepared;
  const amount = rules.minimumAmount;
  const above = toTick(
    quote.ask * (1 + drill.options.restDistance),
    rules.tickSize(quote.ask),
    'up',
  );
  const below = toTick(
    quote.bid * (1 - drill.options.restDistance),
    rules.tickSize(quote.bid),
    'down',
  );
  const [stop, target] = isLong(record) ? [below, above] : [above, below];
  const reference = `drill-${drill.options.runId}-${instrument.uic}`;
  record.amount = amount;
  record.stop = { placedPrice: stop };
  record.targetPrice = target;
  const payload = entryWithStop(
    record.side ?? 'short',
    drill.account,
    instrument,
    amount,
    { stop, target },
    reference,
  );
  const reply = await drill.gateway.send('POST', '/trade/v2/orders', payload);
  note(drill, 'drill_entry_placed', {
    symbol: record.symbol,
    status: reply.status,
    body: reply.body,
  });
  const ids = placementIds(reply.body);
  if (reply.status !== 200 || ids.orderId === '') fail(record, 'drill_entry_rejected');
  record.entry = {
    orderId: ids.orderId,
    externalReference: reference,
    placedAt: stamp(drill),
    relatedOrderIds: ids.related,
  };
}

async function awaitFill(drill: Drill, record: InstrumentEvidence, instrument: DrillInstrument) {
  const held = (record.amount ?? 0) * (isLong(record) ? 1 : -1);
  const position = await poll(drill, drill.options.fillTimeoutMs, async () =>
    (await netPositions(drill.gateway)).find((row) => isOn(instrument)(row) && row.amount === held),
  );
  if (position === undefined || record.entry === undefined) fail(record, 'drill_entry_not_filled');
  record.entry.fillPrice = position.averageOpenPrice;
  record.entry.filledAt = stamp(drill);
  note(drill, 'drill_entry_filled', { symbol: record.symbol, price: position.averageOpenPrice });
}

async function verifyRest(
  drill: Drill,
  record: InstrumentEvidence,
  prepared: { instrument: DrillInstrument; rules: InstrumentRules },
): Promise<void> {
  const stop = record.stop;
  const row = await poll(drill, drill.options.fillTimeoutMs, async () =>
    (await openOrders(drill.gateway)).find(
      (order) =>
        isOn(prepared.instrument)(order) &&
        order.openOrderType === 'StopIfTraded' &&
        order.status === 'Working',
    ),
  );
  if (row === undefined || stop === undefined) fail(record, 'drill_stop_not_resting');
  stop.orderId = row.orderId;
  stop.rest = { ...row, observedAt: stamp(drill) };
  note(drill, 'drill_stop_resting', { symbol: record.symbol, order: row });
  const halfTick = prepared.rules.tickSize(stop.placedPrice) / 2;
  const matches =
    row.buySell === (isLong(record) ? 'Sell' : 'Buy') &&
    row.amount === record.amount &&
    Math.abs((row.price ?? Number.NaN) - stop.placedPrice) <= halfTick;
  if (!matches) fail(record, 'drill_stop_mismatch');
}

function restingTarget(
  orders: readonly OpenOrder[],
  instrument: DrillInstrument,
  record: InstrumentEvidence,
): OpenOrder | undefined {
  return orders.find(
    (order) =>
      isOn(instrument)(order) &&
      order.openOrderType === 'Limit' &&
      (record.entry?.relatedOrderIds ?? []).includes(order.orderId),
  );
}

async function noteTarget(
  drill: Drill,
  record: InstrumentEvidence,
  instrument: DrillInstrument,
): Promise<void> {
  const row = restingTarget(await openOrders(drill.gateway), instrument, record);
  if (row === undefined) {
    if (drill.options.exit === 'target') fail(record, 'drill_target_not_resting');
    return;
  }
  record.target = { orderId: row.orderId, rest: { ...row, observedAt: stamp(drill) } };
}

type DrivenType = 'StopIfTraded' | 'Limit';

interface Drive {
  readonly kind: DrillExit;
  readonly leg: DrivenLeg;
  readonly orderId: string;
  readonly orderType: DrivenType;
  readonly restSign: 1 | -1;
}

function driveFor(drill: Drill, record: InstrumentEvidence): Drive {
  const stopSign = isLong(record) ? -1 : 1;
  const leg = drill.options.exit === 'target' ? record.target : record.stop;
  if (leg?.orderId === undefined) fail(record, 'drill_exit_order_unknown');
  return drill.options.exit === 'target'
    ? {
        kind: 'target',
        leg,
        orderId: leg.orderId,
        orderType: 'Limit',
        restSign: stopSign === 1 ? -1 : 1,
      }
    : { kind: 'stop', leg, orderId: leg.orderId, orderType: 'StopIfTraded', restSign: stopSign };
}

function amendPayload(
  drill: Drill,
  record: InstrumentEvidence,
  drive: Drive,
  price: number,
): Record<string, unknown> {
  return {
    AccountKey: drill.account.accountKey,
    OrderId: drive.orderId,
    AssetType: record.assetType,
    OrderType: drive.orderType,
    OrderPrice: price,
    Amount: record.amount,
    OrderDuration: { DurationType: 'GoodTillCancel' },
  };
}

async function amendOnce(
  drill: Drill,
  record: InstrumentEvidence,
  drive: Drive,
  price: number,
): Promise<number> {
  const reply = await drill.gateway.send(
    'PATCH',
    '/trade/v2/orders',
    amendPayload(drill, record, drive, price),
  );
  drive.leg.amendAttempts?.push({ price, status: reply.status, body: reply.body });
  note(drill, `drill_${drive.kind}_amended`, {
    symbol: record.symbol,
    price,
    status: reply.status,
  });
  return reply.status;
}

// A crossing amend was refused as OnWrongSideOfMarket on SIM (2026-10-09 record), so one tick
// outside the fresh quote is the candidate that rests and triggers on the next tick against the position
function triggerCandidates(
  options: DrillOptions,
  record: InstrumentEvidence,
  fill: number,
  rules: InstrumentRules,
  quote: SimQuote,
): number[] {
  const tick = rules.tickSize(fill);
  const fallback = rules.defaultStopLossFraction;
  const long = isLong(record);
  const away = long ? -1 : 1;
  const towardStop = long ? 'down' : 'up';
  const touch = long ? quote.bid : quote.ask;
  return [
    toTick(fill * (1 - away * options.crossDistance), tick, long ? 'up' : 'down'),
    toTick(fill * (1 + away * options.nearDistance), tick, towardStop),
    toTick(touch + away * rules.tickSize(touch), rules.tickSize(touch), towardStop),
    ...(fallback === undefined ? [] : [toTick(fill * (1 + away * fallback), tick, towardStop)]),
  ];
}

function crossingTick(restSign: 1 | -1): 'up' | 'down' {
  return restSign > 0 ? 'down' : 'up';
}

async function firstCandidates(
  drill: Drill,
  record: InstrumentEvidence,
  prepared: { instrument: DrillInstrument; rules: InstrumentRules },
  drive: Drive,
  fill: number,
): Promise<number[]> {
  if (drive.kind === 'stop') {
    const quote = await quoteOf(drill.gateway, prepared.instrument);
    return triggerCandidates(drill.options, record, fill, prepared.rules, quote);
  }
  const crossing = fill * (1 - drive.restSign * drill.options.crossDistance);
  return [toTick(crossing, prepared.rules.tickSize(fill), crossingTick(drive.restSign))];
}

async function amendToCross(
  drill: Drill,
  record: InstrumentEvidence,
  prepared: { instrument: DrillInstrument; rules: InstrumentRules },
  drive: Drive,
): Promise<void> {
  const fill = record.entry?.fillPrice;
  if (fill === undefined) fail(record, 'drill_fill_price_unknown');
  const candidates = await firstCandidates(drill, record, prepared, drive, fill);
  drive.leg.amendAttempts = [];
  for (const price of candidates) {
    if ((await amendOnce(drill, record, drive, price)) === 200) return;
  }
  if (drive.kind === 'target' && drive.leg.rest?.price !== undefined) return;
  fail(record, `drill_${drive.kind}_amend_rejected`);
}

export interface RatchetBounds {
  readonly accepted: number;
  readonly rejected?: number | undefined;
  readonly stride: number;
}

function onCrossingSide(price: number, accepted: number, restSign: 1 | -1): boolean {
  return (price - accepted) * restSign < 0;
}

export function boundsFrom(
  attempts: readonly { price: number; status: number }[],
  restSign: 1 | -1,
  resting = Number.NaN,
): RatchetBounds {
  const accepted = attempts.findLast((attempt) => attempt.status === 200)?.price ?? resting;
  const crossing = attempts
    .filter(
      (attempt) => attempt.status === 400 && onCrossingSide(attempt.price, accepted, restSign),
    )
    .map((attempt) => attempt.price)
    .sort((a, b) => (b - a) * restSign);
  return { accepted, rejected: crossing[0], stride: 0 };
}

// Saxo's accept or OnWrongSideOfMarket reply locates the live market; the SIM quote is
// 15 minutes delayed and cannot
export function nextRatchetPrice(
  bounds: RatchetBounds,
  tick: number,
  restSign: 1 | -1,
  stepSize: number,
): { price: number; bounds: RatchetBounds } {
  const { accepted, rejected } = bounds;
  if (rejected !== undefined && Math.abs(accepted - rejected) > tick * 1.5) {
    const price = toTick((accepted + rejected) / 2, tick, restSign > 0 ? 'up' : 'down');
    return { price, bounds };
  }
  const reach = stepSize * 2 ** bounds.stride;
  const stepped = toTick(accepted - restSign * reach, tick, crossingTick(restSign));
  const price =
    stepped === accepted
      ? toTick(accepted - restSign * tick, tick, crossingTick(restSign))
      : stepped;
  return { price, bounds: { accepted, rejected: undefined, stride: bounds.stride + 1 } };
}

export function narrowed(bounds: RatchetBounds, price: number, status: number): RatchetBounds {
  if (status === 200) return { ...bounds, accepted: price };
  if (status === 400) return { ...bounds, rejected: price, stride: 0 };
  return bounds;
}

async function exitFill(
  drill: Drill,
  drive: Drive,
  since: Date,
): Promise<OrderActivity | undefined> {
  return (await orderActivities(drill.gateway, drill.account, since)).find(
    (activity) => activity.orderId === drive.orderId && FILLED_STATUSES.has(activity.status),
  );
}

function notFilledReason(drive: Drive): string {
  return drive.kind === 'stop' ? 'drill_stop_not_triggered' : 'drill_target_not_filled';
}

async function driveToFill(
  drill: Drill,
  record: InstrumentEvidence,
  rules: InstrumentRules,
  drive: Drive,
  since: Date,
): Promise<OrderActivity> {
  const deadline = drill.clock.now().getTime() + drill.options.triggerTimeoutMs;
  const fill = record.entry?.fillPrice ?? Number.NaN;
  const stepSize = fill * drill.options.nearDistance;
  let bounds = boundsFrom(drive.leg.amendAttempts ?? [], drive.restSign, drive.leg.rest?.price);
  for (;;) {
    const remaining = deadline - drill.clock.now().getTime();
    const window = Math.min(drill.options.ratchetIntervalMs, remaining);
    const filled = await poll(drill, window, () => exitFill(drill, drive, since));
    if (filled !== undefined) return filled;
    if (drill.clock.now().getTime() >= deadline) fail(record, notFilledReason(drive));
    const step = nextRatchetPrice(bounds, rules.tickSize(fill), drive.restSign, stepSize);
    bounds = narrowed(step.bounds, step.price, await amendOnce(drill, record, drive, step.price));
  }
}

function recordFill(record: InstrumentEvidence, drive: Drive, fill: OrderActivity): void {
  const leg = drive.kind === 'target' ? record.target : undefined;
  if (leg !== undefined) {
    leg.filledAt = fill.activityTime;
    leg.fillStatus = fill.status;
    leg.fillPrice = fill.averagePrice;
    return;
  }
  if (record.stop === undefined) return;
  record.stop.triggeredAt = fill.activityTime;
  record.stop.triggerStatus = fill.status;
  record.stop.triggerFillPrice = fill.averagePrice;
}

async function awaitFlatPosition(
  drill: Drill,
  record: InstrumentEvidence,
  instrument: DrillInstrument,
): Promise<void> {
  const open = await poll(drill, drill.options.fillTimeoutMs, async () => {
    const rows = (await netPositions(drill.gateway)).filter(isOn(instrument));
    return rows.every((row) => row.amount === 0) ? true : undefined;
  });
  record.positionClosedAfterTrigger = open === true;
  if (!record.positionClosedAfterTrigger) fail(record, 'drill_position_not_closed');
}

// Recorded, not required: a sibling Saxo leaves behind answers #2107 item 1 the other way,
// and cleanup still cancels it
async function checkSibling(
  drill: Drill,
  record: InstrumentEvidence,
  drive: Drive,
  since: Date,
): Promise<void> {
  const siblingId = (drive.kind === 'stop' ? record.target : record.stop)?.orderId;
  if (siblingId === undefined) return;
  const gone = await poll(drill, drill.options.fillTimeoutMs, async () =>
    (await openOrders(drill.gateway)).some((order) => order.orderId === siblingId)
      ? undefined
      : true,
  );
  const statuses = (await orderActivities(drill.gateway, drill.account, since))
    .filter((activity) => activity.orderId === siblingId)
    .map((activity) => activity.status);
  record.sibling = { orderId: siblingId, goneBeforeCleanup: gone === true, statuses };
  note(drill, 'drill_sibling_checked', { symbol: record.symbol, sibling: record.sibling });
}

async function exitThroughMarket(
  drill: Drill,
  record: InstrumentEvidence,
  prepared: { instrument: DrillInstrument; rules: InstrumentRules },
): Promise<void> {
  const drive = driveFor(drill, record);
  const since = new Date(Date.parse(record.entry?.placedAt ?? drill.evidence.startedAt) - 60_000);
  await amendToCross(drill, record, prepared, drive);
  const fill = await driveToFill(drill, record, prepared.rules, drive, since);
  recordFill(record, drive, fill);
  note(drill, drive.kind === 'stop' ? 'drill_stop_triggered' : 'drill_target_filled', {
    symbol: record.symbol,
    activity: fill,
  });
  await awaitFlatPosition(drill, record, prepared.instrument);
  await checkSibling(drill, record, drive, since);
}

function cashLegOf(drill: Drill, record: InstrumentEvidence): CashEtfLeg {
  if (drill.cashBroker === undefined) fail(record, 'cash_etf_broker_missing');
  return {
    gateway: drill.gateway,
    broker: drill.cashBroker(drill.account),
    runId: drill.options.runId,
    fillTimeoutMs: drill.options.fillTimeoutMs,
    now: drill.clock.now,
    note: (code, detail) => note(drill, code, detail),
    poll: (timeoutMs, probe) => poll(drill, timeoutMs, probe),
    fail: (reason) => fail(record, reason),
  };
}

async function drillInstrument(drill: Drill, target: DrillTarget): Promise<void> {
  stopIfInterrupted(drill);
  const record: InstrumentEvidence = { ...target, outcome: 'running' };
  drill.evidence.instruments.push(record);
  note(drill, 'drill_instrument_started', target);
  if (record.assetType === 'Etf') await drillCashEtf(cashLegOf(drill, record), record);
  else await drillCfd(drill, record);
}

async function drillCfd(drill: Drill, record: InstrumentEvidence): Promise<void> {
  const prepared = await prepare(drill, record);
  if (prepared === undefined) {
    note(drill, 'drill_instrument_skipped', { symbol: record.symbol, reason: record.reason });
    return;
  }
  record.outcome = 'failed';
  await placeEntry(drill, record, prepared);
  await awaitFill(drill, record, prepared.instrument);
  await verifyRest(drill, record, prepared);
  await noteTarget(drill, record, prepared.instrument);
  if (drill.options.phase === 'full') await exitThroughMarket(drill, record, prepared);
  record.outcome = 'passed';
  note(drill, 'drill_instrument_passed', { symbol: record.symbol, phase: drill.options.phase });
}

function touched(evidence: DrillEvidence): DrillInstrument[] {
  return evidence.instruments.flatMap((record) =>
    record.uic === undefined ? [] : [{ uic: record.uic, assetType: record.assetType }],
  );
}

async function attempt(drill: Drill, code: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    drill.evidence.cleanup.errors.push(`${code}: ${messageOf(error)}`);
    note(drill, code, messageOf(error));
  }
}

async function cancelLeftovers(
  drill: Drill,
  instruments: readonly DrillInstrument[],
): Promise<void> {
  const leftovers = (await openOrders(drill.gateway)).filter((order) =>
    instruments.some((instrument) => isOn(instrument)(order)),
  );
  for (const order of leftovers) {
    const reply = await drill.gateway.send(
      'DELETE',
      `/trade/v2/orders/${encodeURIComponent(order.orderId)}?AccountKey=${encodeURIComponent(drill.account.accountKey)}`,
    );
    if (reply.status === 200) drill.evidence.cleanup.cancelled.push(order.orderId);
    else if (reply.status !== 404) {
      drill.evidence.cleanup.errors.push(`drill_cancel_failed: ${order.orderId} ${reply.status}`);
    }
  }
}

async function flattenLeftovers(
  drill: Drill,
  instruments: readonly DrillInstrument[],
): Promise<void> {
  const open = (await netPositions(drill.gateway)).filter(
    (position) =>
      position.amount !== 0 && instruments.some((instrument) => isOn(instrument)(position)),
  );
  for (const position of open) {
    const reply = await drill.gateway.send('POST', '/trade/v2/orders', {
      AccountKey: drill.account.accountKey,
      Uic: position.uic,
      AssetType: position.assetType,
      BuySell: position.amount < 0 ? 'Buy' : 'Sell',
      Amount: Math.abs(position.amount),
      OrderType: 'Market',
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: `drill-${drill.options.runId}-flat-${position.uic}`,
    });
    const label = `${position.assetType}:${position.uic}`;
    if (reply.status === 200) drill.evidence.cleanup.flattened.push(label);
    else drill.evidence.cleanup.errors.push(`drill_flatten_failed: ${label} ${reply.status}`);
  }
}

async function awaitFlat(drill: Drill): Promise<void> {
  const flat = await poll(drill, drill.options.fillTimeoutMs, async () => {
    const reading = await flatness(drill.gateway, stamp(drill));
    return isFlat(reading) ? reading : undefined;
  });
  drill.evidence.flatAfter = flat ?? (await flatness(drill.gateway, stamp(drill)));
}

async function cleanUp(drill: Drill): Promise<void> {
  const instruments = touched(drill.evidence);
  note(drill, 'drill_cleanup_started', { instruments: instruments.length });
  await attempt(drill, 'drill_cancel_error', () => cancelLeftovers(drill, instruments));
  await attempt(drill, 'drill_flatten_error', () => flattenLeftovers(drill, instruments));
  await attempt(drill, 'drill_flat_check_error', () => awaitFlat(drill));
}

export function newEvidence(clock: DrillClock, mode: DrillMode = 'stop'): DrillEvidence {
  return {
    drill: 'sim-cfd-stop-drill',
    mode,
    refs: ['#1400', '#1916', '#1914', '#2107'],
    gateway: SAXO_SIM_GATEWAY,
    startedAt: clock.now().toISOString(),
    instruments: [],
    cleanup: { cancelled: [], flattened: [], errors: [] },
    steps: [],
    passed: false,
  };
}

function modeOf(options: Pick<DrillOptions, 'exit' | 'phase'>): DrillMode {
  return options.phase === 'place' ? 'kill-place' : options.exit;
}

async function drillEach(drill: Drill): Promise<void> {
  for (const target of drill.options.targets) {
    try {
      await drillInstrument(drill, target);
    } catch (error) {
      if (!(error instanceof DrillFailure) || drill.interrupt.aborted) throw error;
      drill.evidence.failure ??= error.message;
      note(drill, 'drill_instrument_failed', error.message);
    }
  }
}

function leftResting(drill: Drill): boolean {
  return drill.options.phase === 'place' && drillPassed(drill.evidence);
}

async function runDrill(drill: Drill): Promise<void> {
  try {
    drill.evidence.flatBefore = await flatness(drill.gateway, stamp(drill));
    if (!isFlat(drill.evidence.flatBefore)) throw new DrillFailure('drill_account_not_flat');
    await drillEach(drill);
  } catch (error) {
    drill.evidence.failure ??= messageOf(error);
    note(drill, 'drill_failed', drill.evidence.failure);
  } finally {
    if (isFlat(drill.evidence.flatBefore) && !leftResting(drill)) {
      await cleanUp({ ...drill, interrupt: new AbortController().signal });
    }
  }
}

async function onTrialAccount(
  gateway: SaxoSimGateway,
  clock: DrillClock,
  evidence: DrillEvidence,
  body: (account: SimAccount) => Promise<void>,
): Promise<SimAccount | undefined> {
  let account: SimAccount | undefined;
  try {
    account = await trialAccount(gateway);
    evidence.account = { isTrialAccount: true, currency: account.currency };
    note({ clock, evidence }, 'drill_trial_account_confirmed');
    await body(account);
  } catch (error) {
    evidence.failure = messageOf(error);
    note({ clock, evidence }, 'drill_refused', evidence.failure);
  }
  evidence.finishedAt = clock.now().toISOString();
  evidence.passed = drillPassed(evidence);
  return account;
}

export async function runSimCfdStopDrill(
  gateway: SaxoSimGateway,
  options: DrillOptions,
  clock: DrillClock,
  interrupt: AbortSignal = new AbortController().signal,
  cashBroker?: (account: SimAccount) => CashEtfBroker,
): Promise<{ evidence: DrillEvidence; account: SimAccount | undefined }> {
  const evidence = newEvidence(clock, modeOf(options));
  const account = await onTrialAccount(gateway, clock, evidence, (trial) =>
    runDrill({ gateway, options, clock, evidence, account: trial, interrupt, cashBroker }),
  );
  return { evidence, account };
}

function field(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[key]
    : undefined;
}

function placedRecord(row: unknown): InstrumentEvidence | undefined {
  const stop = field(row, 'stop');
  const orderId = field(stop, 'orderId');
  const price = field(field(stop, 'rest'), 'price');
  const uic = field(row, 'uic');
  if (typeof orderId !== 'string' || typeof price !== 'number' || typeof uic !== 'number') {
    return undefined;
  }
  return {
    symbol: String(field(row, 'symbol')),
    assetType: field(row, 'assetType') as InstrumentEvidence['assetType'],
    ...(field(row, 'side') === 'long' ? { side: 'long' as const } : {}),
    outcome: 'running',
    uic,
    amount: Number(field(row, 'amount')),
    stop: { placedPrice: price, orderId },
  };
}

export function placedInstruments(placed: unknown): InstrumentEvidence[] {
  if (field(placed, 'mode') !== 'kill-place' || field(placed, 'passed') !== true) {
    throw new Error('drill_resume_refused: not a passing kill-place record');
  }
  const rows = field(placed, 'instruments');
  const ran = (Array.isArray(rows) ? rows : []).filter((row) => field(row, 'outcome') === 'passed');
  const records = ran.map(placedRecord);
  if (records.length === 0 || records.some((record) => record === undefined)) {
    throw new Error('drill_resume_refused: a placed instrument carries no resting stop');
  }
  return records as InstrumentEvidence[];
}

function survived(record: InstrumentEvidence, orders: readonly OpenOrder[]): boolean {
  const row = orders.find((order) => order.orderId === record.stop?.orderId);
  return (
    row?.status === 'Working' &&
    row.price === record.stop?.placedPrice &&
    row.amount === record.amount
  );
}

async function checkSurvivors(drill: Drill): Promise<void> {
  stopIfInterrupted(drill);
  const orders = await openOrders(drill.gateway);
  for (const record of drill.evidence.instruments) {
    record.stopWorkingAfterExit = survived(record, orders);
    record.outcome = record.stopWorkingAfterExit ? 'passed' : 'failed';
    if (!record.stopWorkingAfterExit) record.reason = 'drill_stop_lost_after_exit';
    note(drill, 'drill_stop_survival_checked', {
      symbol: record.symbol,
      survived: record.stopWorkingAfterExit,
    });
  }
}

async function resumeDrill(drill: Drill, placed: unknown): Promise<void> {
  try {
    drill.evidence.instruments.push(...placedInstruments(placed));
    await checkSurvivors(drill);
  } catch (error) {
    drill.evidence.failure = messageOf(error);
    note(drill, 'drill_failed', drill.evidence.failure);
  } finally {
    await cleanUp({ ...drill, interrupt: new AbortController().signal });
  }
}

export async function resumeSimCfdDrill(
  gateway: SaxoSimGateway,
  placed: { readonly record: unknown; readonly source: string },
  options: DrillOptions,
  clock: DrillClock,
  interrupt: AbortSignal = new AbortController().signal,
): Promise<{ evidence: DrillEvidence; account: SimAccount | undefined }> {
  const evidence = newEvidence(clock, 'kill-resume');
  evidence.resumedFrom = placed.source;
  const account = await onTrialAccount(gateway, clock, evidence, (trial) =>
    resumeDrill({ gateway, options, clock, evidence, account: trial, interrupt }, placed.record),
  );
  return { evidence, account };
}
