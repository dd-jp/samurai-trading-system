import {
  describeThrownSafely,
  heldQuantitiesFor,
  type LotHeldQuantity,
  logCaughtFailure,
  type OpenPosition,
  type OrderIntent,
  safeLog,
  totalHeldQuantity,
} from '../../shared/index.js';
import type { CostBreakdown, FillRequest, MarketState } from '../../tools/backtest/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ingestFills } from './ingest-fills.js';
import { reconcile } from './reconcile.js';
import { markResidualsUnprotected } from './residual-protection.js';
import { sweepResidualProtection } from './residual-protection-sweep.js';
import {
  DuplicatePositionError,
  UnresolvedFlattenForInstrumentError,
} from './sqlite-shared-store.js';
import type {
  Execution,
  ExecutionInput,
  ExecutionResult,
  FlattenJournal,
  FlattenSubmissionWriteAhead,
  LotJournal,
  NativeBracketRequest,
  ReconcileReport,
  ResidualProtectionSweepResult,
  SubmitInput,
} from './types.js';

export class ExecutionImpl implements Execution {
  constructor(private readonly input: ExecutionInput) {}

  async ingestFills(): Promise<void> {
    return ingestFills(this.input);
  }

  async reconcile(): Promise<ReconcileReport> {
    return reconcile(this.input);
  }

  async sweepResidualProtection(): Promise<ResidualProtectionSweepResult> {
    return sweepResidualProtection(this.input);
  }

  async execute(verdict: VerdictDecision): Promise<ExecutionResult> {
    return executeVerdict(this.input, verdict);
  }
}

const ALREADY_EXISTS = 'an order or fill already exists for this idempotency_key';

async function executeVerdict(
  input: SubmitInput,
  verdict: VerdictDecision,
): Promise<ExecutionResult> {
  const now = input.clock.now();

  if (verdict.status !== 'go' || verdict.order === null) {
    return result('error', verdict.idempotency_key, now, {
      reason: `Execution.execute requires a 'go' VerdictDecision with a non-null order (got '${verdict.status}')`,
    });
  }

  const order = verdict.order;
  if (await input.store.findByKey(order.idempotency_key)) {
    return executeOnExistingKey(input, order, now);
  }
  if (!isEntryOrder(order)) {
    return executeExit(input, order, order.idempotency_key, now);
  }
  return submitEntry(input, order, now);
}

type EntryOrder = OrderIntent & { intent_type: OpenPosition['intent_type'] };

function isEntryOrder(order: OrderIntent): order is EntryOrder {
  return order.intent_type !== 'exit';
}

async function executeOnExistingKey(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
): Promise<ExecutionResult> {
  const retryKey =
    order.intent_type === 'exit'
      ? await resolveExitRetryKey(input.store, order.idempotency_key)
      : null;
  if (retryKey === null) {
    return result('deduped', order.idempotency_key, now, { reason: ALREADY_EXISTS });
  }
  return executeExit(input, order, retryKey, now);
}

async function submitEntry(
  input: SubmitInput,
  order: EntryOrder,
  now: Date,
): Promise<ExecutionResult> {
  const { broker, store } = input;
  const idempotencyKey = order.idempotency_key;
  const snapshot = await captureSubmitSnapshot(input, order, now);

  if (!(await writeAheadEntry(store, openPositionFor(order, now, snapshot)))) {
    return result('deduped', idempotencyKey, now, { reason: ALREADY_EXISTS });
  }

  let ack: Awaited<ReturnType<typeof broker.submitBracket>>;
  try {
    ack = await broker.submitBracket(bracketFor(order));
  } catch (error) {
    return result('error', idempotencyKey, now, {
      order_state: 'pending',
      reason: describeThrownSafely(error),
    });
  }

  await store.updatePositionState(idempotencyKey, {
    order_state: ack.order_state,
    broker_order_ids: ack.broker_order_ids,
  });

  return result('submitted', idempotencyKey, now, {
    order_state: ack.order_state,
    broker_order_ids: ack.broker_order_ids,
  });
}

async function writeAheadEntry(store: LotJournal, position: OpenPosition): Promise<boolean> {
  try {
    await store.writeAheadPosition(position);
    return true;
  } catch (error) {
    if (error instanceof DuplicatePositionError) return false;
    throw error;
  }
}

