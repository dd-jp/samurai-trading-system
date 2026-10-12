import type { ReconcileDiff } from '../../../../contracts/index.js';
import type { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import {
  type BrokerAck,
  describeThrownSafely,
  type Logger,
  type TokenBucket,
} from '../../../shared/index.js';
import { compareVenue } from '../reconcile-compare.js';
import { AlpacaBrokerAdapter } from './alpaca/alpaca-adapter.js';
import type { AlpacaBrokerClient, AlpacaOrder, AlpacaQuoteClient } from './alpaca/alpaca-client.js';
import { AlpacaBrokerBooks } from './broker-books.js';
import { redactEvidence } from './evidence-redaction.js';

export const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const MIN_MINUTES_BEFORE_CLOSE = 20;

export class ProbeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefusal';
  }
}

export type ProbeCalendar = Pick<UsEquityRegularHoursCalendar, 'isOpen' | 'sessionEnd'>;

export interface ProbeClient extends AlpacaBrokerClient, AlpacaQuoteClient {
  readonly baseUrl: string;
}

export interface ProbeClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface ProbeDeps {
  readonly client: ProbeClient;
  readonly clock: ProbeClock;
  readonly calendar: ProbeCalendar;
  readonly logger: Logger;
  readonly rateLimiter?: TokenBucket;
}

export interface ProbeOptions {
  readonly symbol: string;
  readonly runId: string;
  readonly pollMs: number;
  readonly pollAttempts: number;
  readonly settleMs: number;
}

export const DEFAULT_PROBE_OPTIONS: Omit<ProbeOptions, 'runId'> = {
  symbol: 'SCHD',
  pollMs: 2_000,
  pollAttempts: 30,
  settleMs: 3_000,
};

export interface ProbePrices {
  readonly ask: number;
  readonly entry: number;
  readonly bracketStop: number;
  readonly target: number;
  readonly rearmStop: number;
}

export interface ProbeSnapshot {
  readonly phase: string;
  readonly at: string;
  readonly ledgerStop: number | null;
  readonly history: readonly AlpacaOrder[];
  readonly open: readonly AlpacaOrder[];
  readonly reader: { readonly positions: unknown[]; readonly openOrders: unknown[] };
  readonly diffs: readonly ReconcileDiff[];
}

export interface ProbeResidual {
  readonly positionQty: number;
  readonly workingOrderIds: readonly string[];
}

export interface ProbeEvidence {
  readonly probe: 'alpaca-oco-probe';
  readonly refs: readonly string[];
  readonly baseUrl: string;
  readonly symbol: string;
  readonly entryClientOrderId: string;
  readonly startedAt: string;
  finishedAt?: string;
  prices?: ProbePrices;
  entryAck?: BrokerAck;
  rearmPlacedQty?: number;
  ocoStopLegStatus?: string | null;
  readonly snapshots: ProbeSnapshot[];
  readonly cleanup: { cancelled: string[]; flattenOrder?: AlpacaOrder; errors: string[] };
  residual?: ProbeResidual;
  failure?: string;
  passed: boolean;
}

export function assertAlpacaPaper(baseUrl: string): void {
  if (baseUrl === ALPACA_PAPER_BASE_URL) return;
  throw new ProbeRefusal(
    `paper_only_refusal: the Alpaca trading base URL is '${baseUrl}', not ${ALPACA_PAPER_BASE_URL}; the probe places orders and runs on paper only`,
  );
}

export function assertMarketHours(now: Date, calendar: ProbeCalendar): void {
  const close = calendar.isOpen(now) ? calendar.sessionEnd(now) : null;
  const minutesLeft = close === null ? 0 : (close.getTime() - now.getTime()) / 60_000;
  if (minutesLeft >= MIN_MINUTES_BEFORE_CLOSE) return;
  throw new ProbeRefusal(
    `market_hours_refusal: ${now.toISOString()} is outside US regular market hours, or within ${MIN_MINUTES_BEFORE_CLOSE} minutes of the close; run it between 09:30 and 15:40 ET on a trading day`,
  );
}

const ENDED_STATES: ReadonlySet<string> = new Set([
  'canceled',
  'filled',
  'expired',
  'replaced',
  'rejected',
  'done_for_day',
]);

function workingIds(history: readonly AlpacaOrder[], prefix: string): string[] {
  return history
    .filter((order) => order.client_order_id.startsWith(prefix))
    .flatMap((order) => [order, ...(order.legs ?? [])])
    .filter((order) => !ENDED_STATES.has(order.status))
    .map((order) => order.id);
}

