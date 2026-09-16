/**
 * Execution core — `execute()` (#82) and `ingestFills()` (#83).
 *
 * The thin, mechanical tail of the pipeline: Verdict has already decided, so
 * this re-decides nothing. Dedupe → expand the bracket → write-ahead →
 * submit → persist the ack → return; the fill lifecycle is advanced
 * separately by `ingestFills()`.
 */
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

  /** Delegated whole, so the fill lifecycle stays independently readable from `execute()`. */
  async ingestFills(): Promise<void> {
    return ingestFills(this.input);
  }

  /**
   * Delegated whole. Nothing here calls `reconcile()` on construction — a
   * restart is the caller's event to recognise, not the constructor's.
   */
  async reconcile(): Promise<ReconcileReport> {
    return reconcile(this.input);
  }

  /**
   * Delegated whole. The #549 sweep's standalone surface — `reconcile()`
   * above already includes a pass; this is what the fill-sync loop calls on cadence.
   */
  async sweepResidualProtection(): Promise<ResidualProtectionSweepResult> {
    return sweepResidualProtection(this.input);
  }

  /** Delegated whole, so a caller with only a `SubmitInput` (place-soak-position.ts) can call this directly. */
  async execute(verdict: VerdictDecision): Promise<ExecutionResult> {
    return executeVerdict(this.input, verdict);
  }
}

/** Acts only on a `go`; records the submission, does not block until filled */
export async function executeVerdict(
  input: SubmitInput,
  verdict: VerdictDecision,
): Promise<ExecutionResult> {
  const { clock, broker, store } = input;
  const now = clock.now();

  // Acts only on a `go`. A no_go carries no order to place.
  if (verdict.status !== 'go' || verdict.order === null) {
    return result('error', verdict.idempotency_key, now, {
      reason: `Execution.execute requires a 'go' VerdictDecision with a non-null order (got '${verdict.status}')`,
    });
  }

  const order = verdict.order;
  const idempotencyKey = order.idempotency_key;

  // Dedup layer 1 (local); layer 2 is the client order id at the broker.
  // #921: an exit gets a second chance via `resolveExitRetryKey` since a
  // flatten stuck at 'error' must not stand in for "closed" forever, unlike
  // entry/scale_in which dedupe unconditionally (#516 hazard otherwise).
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

  // An exit closes existing lot(s) via submitFlatten (#429) rather than
  // opening a bracket, so it writes no `OpenPosition`. Delegated to
  // `executeExit` — enough steps (cancel-before-flatten, store cross-check,
  // journal) that inlining would bury the bracket path below.
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

  // #1001: best-effort snapshot, read BEFORE the write-ahead so it lands in
  // the same durable row a crash-restart would recover. Unbounded here,
  // unlike the exit path — an entry is not racing the close.
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
    // #1014: omitted (not `null`) when absent, matching every other
    // optional snapshot field below.
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

  // Write-ahead: `pending` is durable BEFORE the broker call (#86), so a
  // crash leaves a record to reconcile rather than resubmitting blind. Only
  // `DuplicatePositionError` means dedup; any other store failure means the
  // write-ahead did NOT happen and must not be swallowed.
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
    // The `pending` record deliberately survives: only the broker can settle
    // whether the bracket landed (#86's reconcile adopts broker truth).
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

/**
 * Bound on `captureSubmitSnapshot`'s exit-path reads — well under #826's
 * ~30s single-read budget, so the feature's worst case stays small and
 * bounded on the mandatory flat-by-close path. No bound on the bracket (entry) path.
 */
const EXIT_SNAPSHOT_BUDGET_MS = 2_000;

/** The submit-time snapshot #1001 captures alongside every write-ahead. */
interface SubmitSnapshot {
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: CostBreakdown | null;
  modelled_protective_exit_cost_breakdown: CostBreakdown | null;
}

/**
 * #1001: best-effort snapshot of decision price, venue quote, and a modelled
 * cost breakdown (priced the way `SimulatedBrokerAdapter` prices a fill) at
 * submit time. Never throws or blocks an order; a stalled read degrades to
 * `null` within `budget_ms` (only `executeExit` passes one — see
 * `EXIT_SNAPSHOT_BUDGET_MS` — since it runs on the mandatory flat-by-close path).
 */
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
    // An uncleared `setTimeout` keeps the Node event loop alive
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * #1001: the price the INTENT was formed at. On entry/scale_in this is
 * `order.entry`. On an exit it's the last known mark at decide-time, except
 * the unpriced-flatten case (#826) where `null` is honest — persisting the
 * `0` placeholder would fake a 100%-divergence exit. Keyed on
 * `metadata.unpriced_exit`, not `entry === 0`, so a real zero isn't misread.
 */
function decisionPriceFor(order: OrderIntent): number | null {
  if (order.intent_type === 'exit' && order.metadata.unpriced_exit === true) return null;
  return order.entry;
}

/** The unbounded body of `captureSubmitSnapshot` — see there for the contract */
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

    // #1014: the Simulated adapter prices the SAME order moments later via
    // `CostModel.fill`, and that result is authoritative and persisted
    // verbatim — pricing again here risks disagreeing with it on any
    // non-determinism in the cost model. Skipped rather than shared, to keep
    // the simulation detail out of the live code path. Keyed on the declared
    // `prices_own_fills` capability, not `instanceof SimulatedBrokerAdapter`
    // (CLAUDE.md's Broker Plan).
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

      // #1301: the protective exit this submission arms, priced off this
      // same `marketState` (#1121 AC6 allows one derivation per priced
      // event). An exit has no protective leg to price. Assigned only once
      // BOTH have priced, so the pair is present or absent together.
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

/**
 * Bounds fresh keys a mandatory-flatten retry chain may burn.
 * `resolveExitRetryKey` only advances past a provably-dead attempt, so this
 * guards a persistently failing cancel loop, not genuine retries.
 */
const MAX_EXIT_RETRY_ATTEMPTS = 3;

/**
 * Finds a usable idempotency key for a retried exit: `baseKey`,
 * `${baseKey}:retry-1`, ... A candidate is usable if unused, or names a
 * RETRYABLE flatten error — any 'submitting'/'submitted' row stops the walk
 * immediately (#516 double-flatten hazard). Bounded by
 * `MAX_EXIT_RETRY_ATTEMPTS`; returns `null` once exhausted, never throws.
 */
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
    // else: candidate has a terminal row already — try the next suffix
  }
  return null;
}

