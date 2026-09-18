import {
  describeThrownSafely,
  heldQuantitiesFor,
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the dedup gate, write-ahead-before-broker-call, and exit-retry walk are each ordered for a race/double-submit hazard named above; extracting a helper would relocate an early `return` uncaught by the compiler, silently changing what short-circuits the order path
export async function executeVerdict(
  input: SubmitInput,
  verdict: VerdictDecision,
): Promise<ExecutionResult> {
  const { clock, broker, store } = input;
  const now = clock.now();

  if (verdict.status !== 'go' || verdict.order === null) {
    return result('error', verdict.idempotency_key, now, {
      reason: `Execution.execute requires a 'go' VerdictDecision with a non-null order (got '${verdict.status}')`,
    });
  }

  const order = verdict.order;
  const idempotencyKey = order.idempotency_key;

  if (await store.findByKey(idempotencyKey)) {
    if (order.intent_type !== 'exit') {
      return result('deduped', idempotencyKey, now, {
        reason: 'an order or fill already exists for this idempotency_key',
      });
    }
    const retryKey = await resolveExitRetryKey(store, idempotencyKey);
    if (retryKey === null) {
      return result('deduped', idempotencyKey, now, {
        reason: 'an order or fill already exists for this idempotency_key',
      });
    }
    return executeExit(input, order, retryKey, now);
  }

  if (order.intent_type === 'exit') {
    return executeExit(input, order, idempotencyKey, now);
  }

  const bracket: NativeBracketRequest = {
    client_order_id: idempotencyKey,
    instrument: order.instrument,
    asset_class: order.asset_class,
    side: order.side,
    size: order.size,
    entry: order.entry,
    stop: order.stop,
    target: order.target,
    time_in_force: order.time_in_force,
  };

  const snapshot = await captureSubmitSnapshot(input, order, now);

  const position: OpenPosition = {
    idempotency_key: idempotencyKey,
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
    ...(snapshot.decision_price === null ? {} : { decision_price: snapshot.decision_price }),
    ...(snapshot.quote_bid === null ? {} : { quote_bid: snapshot.quote_bid }),
    ...(snapshot.quote_ask === null ? {} : { quote_ask: snapshot.quote_ask }),
    ...(snapshot.quote_mid === null ? {} : { quote_mid: snapshot.quote_mid }),
    ...(snapshot.quote_observed_at === null
      ? {}
      : { quote_observed_at: snapshot.quote_observed_at }),
    ...(snapshot.modelled_cost_breakdown === null
      ? {}
      : { modelled_cost_breakdown: snapshot.modelled_cost_breakdown }),
    ...(snapshot.modelled_protective_exit_cost_breakdown === null
      ? {}
      : {
          modelled_protective_exit_cost_breakdown: snapshot.modelled_protective_exit_cost_breakdown,
        }),
  };

  try {
    await store.writeAheadPosition(position);
  } catch (error) {
    if (error instanceof DuplicatePositionError) {
      return result('deduped', idempotencyKey, now, {
        reason: 'an order or fill already exists for this idempotency_key',
      });
    }
    throw error;
  }

  let ack: Awaited<ReturnType<typeof broker.submitBracket>>;
  try {
    ack = await broker.submitBracket(bracket);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the `prices_own_fills` early return sits inside the quote-read branch and must return the FULL snapshot, not just a cost-model result — splitting quote and cost-model reads into helpers would strand that early return with no clean way to still short-circuit the whole function from inside it
async function readSubmitSnapshot(
  input: SubmitInput,
  order: OrderIntent,
  now: Date,
  decision_price: number | null,
): Promise<SubmitSnapshot> {
  let quoteBid: number | null = null;
  let quoteAsk: number | null = null;
  let quoteObservedAt: Date | null = null;
  let modelledCostBreakdown: CostBreakdown | null = null;
  let modelledProtectiveExitCostBreakdown: CostBreakdown | null = null;

  if (order.metadata.unpriced_exit !== true) {
    const { marketData, costModel, config, logger, trace_id } = input;

    try {
      const quote = await marketData.getQuote(order.instrument, now);
      if (quote !== null) {
        quoteBid = quote.bid;
        quoteAsk = quote.ask;
        quoteObservedAt = quote.observed_at;
      }
    } catch (error) {
      logCaughtFailure(
        logger,
        {
          trace_id,
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
    }

    if (input.broker.prices_own_fills === true) {
      safeLog(logger, {
        trace_id,
        stage: 'execution',
        level: 'info',
        message:
          '#1001: captureSubmitSnapshot skipped its own CostModel.fill on the Simulated-adapter ' +
          'path — the adapter prices this order itself and that breakdown is persisted directly ' +
          'onto the fill, so a second pricing here could only disagree with it.',
        payload: { idempotency_key: order.idempotency_key, instrument: order.instrument },
      });
      return {
        decision_price,
        quote_bid: quoteBid,
        quote_ask: quoteAsk,
        quote_mid: quoteBid === null || quoteAsk === null ? null : (quoteBid + quoteAsk) / 2,
        quote_observed_at: quoteObservedAt,
        modelled_cost_breakdown: null,
        modelled_protective_exit_cost_breakdown: null,
      };
    }

    try {
      const [mark, volatility, spread, adv] = await Promise.all([
        marketData.getMark(order.instrument, now),
        marketData.getIndicator(order.instrument, config.simulated.volatility_indicator, now),
        marketData.getSpreadEstimate(order.instrument, now),
        marketData.getADV(order.instrument, config.simulated.adv_window, now),
      ]);
      const marketState: MarketState = {
        mid: mark.price,
        spread,
        adv,
        volatility: volatility.value,
        asset_class: mark.asset_class,
        ...(config.simulated.venue === undefined ? {} : { venue: config.simulated.venue }),
        timestamp: mark.observed_at,
      };
      const fillRequest: FillRequest = {
        instrument: order.instrument,
        side: order.side,
        size: order.size,
        order_type: order.intent_type === 'exit' ? 'market' : 'limit',
        ...(order.intent_type === 'exit' ? {} : { limit_price: order.entry }),
        idempotency_key: order.idempotency_key,
      };
      const entryCost = costModel.fill(fillRequest, marketState).cost_breakdown;

      const protectiveExitCost =
        order.intent_type === 'exit'
          ? null
          : costModel.fill(
              {
                instrument: order.instrument,
                side: order.side === 'buy' ? 'sell' : 'buy',
                size: order.size,
                order_type: 'market',
                idempotency_key: order.idempotency_key,
              },
              marketState,
            ).cost_breakdown;

      modelledCostBreakdown = entryCost;
      modelledProtectiveExitCostBreakdown = protectiveExitCost;
    } catch (error) {
      logCaughtFailure(
        logger,
        {
          trace_id,
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
    }
  } else {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      level: 'info',
      message:
        '#1001: captureSubmitSnapshot skipped the quote/cost-model reads for an unpriced exit ' +
        '(order.metadata.unpriced_exit) — the feed was already known dark this tick, so ' +
        're-probing it here would only risk widening the #826 flatten window.',
      payload: { idempotency_key: order.idempotency_key, instrument: order.instrument },
    });
  }

  return {
    decision_price,
    quote_bid: quoteBid,
    quote_ask: quoteAsk,
    quote_mid: quoteBid === null || quoteAsk === null ? null : (quoteBid + quoteAsk) / 2,
    quote_observed_at: quoteObservedAt,
    modelled_cost_breakdown: modelledCostBreakdown,
    modelled_protective_exit_cost_breakdown: modelledProtectiveExitCostBreakdown,
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the four numbered steps above are ordered specifically to avoid the reverse-position hazard named above (cancel-before-flatten); splitting into helpers risks a cancel-then-submit reorder the compiler cannot tell apart from the safe version
async function executeExit(
  input: SubmitInput,
  order: OrderIntent,
  idempotencyKey: string,
  now: Date,
): Promise<ExecutionResult> {
  const { broker, store } = input;

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

  const overExited = perLotHeld.find((lot) => lot.held < 0);
  if (overExited !== undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' refused: lot '${overExited.idempotency_key}' ` +
        `records more closed quantity than it ever opened (held ${overExited.held})`,
    });
  }

  const heldSize = totalHeldQuantity(perLotHeld);

  const expectedClosingSide = heldSide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedClosingSide) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent side '${order.side}' does not match the closing side ` +
        `'${expectedClosingSide}' implied by the held lot(s)' side ('${heldSide}') for ` +
        `'${order.instrument}'`,
    });
  }

  if (order.size !== heldSize) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent size ${order.size} does not match the held quantity ${heldSize} ` +
        `for '${order.instrument}'`,
    });
  }

  if (order.metadata.lot_held_quantities !== undefined) {
    const recordedByKey = new Map(
      order.metadata.lot_held_quantities.map((lot) => [lot.idempotency_key, lot.held]),
    );
    const diverged = perLotHeld.find(
      (lot) => (recordedByKey.get(lot.idempotency_key) ?? 0) !== lot.held,
    );
    if (diverged !== undefined) {
      const recorded = recordedByKey.get(diverged.idempotency_key) ?? 0;
      return result('error', idempotencyKey, now, {
        reason:
          `exit intent for '${order.instrument}' refused: lot '${diverged.idempotency_key}' ` +
          `now holds ${diverged.held} but the intent recorded ${recorded} — the covered lot set ` +
          `has diverged since the Trader keyed this exit`,
      });
    }
  }

  if (order.metadata.exit_reason === undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' carries no metadata.exit_reason — every exit ` +
        `intent must name one (ExitReason, shared/types/records.ts)`,
    });
  }

  const snapshot = await captureSubmitSnapshot(input, order, now, EXIT_SNAPSHOT_BUDGET_MS);

  try {
    await store.writeAheadFlatten({
      idempotency_key: idempotencyKey,
      instrument: order.instrument,
      asset_class: order.asset_class,
      side: order.side,
      exit_reason: order.metadata.exit_reason,
      size: order.size,
      submitted_at: now,
      lot_held_quantities: perLotHeld,
      decision_price: snapshot.decision_price,
      quote_bid: snapshot.quote_bid,
      quote_ask: snapshot.quote_ask,
      quote_mid: snapshot.quote_mid,
      quote_observed_at: snapshot.quote_observed_at,
      modelled_cost_breakdown: snapshot.modelled_cost_breakdown,
    });
  } catch (error) {
    if (!(error instanceof UnresolvedFlattenForInstrumentError)) throw error;
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'flatten_refused_in_flight',
      level: 'warn',
      message:
        `executeExit: this exit (exit_reason '${order.metadata.exit_reason}') was refused ` +
        'because another flatten on this instrument is still unresolved — reported as ' +
        '`deduped`, which is NOT the same as "already flat": this lot is still held. The next ' +
        'tick in the #826 window retries, and the blocking row is bounded (reconcile.ts ' +
        'UNRESOLVABLE_FLATTEN_MAX_AGE_MS).',
      payload: {
        idempotency_key: idempotencyKey,
        instrument: order.instrument,
        blocking_key: error.blocking_key,
        exit_reason: order.metadata.exit_reason,
      },
    });
    return result('deduped', idempotencyKey, now, { reason: error.message });
  }

  const cancelledLots: OpenPosition[] = [];
  for (const lot of heldLots) {
    try {
      await broker.cancel(lot.idempotency_key, order.instrument);
      cancelledLots.push(lot);
    } catch (error) {
      const reason =
        `cancelling held lot '${lot.idempotency_key}' before the flatten failed, so the ` +
        `flatten was not sent: ${describeThrownSafely(error)}`;
      await markLotsUnprotected(input, cancelledLots, lot.idempotency_key, error, now);
      await store.resolveFlattenError(idempotencyKey, reason, now);
      return result('error', idempotencyKey, now, { reason });
    }
  }

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
