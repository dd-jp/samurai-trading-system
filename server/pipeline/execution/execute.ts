/**
 * Execution core — `execute()` (ticket #82) and the `ingestFills()` entry
 * point (#83). See docs/specs/execution-spec.md ("Module: Execution Core").
 *
 * The thin, mechanical tail of the pipeline: Verdict has already decided, so
 * this re-decides nothing. Dedupe → expand the abstract bracket → write-ahead
 * → submit → persist the ack → return. It records a submission; it does not
 * block until filled — the lot's lifecycle is advanced separately by
 * `ingestFills()`, which lives in its own module.
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

  /**
   * The second surface, delegated whole: the fill lifecycle shares only the
   * injected dependencies with `execute()`, so keeping it out of this class's
   * body keeps the two surfaces independently readable.
   */
  async ingestFills(): Promise<void> {
    return ingestFills(this.input);
  }

  /**
   * Delegated whole for the same reason as `ingestFills()`. Note what this
   * class does NOT do: nothing here calls `reconcile()` on construction. A
   * restart is the caller's event to recognise, not something a constructor
   * can infer, and reconciling implicitly would fire a broker sweep every
   * time anything built an Execution.
   */
  async reconcile(): Promise<ReconcileReport> {
    return reconcile(this.input);
  }

  /**
   * Delegated whole, same as its siblings. The #549 sweep's standalone
   * surface — `reconcile()` above already includes a pass; this is what the
   * fill-sync loop calls on cadence (see `Execution.sweepResidualProtection`'s
   * doc for why both wirings exist).
   */
  async sweepResidualProtection(): Promise<ResidualProtectionSweepResult> {
    return sweepResidualProtection(this.input);
  }

  /**
   * Delegated whole like its siblings, so a caller that only submits (the
   * soak probe, tools/place-soak-position.ts) can hand `executeVerdict` a
   * `SubmitInput` instead of building the full bag.
   */
  async execute(verdict: VerdictDecision): Promise<ExecutionResult> {
    return executeVerdict(this.input, verdict);
  }
}

/** Acts only on a `go`; records the submission, does not block until filled. */
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

  // Dedup layer 1 (local): a key already in the store means this decision
  // was acted on before — a crash-restart or retry replaying the same bar.
  // Never reaches the broker. Layer 2 is the client order id below. Checked
  // ahead of the intent_type branch so entry, scale_in AND exit share one
  // gate, rather than the exit branch running its own copy of this check.
  //
  // #921: an exit is the one intent type that gets a SECOND chance here.
  // Entry/scale_in dedupe unconditionally — a replayed entry decision must
  // never re-submit under any key, fresh or otherwise, because the original
  // bracket (if it landed) is still exactly what was wanted. A mandatory
  // flatten is different: it is the flat-by-close guarantee, so a prior
  // attempt the venue will never fill (`resolveFlattenError`'s 'error'
  // status) must not be allowed to stand in for "the position is closed"
  // forever. `resolveExitRetryKey` walks to a fresh key ONLY over a row in
  // that terminal state; every other case (no row, or a
  // 'submitting'/'submitted' row whose venue truth is unknown or already
  // succeeded) falls through to the same unconditional dedup entry/scale_in
  // gets, because retrying either of those risks the #516 double-flatten /
  // reverse-position hazard.
  //
  // Two of the three ways into 'error' are proof (the cancel loop failed
  // before submit; the venue terminally refused it having filled nothing).
  // #1214 review round 2 added a third that is NOT — a row forced terminal
  // after `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` of the venue denying the order
  // exists — so this walk can now re-arm over a flatten that may still be
  // live. That is argued at the constant (reconcile.ts), not here; what
  // matters at this call site is that the walk stays bounded by
  // `MAX_EXIT_RETRY_ATTEMPTS` either way.
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
  // opening a bracketed one, so it has neither a bracket to expand nor an
  // OpenPosition to write ahead — `OpenPosition.intent_type` deliberately
  // excludes 'exit' ("exits close a lot; they never create one",
  // shared/types/records.ts). Delegated to its own function: validating
  // against the store, cancelling the held lot's bracket, journalling the
  // flatten and submitting it is enough steps that inlining them here
  // would bury the bracket path below in an unrelated branch. See
  // `executeExit`'s doc for why each of those steps — cancel-before-flatten,
  // the store cross-check, and the `flatten_submissions` journal — exists.
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

  // #1001: best-effort snapshot — see `captureSubmitSnapshot`'s doc. Read
  // BEFORE the write-ahead so the snapshot lands in the same durable row a
  // crash-restart would recover, not bolted on after the fact. Deliberately
  // UNBOUNDED here, unlike the exit path: an entry is not racing the close.
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
    // #1014: omitted (not `null`) when there is none, matching every
    // other optional snapshot field below. `decisionPriceFor` only ever
    // returns null on the unpriced-exit path, which never reaches here —
    // an exit builds no `OpenPosition` — but the type is honest about it
    // rather than asserting a value the function does not promise.
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
  };

  // Write-ahead: `pending` is durable BEFORE the broker call, so a crash in
  // the gap leaves a record to reconcile against the broker (#86) instead
  // of an invisible order that a restart would submit a second time.
  //
  // The `findByKey` gate above is check-then-act, so two callers replaying
  // the same decision can both pass it before either has written. The
  // primary key is what actually settles that race — and it settles it in
  // the store, meaning the loser learns it lost by catching this. Reporting
  // that as `error` would be wrong twice over: nothing failed, and a caller
  // that retries on error would keep re-losing the same race. Only the
  // typed duplicate is treated as dedup; every other store failure means
  // the write-ahead did NOT happen, and swallowing it would let the broker
  // call proceed with no durable record behind it.
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
    // The `pending` record deliberately survives: whether the bracket
    // landed is unknown here, and only the broker can settle that. #86's
    // reconciliation adopts broker truth. Marking it terminal on the way
    // out would be a guess, and the losing guess double-submits.
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
 * The whole latency budget #1001's submit-time snapshot may spend on the EXIT
 * path, where `executeExit` is running the mandatory flat-by-close flatten.
 *
 * Two seconds, deliberately an order of magnitude under the ~30s single-read
 * budget #826 (verdict/index.ts) already judged too expensive to pay in this
 * window — the point is that the feature's worst-case contribution to the time
 * before a flatten reaches the broker stays small and BOUNDED, not that a slow
 * feed still gets its sample in. A healthy quote read returns in tens of
 * milliseconds, so this never binds in the normal case.
 *
 * There is no matching bound on the bracket (entry) path: nothing there is
 * racing a session close, and an entry that arrives late is an entry not
 * taken, not a position left open overnight.
 */