export function bracketFor(order: OrderIntent): NativeBracketRequest {
  return {
    client_order_id: order.idempotency_key,
    instrument: order.instrument,
    asset_class: order.asset_class,
    side: order.side,
    size: order.size,
    entry: order.entry,
    stop: order.stop,
    target: order.target,
    time_in_force: order.time_in_force,
  };
}

export function openPositionFor(
  order: EntryOrder,
  now: Date,
  snapshot: SubmitSnapshot,
): OpenPosition {
  return {
    idempotency_key: order.idempotency_key,
    debate_id: order.metadata.debate_id,
    instrument: order.instrument,
    asset_class: order.asset_class,
    side: order.side,
    intent_type: order.intent_type,
    requested_size: order.size,
    filled_size: 0,
    avg_entry_price: 0,
    stop: order.stop,
    target: order.target,
    order_state: 'pending',
    broker_order_ids: [],
    opened_at: now,
    decision_timestamp: order.decision_timestamp,
    conviction: order.metadata.conviction,
    converged: order.metadata.converged,
    ...withoutNulls(snapshot),
  };
}

type WithoutNulls<T> = { [K in keyof T]?: Exclude<T[K], null> };

export function withoutNulls<T extends object>(record: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}

const EXIT_SNAPSHOT_BUDGET_MS = 2_000;

interface SubmitSnapshot {
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: CostBreakdown | null;
  modelled_protective_exit_cost_breakdown: CostBreakdown | null;
}