async function heldQty(client: ProbeClient, symbol: string): Promise<number> {
  const positions = await client.getPositions();
  const held = positions.find((position) => position.symbol === symbol);
  return held === undefined ? 0 : Number(held.qty);
}

async function assertUntouched(client: ProbeClient, symbol: string): Promise<void> {
  const [qty, open] = await Promise.all([heldQty(client, symbol), client.listOpenOrders()]);
  const orders = open.filter((order) => order.symbol === symbol).length;
  if (qty === 0 && orders === 0) return;
  throw new ProbeRefusal(
    `account_not_clean_refusal: the paper account already holds ${qty} ${symbol} with ${orders} open order(s) on it; pick another --symbol`,
  );
}

const cents = (value: number): number => Math.round(value * 100) / 100;

export function probePrices(ask: number): ProbePrices {
  if (!Number.isFinite(ask) || ask <= 0) throw new Error(`no usable ask: ${ask}`);
  const entry = cents(ask * 1.005);
  return {
    ask,
    entry,
    bracketStop: cents(entry * 0.95),
    target: cents(entry * 1.05),
    rearmStop: cents(entry * 0.93),
  };
}

async function snapshot(
  deps: ProbeDeps,
  symbol: string,
  phase: string,
  ledger: { readonly stop: number; readonly entryId: string } | null,
): Promise<ProbeSnapshot> {
  const at = deps.clock.now().toISOString();
  const [history, open, book] = await Promise.all([
    deps.client.listOrderHistory([symbol]),
    deps.client.listOpenOrders(),
    new AlpacaBrokerBooks(deps.client).read('alpaca'),
  ]);
  const positions = book.positions.filter((position) => position.instrument === symbol);
  const openOrders = book.openOrders.filter((order) => order.instrument === symbol);
  const diffs =
    ledger === null
      ? []
      : compareVenue(
          {
            positions: new Map([[symbol, 1]]),
            openOrders: [],
            protection: new Map([
              [symbol, { entryOrderIds: [ledger.entryId], stops: [ledger.stop] }],
            ]),
          },
          { positions: new Map(positions.map((p) => [p.instrument, p.qty])), openOrders },
        );
  return {
    phase,
    at,
    ledgerStop: ledger?.stop ?? null,
    history,
    open: open.filter((order) => order.symbol === symbol),
    reader: { positions, openOrders },
    diffs,
  };
}

async function pollUntil<T>(
  clock: ProbeClock,
  options: ProbeOptions,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  let last = await read();
  for (let attempt = 1; attempt < options.pollAttempts && !done(last); attempt += 1) {
    await clock.sleep(options.pollMs);
    last = await read();
  }
  if (done(last)) return last;
  throw new Error(`${what} did not happen after ${options.pollAttempts} checks`);
}

function ocoStopStatus(history: readonly AlpacaOrder[], rearmPrefix: string): string | null {
  const oco = history.find((order) => order.client_order_id.startsWith(rearmPrefix));
  return oco?.legs?.find((leg) => leg.type === 'stop')?.status ?? null;
}

async function probeSteps(
  deps: ProbeDeps,
  options: ProbeOptions,
  evidence: ProbeEvidence,
): Promise<void> {
  const { client, clock } = deps;
  const { symbol } = options;
  const entryId = evidence.entryClientOrderId;
  const adapter = new AlpacaBrokerAdapter({
    client,
    logger: deps.logger,
    clock,
    unpricedFillAlerts: { postUnpricedFillAlert: () => Promise.resolve() },
    cancelConfirmWait: (ms) => clock.sleep(ms),
    ...(deps.rateLimiter === undefined ? {} : { rateLimiter: deps.rateLimiter }),
  });
  const prices = probePrices((await client.getLatestQuote(symbol)).ap);
  evidence.prices = prices;
  const ack = await adapter.submitBracket({
    client_order_id: entryId,
    instrument: symbol,
    asset_class: 'stocks',
    side: 'buy',
    size: 1,
    entry: prices.entry,
    stop: prices.bracketStop,
    target: prices.target,
    time_in_force: 'gtc',
  });
  evidence.entryAck = ack;
  const parentId = ack.broker_order_ids[0] ?? '';
  await pollUntil(
    clock,
    options,
    () => client.getOrder(parentId),
    (order) => order.status === 'filled',
    `the bracket entry ${entryId} fill`,
  );
  await clock.sleep(options.settleMs);
  evidence.snapshots.push(
    await snapshot(deps, symbol, 'after_fill', { stop: prices.bracketStop, entryId }),
    await snapshot(deps, symbol, 'stale_ledger_stop', { stop: prices.rearmStop, entryId }),
  );
  evidence.rearmPlacedQty = await adapter.replaceProtectiveLegs({
    entryClientOrderId: entryId,
    instrument: symbol,
    side: 'buy',
    qty: 1,
    stop: prices.rearmStop,
    target: prices.target,
  });
  await clock.sleep(options.settleMs);
  const after = await snapshot(deps, symbol, 'after_rearm', { stop: prices.rearmStop, entryId });
  evidence.snapshots.push(after);
  evidence.ocoStopLegStatus = ocoStopStatus(after.history, `${entryId}:rearm`);
}