const EXIT_SNAPSHOT_BUDGET_MS = 2_000;

/**
 * The submit-time snapshot #1001 captures alongside every write-ahead —
 * `decision_price` plus a best-effort quote and modelled cost breakdown. See
 * `captureSubmitSnapshot` below for how each field is produced.
 */
interface SubmitSnapshot {
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: CostBreakdown | null;
}

/**
 * #1001: what the system believed immediately before submitting an order —
 * the price the Trader's decision was formed at, the venue's own bid/ask (if
 * the instrument's data source quotes one), and a modelled cost breakdown
 * priced the same way the Simulated adapter prices one
 * (`SimulatedBrokerAdapter.buildMarketState` + `CostModel.fill`), so a
 * real-broker fill has something honest to diff its realized price against.
 *
 * BEST-EFFORT — this is instrumentation, not a trading decision.
 * `decision_price` alone needs no I/O (`order.entry` is already in hand), so
 * it is always populated; the quote and cost-model reads are each wrapped in
 * their OWN try/catch, independently, so a failure in one does not cost the
 * other. Every failure degrades to `null` and is logged, never thrown: no
 * read here may refuse an order. The reads are skipped entirely when
 * `order.metadata.unpriced_exit` is set: that flag already means the feed was
 * dark THIS tick (`readExitPrice`, trader/decide.ts) — re-probing it here
 * would only be a second chance for the same feed to hang, inside the one
 * window (#826) a hang must never widen.
 *
 * This IS blocking: these reads are `await`ed inline before the caller's
 * write-ahead, and every one of them routes through `fetchWithTimeout` (10s
 * per attempt) under `withRetry` (3 attempts), so a stalled feed costs roughly
 * 30s on the quote read and another ~30s on the `Promise.all` cost-model
 * group. On the bracket (entry) path that is tolerable: nothing there is
 * racing a session close. On the EXIT path it is not — `executeExit` runs the
 * mandatory flat-by-close flatten, and #826's own reasoning (verdict/index.ts)
 * treats ONE ~30s stalled read as a cost worth deliberately refusing "on the
 * tick that is trying to get flat before the close". Unbounded, this function
 * would pay two such budgets there, doubling the exposure #826 exists to
 * prevent.
 *
 * So `budget_ms` bounds the WHOLE capture, and `executeExit` is the only
 * caller that passes one (`EXIT_SNAPSHOT_BUDGET_MS`). The deadline RESOLVES to
 * the all-null snapshot rather than rejecting, so `decision_price` — the field
 * the #1001 acceptance query actually needs and the only one costing no I/O —
 * survives a stall intact. What a stall costs is the `quote_bid/ask/mid` and
 * `modelled_cost_breakdown` sample for that one exit. That is the same trade
 * #826 already made (it declines to re-read the mark at all), not a regression
 * against it: an instrumentation sample is never worth widening the window in
 * which a position can be left open overnight.
 *
 * A timed-out read keeps running in the background — there is no `AbortSignal`
 * on the `MarketDataService` port to cancel it with — but it has no side
 * effects and its late result is simply discarded, exactly as
 * `AnalystOrchestrator.withTimeout` handles the same situation.
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
    // An uncleared `setTimeout` keeps the Node event loop alive — in a
    // cadence-driven process that is a run which will not exit.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * #1001: the price the trading INTENT was formed at — which is not the same
 * thing as `order.entry` on every path. Persisting it unconditionally would
 * put a fake number on the money path (#1014).
 *
 * On an entry/scale_in, `order.entry` IS the decision price: the Trader
 * computed it from the mark it decided on, and it is the limit actually
 * submitted.
 *
 * On an EXIT it is subtler. `decide.ts`'s exit branch sets
 * `entry`/`stop`/`target` all three to `readExitPrice`'s result, and the
 * flatten-path tests rightly call that triple "degenerate placeholders" — as
 * a BRACKET it is meaningless (nothing consults it; `executeExit` submits a
 * market flatten sized to the held quantity). But the VALUE is not fake in
 * the priced case: it is the last known mark, read at the moment the exit was
 * decided — the honest substitute for a decision price an exit never had.
 *
 * The one genuinely fake case is the UNPRICED flatten (#826): `readExitPrice`
 * returns `price: 0` when the feed is dark, because a flatten is mandatory and
 * must proceed without a mark. Persisting that `0` would hand the Feedback
 * Loop's live-vs-modelled divergence check a 100%-divergence exit for every
 * dark-feed flatten — noise indistinguishable from a catastrophic fill. `null`
 * is the honest record there: no price was known, so none is claimed.
 *
 * Keyed on `metadata.unpriced_exit` rather than `entry === 0`, so a real mark
 * that happens to be zero is not misread as absence and vice versa — the flag
 * is `readExitPrice`'s own declaration of which case it took.
 */
