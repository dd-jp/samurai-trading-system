import { SAXO_SIM_GATEWAY, type SaxoSimGateway } from './saxo-sim-gateway.js';
import {
  type AccountFlatness,
  type DrillEvidence,
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
}

export const DEFAULT_DRILL_TARGETS: readonly DrillTarget[] = [
  { symbol: 'AAPL:xnas', assetType: 'CfdOnStock' },
  { symbol: 'ISF:xlon', assetType: 'CfdOnEtf' },
];

export interface DrillOptions {
  readonly targets: readonly DrillTarget[];
  readonly runId: string;
  readonly restDistance: number;
  readonly crossDistance: number;
  readonly nearDistance: number;
  readonly pollIntervalMs: number;
  readonly fillTimeoutMs: number;
  readonly triggerTimeoutMs: number;
}

export const DEFAULT_DRILL_OPTIONS: Omit<DrillOptions, 'targets' | 'runId'> = {
  restDistance: 0.1,
  crossDistance: 0.005,
  nearDistance: 0.0005,
  pollIntervalMs: 2_000,
  fillTimeoutMs: 60_000,
  triggerTimeoutMs: 600_000,
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
  if (quote.shortTradeDisabled) return skip(record, 'short_disabled');
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

export function shortWithStop(
  account: SimAccount,
  instrument: DrillInstrument,
  amount: number,
  prices: { stop: number; target: number },
  reference: string,
): Record<string, unknown> {
  const leg = (OrderType: 'StopIfTraded' | 'Limit', OrderPrice: number, suffix: string) => ({
    Uic: instrument.uic,
    AssetType: instrument.assetType,
    BuySell: 'Buy',
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
    BuySell: 'Sell',
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
  const stop = toTick(
    quote.ask * (1 + drill.options.restDistance),
    rules.tickSize(quote.ask),
    'up',
  );
  const target = toTick(
    quote.bid * (1 - drill.options.restDistance),
    rules.tickSize(quote.bid),
    'down',
  );
  const reference = `drill-${drill.options.runId}-${instrument.uic}`;
  record.amount = amount;
  record.stop = { placedPrice: stop };
  record.targetPrice = target;
  const payload = shortWithStop(drill.account, instrument, amount, { stop, target }, reference);
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
  const amount = record.amount ?? 0;
  const position = await poll(drill, drill.options.fillTimeoutMs, async () =>
    (await netPositions(drill.gateway)).find(
      (row) => isOn(instrument)(row) && row.amount === -amount,
    ),
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
    row.buySell === 'Buy' &&
    row.amount === record.amount &&
    Math.abs((row.price ?? Number.NaN) - stop.placedPrice) <= halfTick;
  if (!matches) fail(record, 'drill_stop_mismatch');
}

function amendPayload(
  drill: Drill,
  record: InstrumentEvidence,
  orderId: string,
  price: number,
): Record<string, unknown> {
  return {
    AccountKey: drill.account.accountKey,
    OrderId: orderId,
    AssetType: record.assetType,
    OrderType: 'StopIfTraded',
    OrderPrice: price,
    Amount: record.amount,
    OrderDuration: { DurationType: 'GoodTillCancel' },
  };
}

async function amendToTrigger(
  drill: Drill,
  record: InstrumentEvidence,
  rules: InstrumentRules,
): Promise<void> {
  const fill = record.entry?.fillPrice;
  const stop = record.stop;
  if (fill === undefined || stop?.orderId === undefined) fail(record, 'drill_fill_price_unknown');
  const tick = rules.tickSize(fill);
  const fallback = rules.defaultStopLossFraction;
  const candidates = [
    toTick(fill * (1 - drill.options.crossDistance), tick, 'down'),
    toTick(fill * (1 + drill.options.nearDistance), tick, 'up'),
    ...(fallback === undefined ? [] : [toTick(fill * (1 + fallback), tick, 'up')]),
  ];
  stop.amendAttempts = [];
  for (const price of candidates) {
    const reply = await drill.gateway.send(
      'PATCH',
      '/trade/v2/orders',
      amendPayload(drill, record, stop.orderId, price),
    );
    stop.amendAttempts.push({ price, status: reply.status, body: reply.body });
    note(drill, 'drill_stop_amended', { symbol: record.symbol, price, status: reply.status });
    if (reply.status === 200) return;
  }
  fail(record, 'drill_stop_amend_rejected');
}

async function awaitTrigger(
  drill: Drill,
  record: InstrumentEvidence,
  instrument: DrillInstrument,
): Promise<void> {
  const stop = record.stop;
  const since = new Date(Date.parse(record.entry?.placedAt ?? drill.evidence.startedAt) - 60_000);
  const fill = await poll(drill, drill.options.triggerTimeoutMs, async () =>
    (await orderActivities(drill.gateway, drill.account, since)).find(
      (activity) => activity.orderId === stop?.orderId && FILLED_STATUSES.has(activity.status),
    ),
  );
  if (fill === undefined || stop === undefined) fail(record, 'drill_stop_not_triggered');
  stop.triggeredAt = fill.activityTime;
  stop.triggerStatus = fill.status;
  stop.triggerFillPrice = fill.averagePrice;
  note(drill, 'drill_stop_triggered', { symbol: record.symbol, activity: fill });
  const open = await poll(drill, drill.options.fillTimeoutMs, async () => {
    const rows = (await netPositions(drill.gateway)).filter(isOn(instrument));
    return rows.every((row) => row.amount === 0) ? true : undefined;
  });
  record.positionClosedAfterTrigger = open === true;
  if (!record.positionClosedAfterTrigger) fail(record, 'drill_position_not_closed');
}

async function drillInstrument(drill: Drill, target: DrillTarget): Promise<void> {
  stopIfInterrupted(drill);
  const record: InstrumentEvidence = { ...target, outcome: 'running' };
  drill.evidence.instruments.push(record);
  note(drill, 'drill_instrument_started', target);
  const prepared = await prepare(drill, record);
  if (prepared === undefined) {
    note(drill, 'drill_instrument_skipped', { symbol: record.symbol, reason: record.reason });
    return;
  }
  record.outcome = 'failed';
  await placeEntry(drill, record, prepared);
  await awaitFill(drill, record, prepared.instrument);
  await verifyRest(drill, record, prepared);
  await amendToTrigger(drill, record, prepared.rules);
  await awaitTrigger(drill, record, prepared.instrument);
  record.outcome = 'passed';
  note(drill, 'drill_instrument_passed', { symbol: record.symbol });
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

export function newEvidence(clock: DrillClock): DrillEvidence {
  return {
    drill: 'sim-cfd-stop-drill',
    refs: ['#1400', '#1916'],
    gateway: SAXO_SIM_GATEWAY,
    startedAt: clock.now().toISOString(),
    instruments: [],
    cleanup: { cancelled: [], flattened: [], errors: [] },
    steps: [],
    passed: false,
  };
}

async function runDrill(drill: Drill): Promise<void> {
  try {
    drill.evidence.flatBefore = await flatness(drill.gateway, stamp(drill));
    if (!isFlat(drill.evidence.flatBefore)) throw new DrillFailure('drill_account_not_flat');
    for (const target of drill.options.targets) await drillInstrument(drill, target);
  } catch (error) {
    drill.evidence.failure = messageOf(error);
    note(drill, 'drill_failed', drill.evidence.failure);
  } finally {
    if (isFlat(drill.evidence.flatBefore)) {
      await cleanUp({ ...drill, interrupt: new AbortController().signal });
    }
  }
}

export async function runSimCfdStopDrill(
  gateway: SaxoSimGateway,
  options: DrillOptions,
  clock: DrillClock,
  interrupt: AbortSignal = new AbortController().signal,
): Promise<{ evidence: DrillEvidence; account: SimAccount | undefined }> {
  const evidence = newEvidence(clock);
  let account: SimAccount | undefined;
  try {
    account = await trialAccount(gateway);
    evidence.account = { isTrialAccount: true, currency: account.currency };
    note({ clock, evidence }, 'drill_trial_account_confirmed');
    await runDrill({ gateway, options, clock, evidence, account, interrupt });
  } catch (error) {
    evidence.failure = messageOf(error);
    note({ clock, evidence }, 'drill_refused', evidence.failure);
  }
  evidence.finishedAt = clock.now().toISOString();
  evidence.passed = drillPassed(evidence);
  return { evidence, account };
}