async function captureSubmitSnapshot(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
  budget_ms?: number,
): Promise<SubmitSnapshot> {
  const decision_price = decisionPriceFor(order);

  if (budget_ms === undefined) return readSubmitSnapshot(input, order, now, decision_price);

  const empty: SubmitSnapshot = {
    decision_price,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
    modelled_protective_exit_cost_breakdown: null,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readSubmitSnapshot(input, order, now, decision_price),
      new Promise<SubmitSnapshot>((resolve) => {
        timer = setTimeout(() => {
          safeLog(input.logger, {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'submit_snapshot_budget_exceeded',
            level: 'warn',
            message:
              `#1001: captureSubmitSnapshot exceeded its ${budget_ms}ms exit budget — the quote ` +
              'and modelled cost breakdown are left null for this order so the flatten is not ' +
              'held behind a stalled feed (#826). decision_price is unaffected.',
            payload: { idempotency_key: order.idempotency_key, instrument: order.instrument },
          });
          resolve(empty);
        }, budget_ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function decisionPriceFor(order: OrderIntent): number | null {
  if (order.intent_type === 'exit' && order.metadata.unpriced_exit === true) return null;
  return order.entry;
}

interface SubmitQuote {
  bid: number | null;
  ask: number | null;
  observed_at: Date | null;
}

interface ModelledCosts {
  entry: CostBreakdown | null;
  protective_exit: CostBreakdown | null;
}

const NO_QUOTE: SubmitQuote = { bid: null, ask: null, observed_at: null };
const NO_MODELLED_COSTS: ModelledCosts = { entry: null, protective_exit: null };

export function submitSnapshotOf(
  decision_price: number | null,
  quote: SubmitQuote,
  costs: ModelledCosts,
): SubmitSnapshot {
  return {
    decision_price,
    quote_bid: quote.bid,
    quote_ask: quote.ask,
    quote_mid: quote.bid === null || quote.ask === null ? null : (quote.bid + quote.ask) / 2,
    quote_observed_at: quote.observed_at,
    modelled_cost_breakdown: costs.entry,
    modelled_protective_exit_cost_breakdown: costs.protective_exit,
  };
}

async function readSubmitSnapshot(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
  decision_price: number | null,
): Promise<SubmitSnapshot> {
  if (order.metadata.unpriced_exit === true) {
    logSnapshotSkipped(
      input,
      order,
      '#1001: captureSubmitSnapshot skipped the quote/cost-model reads for an unpriced exit ' +
        '(order.metadata.unpriced_exit) — the feed was already known dark this tick, so ' +
        're-probing it here would only risk widening the #826 flatten window.',
    );
    return submitSnapshotOf(decision_price, NO_QUOTE, NO_MODELLED_COSTS);
  }

  const quote = await readSubmitQuote(input, order, now);

  if (input.broker.prices_own_fills === true) {
    logSnapshotSkipped(
      input,
      order,
      '#1001: captureSubmitSnapshot skipped its own CostModel.fill on the Simulated-adapter ' +
        'path — the adapter prices this order itself and that breakdown is persisted directly ' +
        'onto the fill, so a second pricing here could only disagree with it.',
    );
    return submitSnapshotOf(decision_price, quote, NO_MODELLED_COSTS);
  }

  return submitSnapshotOf(decision_price, quote, await readModelledCosts(input, order, now));
}

function logSnapshotSkipped(input: SubmitInput, order: OrderIntent, message: string): void {
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    level: 'info',
    message,
    payload: { idempotency_key: order.idempotency_key, instrument: order.instrument },
  });
}

async function readSubmitQuote(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
): Promise<SubmitQuote> {
  try {
    const quote = await input.marketData.getQuote(order.instrument, now);
    if (quote === null) return NO_QUOTE;
    return { bid: quote.bid, ask: quote.ask, observed_at: quote.observed_at };
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'submit_snapshot_quote_unavailable',
        level: 'warn',
        message:
          '#1001: captureSubmitSnapshot could not read a quote at submit time — ' +
          'quote_bid/quote_ask/quote_mid/quote_observed_at are left null for this order. ' +
          'Best-effort instrumentation only; the order is submitted regardless.',
      },
      error,
      { idempotency_key: order.idempotency_key, instrument: order.instrument },
    );
    return NO_QUOTE;
  }
}

async function readModelledCosts(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
): Promise<ModelledCosts> {
  try {
    const marketState = await submitMarketState(input, order, now);
    const entry = input.costModel.fill(entryFillRequest(order), marketState).cost_breakdown;
    const protective_exit =
      order.intent_type === 'exit'
        ? null
        : input.costModel.fill(protectiveExitFillRequest(order), marketState).cost_breakdown;
    return { entry, protective_exit };
  } catch (error) {
    logCaughtFailure(
      input.logger,
      {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'submit_snapshot_cost_unavailable',
        level: 'warn',
        message:
          '#1001: captureSubmitSnapshot could not assemble a MarketState / price the modelled ' +
          'cost breakdown at submit time — modelled_cost_breakdown is left null for this order. ' +
          'Best-effort instrumentation only; the order is submitted regardless.',
      },
      error,
      { idempotency_key: order.idempotency_key, instrument: order.instrument },
    );
    return NO_MODELLED_COSTS;
  }
}

async function submitMarketState(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
): Promise<MarketState> {
  const { marketData, config } = input;
  const [mark, volatility, spread, adv] = await Promise.all([
    marketData.getMark(order.instrument, now),
    marketData.getIndicator(order.instrument, config.simulated.volatility_indicator, now),
    marketData.getSpreadEstimate(order.instrument, now),
    marketData.getADV(order.instrument, config.simulated.adv_window, now),
  ]);
  return {
    mid: mark.price,
    spread,
    adv,
    volatility: volatility.value,
    asset_class: mark.asset_class,
    ...(config.simulated.venue === undefined ? {} : { venue: config.simulated.venue }),
    timestamp: mark.observed_at,
  };
}

export function entryFillRequest(order: OrderIntent): FillRequest {
  return {
    instrument: order.instrument,
    side: order.side,
    size: order.size,
    order_type: order.intent_type === 'exit' ? 'market' : 'limit',
    ...(order.intent_type === 'exit' ? {} : { limit_price: order.entry }),
    idempotency_key: order.idempotency_key,
  };
}

export function protectiveExitFillRequest(order: OrderIntent): FillRequest {
  return {
    instrument: order.instrument,
    side: order.side === 'buy' ? 'sell' : 'buy',
    size: order.size,
    order_type: 'market',
    idempotency_key: order.idempotency_key,
  };
}

const MAX_EXIT_RETRY_ATTEMPTS = 3;

async function resolveExitRetryKey(
  store: LotJournal & FlattenJournal,
  baseKey: string,
): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_EXIT_RETRY_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? baseKey : `${baseKey}:retry-${attempt}`;
    const exists = await store.findByKey(candidate);
    if (!exists) return candidate;
    const retryable = await store.isRetryableFlattenError(candidate);
    if (!retryable) return null;
  }
  return null;
}