function decisionPriceFor(order: OrderIntent): number | null {
  if (order.intent_type === 'exit' && order.metadata.unpriced_exit === true) return null;
  return order.entry;
}

/** The unbounded body of `captureSubmitSnapshot` — see there for the contract. */
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

    // #1014: the Simulated adapter prices the SAME order
    // with the SAME `CostModel.fill` moments later, and that call is the
    // authoritative one — its result becomes the fill's own price, qty, fee
    // AND `NormalizedFill.cost_breakdown`, which `toFill` /
    // `redistributeOneFlatten` (ingest-fills.ts) then persist verbatim, never
    // reaching this snapshot's fallback (both apply ONLY when
    // `fill.cost_breakdown === undefined`, which a Simulated fill never is).
    // So on that path a second pricing here buys nothing and risks something:
    // any non-determinism in the cost model — a random slippage draw, a
    // clock-sensitive market state, a stateful test double — would make
    // `modelled_cost_breakdown_json` disagree with the
    // `fills.cost_breakdown_json` it is supposed to be the estimate FOR, and
    // the #1001 acceptance query would then compare two different draws and
    // report the difference as realised divergence.
    //
    // SKIPPED rather than shared: sharing one `FillResult` across the
    // execute→adapter boundary would mean either handing the adapter a
    // pre-priced fill (it is the venue; it must price its own) or reaching
    // into it from here — both put a simulation detail into the code path
    // live takes. Skipping keeps the boundary intact and leaves the simulated
    // path with exactly ONE pricing.
    //
    // The quote read above is NOT skipped: nothing else captures a bid/ask on
    // this path, and it has no second writer to disagree with.
    // Keyed on the DECLARED capability, not `instanceof SimulatedBrokerAdapter`:
    // "strategy code must not know which broker it's talking to" (CLAUDE.md's
    // Broker Plan), and any future self-pricing adapter opts in the same way.
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
      modelledCostBreakdown = costModel.fill(fillRequest, marketState).cost_breakdown;
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
  };
}