/**
 * The `exit` branch of `execute()` (#508). Order matters: (1) cross-check
 * store-derived size/side rather than trust `buildExitIntent`, refusing
 * rather than clamping on mismatch; (2) journal to `flatten_submissions`
 * before any broker call, also refusing a second flatten on the same
 * instrument (#1214); (3) cancel the held bracket BEFORE flattening —
 * `submitFlatten` never touches stop/target, so flattening first risks
 * opening a reverse position when a leg fires late; (4) submit, then
 * resolve the journal row.
 */
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

  // #568: what the venue still holds — filled_size minus exit-leg fills
  // already recorded, not the entry quantity. Same derivation `buildExitIntent` used.
  const perLotHeld = await heldQuantitiesFor(heldLots, (keys) => store.getExitFillSizes(keys));

  // Fail closed per lot, before summing: a negative here means the store
  // contradicts itself and could net against a sibling into a
  // plausible-looking total. Not ADR-0005's `coversQty` tolerance — a lot
  // within that epsilon is already `closed` and off `getOpenPositions()`.
  const overExited = perLotHeld.find((lot) => lot.held < 0);
  if (overExited !== undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' refused: lot '${overExited.idempotency_key}' ` +
        `records more closed quantity than it ever opened (held ${overExited.held})`,
    });
  }

  const heldSize = totalHeldQuantity(perLotHeld);

  // The closing side is the opposite of what is held — same derivation `buildExitIntent` uses
  const expectedClosingSide = heldSide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedClosingSide) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent side '${order.side}' does not match the closing side ` +
        `'${expectedClosingSide}' implied by the held lot(s)' side ('${heldSide}') for ` +
        `'${order.instrument}'`,
    });
  }

  // Exact equality, not a tolerance: `heldSize` uses the SAME derivation
  // `buildExitIntent` used (#568), so drift here means a fill genuinely
  // landed between decide-time and now — which must be refused, not
  // smoothed over with ADR-0005's summation-order epsilon.
  if (order.size !== heldSize) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent size ${order.size} does not match the held quantity ${heldSize} ` +
        `for '${order.instrument}'`,
    });
  }

  // #1497: the total check above can't see a compensating swap between two
  // lots (one up, one down) since the sums still agree. `lot_held_quantities`
  // is `buildFlattenExit`'s own per-lot snapshot, compared lot-by-lot here. A
  // lot missing from the snapshot reads as 0 (hadn't opened yet at
  // decide-time); a lot appearing after decide-time isn't visible to this
  // loop but moves `heldSize`, so the total check above already catches it.
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

  // #793: every exit intent carries `metadata.exit_reason` via
  // `buildFlattenExit` — its absence means some other path built this order
  // without going through it, worth refusing loudly rather than guessing.
  if (order.metadata.exit_reason === undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' carries no metadata.exit_reason — every exit ` +
        `intent must name one (ExitReason, shared/types/records.ts)`,
    });
  }

  // #1001: best-effort snapshot, same reasoning as the bracket path but
  // BOUNDED — the budget is carved out of the #826 flatten window.
  const snapshot = await captureSubmitSnapshot(input, order, now, EXIT_SNAPSHOT_BUDGET_MS);

  // Write-ahead before any broker call. `writeAheadFlatten` throwing a
  // genuine store failure is NOT caught — only `UnresolvedFlattenForInstrumentError`
  // is, which means #1214's other-submitter race, refused atomically and
  // placed here (above the cancel loop) so a refusal destroys no protective legs.
  try {
    await store.writeAheadFlatten({
      idempotency_key: idempotencyKey,
      instrument: order.instrument,
      asset_class: order.asset_class,
      side: order.side,
      // #793: threaded to `closed_trades.close_reason` via `flatten_submissions.exit_reason`
      exit_reason: order.metadata.exit_reason,
      size: order.size,
      submitted_at: now,
      // Which lots this closes and what each holds, so `ingestFills()` can
      // split the fill without re-deriving (migrations 0020/0021).
      // `perLotHeld` preserves `getOpenPositions()`'s order for
      // oldest-lot-first allocation. A lot holding nothing is still named so
      // its legs get re-armed (#525).
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
    // `deduped`, not `error`: another submitter is already closing this
    // instrument, so flat-by-close is being served by it. Instrument-scoped
    // (not lot-scoped) since `UnresolvedFlattenSubmission` carries no lot
    // identity — narrowing further risks the #516 reversal.
    //
    // #1214 round 2: status stays `deduped` (exhaustively switched
    // elsewhere) but gets its own warn line so an operator can tell a
    // REFUSED exit from an ordinary "already flat" one.
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

  // Lots this loop has already cancelled successfully, in order — load-bearing for the catch below
  const cancelledLots: OpenPosition[] = [];
  for (const lot of heldLots) {
    try {
      await broker.cancel(lot.idempotency_key, order.instrument);
      cancelledLots.push(lot);
    } catch (error) {
      // No `submitFlatten` was issued, so nothing exists for reconcile to
      // adopt — the row resolves to 'error' immediately. Not guaranteed: an
      // earlier lot's cancel may have landed while its response was lost.
      // Lots PROVABLY naked (cancel confirmed, flatten not sent) get #549's
      // durable marker; the failing lot itself is left unmarked since its
      // legs may still be live (re-arming would double-protect, #516).
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
    // Genuinely ambiguous — the venue may have seen this before the response
    // was lost — so left at 'submitting' for #86's reconcile to resolve,
    // same posture as the bracket path's `submitBracket` failure.
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

/**
 * #867: record the diagnostic and mark every lot this exit stripped of its
 * protective legs before the cancel loop failed (#549's durable marker,
 * already consumed by `sweepResidualProtection`). Never throws — a lost
 * marker write must not also lose the caller's honest error. The broker's
 * error text goes to the logger only, never an alert payload (credentials risk).
 */
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
    // Defaults suit the paths that wrote nothing; callers that did reach the
    // store or the broker override with what actually happened
    order_state: null,
    reason: null,
    timestamp: now,
    ...overrides,
  };
}