async function executeExit(
  input: SubmitInput,
  order: OrderIntent,
  idempotencyKey: string,
  now: Date,
): Promise<ExecutionResult> {
  const { store } = input;

  const heldLots = (await store.getOpenPositions()).filter(
    (lot) => lot.instrument === order.instrument,
  );
  const heldSide = heldLots[0]?.side;

  if (heldLots.length === 0 || heldSide === undefined) {
    return result('error', idempotencyKey, now, {
      reason: `exit intent for '${order.instrument}' but the store holds no open lot to close`,
    });
  }

  const perLotHeld = await heldQuantitiesFor(heldLots, (keys) => store.getExitFillSizes(keys));
  const refusal = exitRefusal(order, heldSide, perLotHeld);
  if (refusal !== undefined) return result('error', idempotencyKey, now, { reason: refusal });

  const exitReason = order.metadata.exit_reason;
  if (exitReason === undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' carries no metadata.exit_reason — every exit ` +
        `intent must name one (ExitReason, shared/types/records.ts)`,
    });
  }

  const snapshot = await captureSubmitSnapshot(input, order, now, EXIT_SNAPSHOT_BUDGET_MS);
  const flatten: FlattenSubmissionWriteAhead = {
    idempotency_key: idempotencyKey,
    instrument: order.instrument,
    asset_class: order.asset_class,
    side: order.side,
    exit_reason: exitReason,
    size: order.size,
    submitted_at: now,
    lot_held_quantities: perLotHeld,
    decision_price: snapshot.decision_price,
    quote_bid: snapshot.quote_bid,
    quote_ask: snapshot.quote_ask,
    quote_mid: snapshot.quote_mid,
    quote_observed_at: snapshot.quote_observed_at,
    modelled_cost_breakdown: snapshot.modelled_cost_breakdown,
  };
  const inFlight = await writeAheadExit(input, flatten);
  if (inFlight !== undefined) return result('deduped', idempotencyKey, now, { reason: inFlight });

  const cancelFailure = await cancelHeldLots(input, heldLots, flatten, now);
  if (cancelFailure !== undefined) {
    return result('error', idempotencyKey, now, { reason: cancelFailure });
  }

  return await submitFlattenOrder(input, order, idempotencyKey, now);
}

async function submitFlattenOrder(
  input: SubmitInput,
  order: OrderIntent,
  idempotencyKey: string,
  now: Date,
): Promise<ExecutionResult> {
  const { broker, store } = input;

  let ack: Awaited<ReturnType<typeof broker.submitFlatten>>;
  try {
    ack = await broker.submitFlatten(order.instrument, order.side, order.size, idempotencyKey);
  } catch (error) {
    return result('error', idempotencyKey, now, {
      reason: describeThrownSafely(error),
    });
  }

  await store.resolveFlattenSubmitted(
    idempotencyKey,
    { order_state: ack.order_state, broker_order_ids: ack.broker_order_ids },
    now,
  );

  return result('submitted', idempotencyKey, now, {
    order_state: ack.order_state,
    broker_order_ids: ack.broker_order_ids,
  });
}

export function exitRefusal(
  order: OrderIntent,
  heldSide: OpenPosition['side'],
  perLotHeld: readonly LotHeldQuantity[],
): string | undefined {
  const overExited = perLotHeld.find((lot) => lot.held < 0);
  if (overExited !== undefined) {
    return (
      `exit intent for '${order.instrument}' refused: lot '${overExited.idempotency_key}' ` +
      `records more closed quantity than it ever opened (held ${overExited.held})`
    );
  }

  const expectedClosingSide = heldSide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedClosingSide) {
    return (
      `exit intent side '${order.side}' does not match the closing side ` +
      `'${expectedClosingSide}' implied by the held lot(s)' side ('${heldSide}') for ` +
      `'${order.instrument}'`
    );
  }

  const heldSize = totalHeldQuantity(perLotHeld);
  if (order.size !== heldSize) {
    return (
      `exit intent size ${order.size} does not match the held quantity ${heldSize} ` +
      `for '${order.instrument}'`
    );
  }

  return divergedLotRefusal(order, perLotHeld);
}