/**
 * Bounds how many fresh keys a single mandatory-flatten retry chain may burn
 * across the flatten window. `resolveExitRetryKey` only ever advances past a
 * PROVABLY-dead attempt (`isRetryableFlattenError`), so this is not a limit
 * on how many times the exit is allowed to genuinely fail — it exists so a
 * persistently failing cancel loop (e.g. the venue itself is unreachable)
 * cannot hammer it with a fresh clientOrderId every tick of the flatten
 * window forever. Once exhausted, `execute()` falls back to `deduped` — the
 * safe default for a mandatory exit that has demonstrably not been going
 * through — rather than retrying unbounded.
 */
const MAX_EXIT_RETRY_ATTEMPTS = 3;

/**
 * Finds a usable idempotency key for a retried exit, given `baseKey` — the
 * order's own deterministic key (`idempotency-key.ts`), unchanged across
 * retries of the same bar's mandatory flatten. Walks `baseKey`,
 * `${baseKey}:retry-1`, `${baseKey}:retry-2`, ... (mirrors the
 * `${clientOrderId}:rearm` convention `rearmProtectiveLegs` already uses in
 * the Alpaca adapter for "a fresh id derived from, but distinct from, the
 * original").
 *
 * A candidate is usable if it names NOTHING in the store yet, or names a
 * flatten row that is a RETRYABLE error (`isRetryableFlattenError`) — a
 * 'submitting'/'submitted' row at ANY candidate is not usable and stops the
 * walk immediately, because a genuinely ambiguous or already-succeeded
 * attempt must never be retried out from under (#516's reverse-position
 * hazard runs both directions: retrying over an unresolved or successful
 * attempt risks a double flatten just as surely as skipping the cancel loop
 * does). Bounded at `MAX_EXIT_RETRY_ATTEMPTS` so a persistently failing
 * cancel loop cannot hammer the venue every tick of the flatten window;
 * returns `null` once exhausted, and the caller falls back to `deduped`, the
 * safe default. Never throws, and never loops unbounded.
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
    // else: candidate names a retryable error — loop tries the NEXT suffix,
    // since this exact candidate key already has a terminal row and must not
    // be written to twice.
  }
  return null;
}

/**
 * The `exit` branch of `execute()` (#508). Four steps, in this order, each
 * enforcing an invariant a different ordering or omission would break:
 *
 * 1. **Cross-check against the store.** `execute()` holds the store and is
 *    the last checkpoint before funds move, so it does not forward
 *    `order.size`/`order.side` to the venue purely on trust that
 *    `buildExitIntent` (trader/decide.ts) summed the held quantity and
 *    derived the closing side correctly. It refuses on any mismatch rather
 *    than clamping — a wrong-sized exit is a bug to surface, not to
 *    silently correct into something smaller/safer-looking.
 * 2. **Journal the attempt** — write-ahead to `flatten_submissions` BEFORE
 *    any broker call, mirroring the bracket path's `writeAheadPosition`. An
 *    exit has no bracket and no `OpenPosition` to write ahead, so without
 *    this row a replay of the same decision sailed past `findByKey` every
 *    time, and a `submitFlatten` response lost to a timeout left no durable
 *    clientOrderId for #86's reconcile to resolve against. That write is also
 *    what refuses this flatten while ANOTHER is still unresolved on the
 *    instrument (#1214's review — `reflattenResidual` is a second submitter
 *    this function's `getOpenPositions()` sizing cannot see); see the call
 *    site's comment.
 * 3. **Cancel the held lot's bracket before flattening.** `submitFlatten` is
 *    a plain, unrelated market order — it does not touch the held lot's
 *    stop/target legs (confirmed against the Alpaca adapter: `cancel()` is
 *    the only path that reaches `cancelOrder`; `submitFlatten` never does).
 *    Left alone, those legs stay live and working at the venue after the
 *    flatten fills, and the next one to fire does not "close" anything —
 *    the position is already flat, so it OPENS A REVERSE POSITION instead.
 *    Cancelling first removes that resting order entirely; the alternative
 *    order (flatten, then cancel) leaves a real window where a leg can fire
 *    into the now-flat position before the cancel lands. If a cancel fails,
 *    the flatten is refused outright: a market order sent while it is
 *    unknown whether the legs it was meant to clear are actually gone would
 *    defeat the whole point of cancelling first. That refusal is never
 *    silent — see the cancel loop's own comment for what a `cancel()` throw
 *    does and does not guarantee, and for the lots this path marks
 *    unprotected so the #549 sweep re-arms them.
 * 4. **Submit, then resolve the journal row.**
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

  // #568: what the VENUE still holds — `filled_size` minus the exit-leg fills
  // already recorded — not the lot's entry quantity, which no exit fill
  // reduces and which a partially-flattened (still open) lot therefore keeps
  // at its original value. The SAME derivation `buildExitIntent` sized this
  // order with, so the guard below compares two answers to one question.
  const perLotHeld = await heldQuantitiesFor(heldLots, (keys) => store.getExitFillSizes(keys));

  // Fail closed, per lot, BEFORE summing: more closed than ever opened on one
  // lot is the store's own record contradicting itself, and a negative there
  // would net against a positive on a sibling lot into a total that looks
  // plausible and is not. `execute()` is the last checkpoint before funds
  // move, so it refuses and names the lot rather than trading on the sum.
  //
  // A bare `< 0`, not ADR-0005's `coversQty` tolerance (shared/held-quantity.ts), and that is not an
  // oversight: a lot whose exit fills merely APPROACH its filled size is
  // marked `closed` by `ingestFills()` (`isFlat`) and
  // so has already left `getOpenPositions()`. Every lot reaching this line
  // therefore holds a residual comfortably outside that epsilon, and a
  // negative here is a real contradiction rather than summation noise.
  const overExited = perLotHeld.find((lot) => lot.held < 0);
  if (overExited !== undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' refused: lot '${overExited.idempotency_key}' ` +
        `records more closed quantity than it ever opened (held ${overExited.held})`,
    });
  }

  const heldSize = totalHeldQuantity(perLotHeld);

  // The closing side is the OPPOSITE of what is held — same derivation
  // `buildExitIntent` uses, re-run here rather than trusted from the order.
  const expectedClosingSide = heldSide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedClosingSide) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent side '${order.side}' does not match the closing side ` +
        `'${expectedClosingSide}' implied by the held lot(s)' side ('${heldSide}') for ` +
        `'${order.instrument}'`,
    });
  }

  // Exact equality, not a tolerance: `heldSize` is the SAME `heldQuantities`
  // derivation over the SAME `ORDER BY opened_at` query and the SAME
  // exit-fill sums `buildExitIntent` used (#568), so the two totals
  // are bit-identical unless a fill genuinely landed between decide-time and
  // here — which is precisely the drift that must be refused, not smoothed
  // over with an epsilon built for a different problem (ADR-0005's tolerance
  // in ingest-fills.ts absorbs float SUMMATION-ORDER noise across two
  // reconstructions of the same total; this is a check that the total
  // itself has not moved).
  if (order.size !== heldSize) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent size ${order.size} does not match the held quantity ${heldSize} ` +
        `for '${order.instrument}'`,
    });
  }

  // #1497: the TOTAL check above cannot see a compensating swap — one lot's
  // held quantity up, a sibling's down by the same amount, between the
  // Trader's read (`buildFlattenExit`) and this one — because the two totals
  // still agree even though the covered lot SET has silently changed underneath
  // the intent. `lot_held_quantities` is `buildFlattenExit`'s own per-lot
  // snapshot of what it keyed the exit against (OrderIntentMetadata doc), so
  // when present it is compared lot by lot against `perLotHeld`, independent of
  // the total.
  //
  // Exact `!==`, for a stronger reason than the total check's: each side of
  // this comparison is one subtraction (`filled_size` minus that lot's own
  // exit-fill sum) for ONE lot, so there is no summation order across lots to
  // differ — unlike the total, which sums every lot's residual and so leans on
  // the "same derivation, same query order" argument above it.
  //
  // Only the intent's NAMED lots are iterated; a lot missing from the snapshot
  // reads as 0 held then, which is right for a lot that had not opened yet at
  // decide-time. A lot that appeared AFTER decide-time (not named at all) is
  // not visible to this loop, but it moves `heldSize`, so the total check
  // above already refuses it — the two checks are complete between them, and
  // this one adds nothing that would duplicate that refusal.
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

  // #793: every exit intent carries `metadata.exit_reason` —
  // `buildFlattenExit` (trader/decide.ts) requires the argument, so its
  // absence here means SOME other path constructed an `intent_type: 'exit'`
  // order without going through it. That is a contract violation worth
  // refusing loudly, not defaulting past: a silently-guessed reason would
  // corrupt `flatten_submissions.exit_reason` and, downstream,
  // `closed_trades.close_reason` on the money path.
  if (order.metadata.exit_reason === undefined) {
    return result('error', idempotencyKey, now, {
      reason:
        `exit intent for '${order.instrument}' carries no metadata.exit_reason — every exit ` +
        `intent must name one (ExitReason, shared/types/records.ts)`,
    });
  }

  // #1001: best-effort snapshot — see `captureSubmitSnapshot`'s doc. Read
  // BEFORE the write-ahead, same reasoning as the bracket path, but BOUNDED
  // here: this is the mandatory flat-by-close path, and the budget is carved
  // out of the #826 flatten window rather than added to it.
  const snapshot = await captureSubmitSnapshot(input, order, now, EXIT_SNAPSHOT_BUDGET_MS);

  // Write-ahead BEFORE any broker call — see the docstring above for why
  // this row exists at all. `writeAheadFlatten` throwing (a genuine store
  // failure, not the duplicate case — `findByKey` above already excludes
  // that) is deliberately NOT caught here: swallowing it would let the
  // cancel/flatten calls below proceed with no durable record behind them,
  // the exact failure `writeAheadPosition`'s catch in the bracket path above
  // guards against.
  //
  // The ONE refusal that is caught: #1214's review found this path could
  // submit a second market order over a re-flatten `reflattenResidual` had
  // already sent on the same lot. This function sizes purely from
  // `getOpenPositions()` minus `getExitFillSizes` — an in-flight flatten whose
  // fills have not landed is invisible to both — so it cannot see the other
  // submitter, and the two run on independent timers. `writeAheadFlatten`
  // refuses atomically instead (see its `SharedStore` doc), and it is placed
  // HERE, above the cancel loop, so a refusal destroys no protective legs: the
  // lot is left exactly as it was, still bracketed, with the other flatten
  // working.
  try {
    await store.writeAheadFlatten({
      idempotency_key: idempotencyKey,
      instrument: order.instrument,
      asset_class: order.asset_class,
      side: order.side,
      // #793: threaded through to `closed_trades.close_reason` via
      // `flatten_submissions.exit_reason` — see `redistributeOneFlatten`.
      exit_reason: order.metadata.exit_reason,
      size: order.size,
      submitted_at: now,
      // Which lots this flatten closes AND what each of them holds, so
      // `ingestFills()` can attribute and SPLIT the fill without re-deriving
      // either from whatever is still open when it lands (migrations 0020 and
      // 0021 carry both arguments). `perLotHeld` is `heldLots` mapped
      // one-to-one, preserving `getOpenPositions()`'s `ORDER BY opened_at`,
      // which the split relies on to allocate a partial fill oldest-lot-first.
      //
      // A lot holding NOTHING — its entry fill has not landed — is still named.
      // The cancel loop below iterates `heldLots` regardless of this journal, so
      // its protective legs go either way; dropping it here would remove the
      // only thing that re-arms them (#525). Its share is then exactly zero.
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
    // `deduped`, not `error`: something IS already closing this instrument, so
    // the flat-by-close intent is being served — by the other submitter's
    // order, not by a failure of this one. The next tick in the #826 window
    // re-runs this whole function, and the flatten proceeds as soon as the
    // in-flight row resolves (its fills swept, or reconcile settling it —
    // including the terminal-non-fill case #1214's review closed, which is
    // what keeps this refusal from being permanent).
    //
    // The refusal is INSTRUMENT-scoped while a residual re-flatten closes one
    // lot's remainder, so a sibling lot on the same instrument waits for that
    // row too. Deliberate: `UnresolvedFlattenSubmission` carries no lot
    // identity to narrow it by, and the narrower alternative is the
    // two-submitters-one-instrument reversal #516 exists to prevent.
    //
    // #1214 review round 2: the STATUS stays `deduped` but the outcome is not
    // the same as the ordinary "already flat" dedup, so it gets its own warn
    // line rather than its own status value. A status is the wrong carrier —
    // `ExecutionResult['status']` is exhaustively switched by the verdict
    // recorder, the dashboard and the feedback loop, and none of them has a
    // decision to make that differs here — whereas the thing an operator
    // actually needs is to be able to tell, in the log, an exit that was
    // REFUSED from one that had nothing to do. The message stays reason-
    // agnostic because this path serves every exit reason, not just the
    // mandatory flatten: `direction_flip` and the decay/early-exit release
    // reach `executeExit` too, and #1389's Trader-level in-flight guard covers
    // only the flatten reason. `exit_reason` in the payload names which one.
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

  // Lots this loop has ALREADY cancelled successfully, in order. Load-bearing
  // for the catch below, which is the only thing that reads it.
  const cancelledLots: OpenPosition[] = [];
  for (const lot of heldLots) {
    try {
      await broker.cancel(lot.idempotency_key, order.instrument);
      cancelledLots.push(lot);
    } catch (error) {
      // WHAT IS GUARANTEED HERE: no `submitFlatten` was issued, so — unlike
      // the `submitFlatten` failure below — no order exists under this
      // idempotency key for reconcile to adopt, and the row resolves to
      // 'error' immediately rather than sitting at 'submitting' for a sweep
      // that would find nothing.
      //
      // WHAT IS NOT GUARANTEED: that the broker was not reached, or that the
      // lots' protective legs survived. Two ways they may not have:
      // an EARLIER lot in this loop whose cancel returned successfully has
      // provably lost its stop and target, and even the FAILING lot's cancel
      // may have landed at the venue with only its response lost. Refusing
      // the flatten is still the right call — `cancel()` is ordered so that
      // its throw usually means nothing was destroyed (#867, see its doc), and
      // flattening while a protective leg may still be working is the #516
      // reverse-position hazard this whole cancel-first design exists to
      // prevent — but "refuse" must not also mean "say nothing".
      //
      // So the lots that are PROVABLY naked (cancel confirmed, flatten not
      // sent) get #549's durable marker, which is not a new mechanism: the
      // `sweepResidualProtection` pass the fill-sync loop already runs on
      // cadence picks the marker up, recomputes the residual from the fill
      // record (full held size here, since no exit fill landed) and re-arms
      // the lot's stop/target — and pages `ResidualExposureAlertChannel` if
      // it cannot. The failing lot itself is deliberately NOT marked: its
      // legs may still be live, and re-arming over a live bracket is
      // double protection, i.e. #516 from the other direction.
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
    // was lost — so the row is left at 'submitting' rather than resolved to
    // 'error', exactly as the bracket path leaves its `pending` record on a
    // `submitBracket` failure: only the broker can settle this, via #86's
    // `reconcile()` calling `getOrder` against the clientOrderId this row
    // journalled. Automatic resolution is filed as follow-up, not built
    // here — this PR's job was making the row exist to resolve against.
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
 * #867's escalation for a refused exit: record the LOCAL diagnostic and mark
 * every lot this exit already stripped of its protective legs before the
 * cancel loop failed, so the state is visible to something that acts on it
 * rather than only to a `flatten_submissions` row nobody watches.
 *
 * `markResidualUnprotected` is #549's existing durable marker, and the
 * consumer already runs: `sweepResidualProtection` (wired into the fill-sync
 * loop and into `reconcile()`) reads `getUnprotectedResidualLots()`,
 * recomputes the residual from the persisted fill record — for a lot this
 * path marks that is the FULL held quantity, since no exit fill has landed —
 * re-arms the stop/target through `broker.rearmProtectiveLegs`, and pages
 * `ResidualExposureAlertChannel` if it cannot. Nothing new is invented here;
 * this path just stops being the one hole that fed it nothing.
 *
 * Never throws, and never replaces the caller's `reason`: every write is
 * best-effort in the same shape as `bestEffortMarkerWrite` (ingest-fills.ts),
 * because losing recovery bookkeeping must not also lose the honest error the
 * caller is about to return.
 *
 * The broker's error text goes to the LOGGER only — `logCaughtFailure`
 * sanitizes it — never into an alert payload (`ResidualExposureAlert`'s
 * CREDENTIALS note: an Alpaca REST error quotes the failed request, headers
 * included).
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
    // store or the broker override with what actually happened.
    order_state: null,
    reason: null,
    timestamp: now,
    ...overrides,
  };
}