async function cancelProbeOrders(
  deps: ProbeDeps,
  options: ProbeOptions,
  evidence: ProbeEvidence,
): Promise<void> {
  const prefix = evidence.entryClientOrderId;
  const working = workingIds(await deps.client.listOrderHistory([options.symbol]), prefix);
  for (const id of working) {
    await deps.client.cancelOrder(id);
    evidence.cleanup.cancelled.push(id);
  }
  await pollUntil(
    deps.clock,
    options,
    () => deps.client.listOrderHistory([options.symbol]),
    (history) => workingIds(history, prefix).length === 0,
    `the cancel of ${working.join(', ') || 'no orders'}`,
  );
}

async function flattenProbePosition(
  deps: ProbeDeps,
  options: ProbeOptions,
  evidence: ProbeEvidence,
): Promise<void> {
  const qty = await heldQty(deps.client, options.symbol);
  if (qty === 0) return;
  evidence.cleanup.flattenOrder = await deps.client.submitMarketOrder({
    symbol: options.symbol,
    side: qty > 0 ? 'sell' : 'buy',
    qty: String(Math.abs(qty)),
    time_in_force: 'day',
    client_order_id: `${evidence.entryClientOrderId}-flatten`,
  });
  await pollUntil(
    deps.clock,
    options,
    () => heldQty(deps.client, options.symbol),
    (left) => left === 0,
    `the flatten of ${qty} ${options.symbol}`,
  );
}

async function residualState(deps: ProbeDeps, options: ProbeOptions): Promise<ProbeResidual> {
  const [positionQty, history] = await Promise.all([
    heldQty(deps.client, options.symbol),
    deps.client.listOrderHistory([options.symbol]),
  ]);
  return { positionQty, workingOrderIds: workingIds(history, '') };
}

async function attempt(evidence: ProbeEvidence, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    evidence.cleanup.errors.push(describeThrownSafely(error));
  }
}

async function cleanUp(deps: ProbeDeps, options: ProbeOptions, evidence: ProbeEvidence) {
  await attempt(evidence, () => cancelProbeOrders(deps, options, evidence));
  await attempt(evidence, () => flattenProbePosition(deps, options, evidence));
  await attempt(evidence, async () => {
    evidence.residual = await residualState(deps, options);
  });
  await attempt(evidence, async () => {
    evidence.snapshots.push(await snapshot(deps, options.symbol, 'after_cleanup', null));
  });
}

function isFlat(residual: ProbeResidual | undefined): boolean {
  return residual?.positionQty === 0 && residual.workingOrderIds.length === 0;
}

export async function runAlpacaOcoProbe(
  deps: ProbeDeps,
  options: ProbeOptions,
): Promise<ProbeEvidence> {
  assertAlpacaPaper(deps.client.baseUrl);
  assertMarketHours(deps.clock.now(), deps.calendar);
  await assertUntouched(deps.client, options.symbol);
  const evidence: ProbeEvidence = {
    probe: 'alpaca-oco-probe',
    refs: ['#2090'],
    baseUrl: deps.client.baseUrl,
    symbol: options.symbol,
    entryClientOrderId: `oco-probe-${options.runId}`,
    startedAt: deps.clock.now().toISOString(),
    snapshots: [],
    cleanup: { cancelled: [], errors: [] },
    passed: false,
  };
  try {
    await probeSteps(deps, options, evidence);
  } catch (error) {
    evidence.failure = describeThrownSafely(error);
  } finally {
    await cleanUp(deps, options, evidence);
  }
  evidence.finishedAt = deps.clock.now().toISOString();
  evidence.passed =
    evidence.failure === undefined &&
    evidence.cleanup.errors.length === 0 &&
    isFlat(evidence.residual);
  return evidence;
}

const IDENTITY_KEYS: ReadonlySet<string> = new Set(['account_id', 'account_number']);

export function redact(value: unknown, secrets: readonly string[]): unknown {
  return redactEvidence(value, secrets, IDENTITY_KEYS);
}