export function divergedLotRefusal(
  order: OrderIntent,
  perLotHeld: readonly LotHeldQuantity[],
): string | undefined {
  const recordedLots = order.metadata.lot_held_quantities;
  if (recordedLots === undefined) return undefined;
  const recordedByKey = new Map(recordedLots.map((lot) => [lot.idempotency_key, lot.held]));
  const diverged = perLotHeld.find(
    (lot) => (recordedByKey.get(lot.idempotency_key) ?? 0) !== lot.held,
  );
  if (diverged === undefined) return undefined;
  const recorded = recordedByKey.get(diverged.idempotency_key) ?? 0;
  return (
    `exit intent for '${order.instrument}' refused: lot '${diverged.idempotency_key}' ` +
    `now holds ${diverged.held} but the intent recorded ${recorded} — the covered lot set ` +
    `has diverged since the Trader keyed this exit`
  );
}

async function writeAheadExit(
  input: SubmitInput,
  flatten: FlattenSubmissionWriteAhead,
): Promise<string | undefined> {
  try {
    await input.store.writeAheadFlatten(flatten);
    return undefined;
  } catch (error) {
    if (!(error instanceof UnresolvedFlattenForInstrumentError)) throw error;
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'flatten_refused_in_flight',
      level: 'warn',
      message:
        `executeExit: this exit (exit_reason '${flatten.exit_reason}') was refused ` +
        'because another flatten on this instrument is still unresolved — reported as ' +
        '`deduped`, which is NOT the same as "already flat": this lot is still held. The next ' +
        'tick in the #826 window retries, and the blocking row is bounded (reconcile.ts ' +
        'UNRESOLVABLE_FLATTEN_MAX_AGE_MS).',
      payload: {
        idempotency_key: flatten.idempotency_key,
        instrument: flatten.instrument,
        blocking_key: error.blocking_key,
        exit_reason: flatten.exit_reason,
      },
    });
    return error.message;
  }
}

async function cancelHeldLots(
  input: SubmitInput,
  heldLots: readonly OpenPosition[],
  flatten: FlattenSubmissionWriteAhead,
  now: Date,
): Promise<string | undefined> {
  const cancelledLots: OpenPosition[] = [];
  for (const lot of heldLots) {
    try {
      await input.broker.cancel(lot.idempotency_key, flatten.instrument);
      cancelledLots.push(lot);
    } catch (error) {
      const reason =
        `cancelling held lot '${lot.idempotency_key}' before the flatten failed, so the ` +
        `flatten was not sent: ${describeThrownSafely(error)}`;
      await markLotsUnprotected(input, cancelledLots, lot.idempotency_key, error, now);
      await input.store.resolveFlattenError(flatten.idempotency_key, reason, now);
      return reason;
    }
  }
  return undefined;
}

async function markLotsUnprotected(
  input: SubmitInput,
  cancelledLots: readonly OpenPosition[],
  failedLotKey: string,
  error: unknown,
  now: Date,
): Promise<void> {
  logCaughtFailure(
    input.logger,
    {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'exit_cancel_failed',
      level: 'error',
      message:
        'executeExit: cancelling a held lot failed, so the flatten was refused — any lot ' +
        'listed in unprotected_lots had its cancel CONFIRMED before this failure, so it is ' +
        'now open with no protective legs and is being marked for the #549 sweep to re-arm. ' +
        "An empty list means nothing was confirmed cancelled. The failing lot's own legs " +
        'are of unknown state and are deliberately left unmarked (re-arming over a live ' +
        'bracket is double protection, #516 from the other direction).',
    },
    error,
    { failed_lot: failedLotKey, unprotected_lots: cancelledLots.map((lot) => lot.idempotency_key) },
  );

  await markResidualsUnprotected(
    input,
    cancelledLots.map((lot) => lot.idempotency_key),
    now,
    {
      level: 'error',
      message:
        'executeExit: markResidualUnprotected failed for a lot whose protective legs were ' +
        'already cancelled — the #549 sweep will not know to re-arm it, so this lot is ' +
        'open and unprotected with no automatic recovery behind it',
    },
  );
}

function result(
  status: ExecutionResult['status'],
  idempotencyKey: string,
  now: Date,
  overrides: Partial<Omit<ExecutionResult, 'status' | 'idempotency_key' | 'timestamp'>> = {},
): ExecutionResult {
  return {
    status,
    idempotency_key: idempotencyKey,
    broker_order_ids: null,
    order_state: null,
    reason: null,
    timestamp: now,
    ...overrides,
  };
}
