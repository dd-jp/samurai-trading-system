/**
 * Production Composition Root: Debate adapter (#235, ADR-0004 §3).
 * `buildDebatePersonas` bridges `runDebate`'s ports to `personas.ts`'s
 * functions — no other production code implements
 * `DebaterPersona`/`MediatorPersona`. `confidence` passes the mediator's own
 * `stance` as `computeConvictionScore`'s third argument (#625's fix):
 * without it conviction was a pure function of the analyst views the debate
 * could never move. `position` is templated from `direction` + `rationale`
 * since no persona produces one distinct from its rationale; `Trader.decide()`
 * never reads it. This module also owns the `debate_log` write (#364),
 * required so `feedback-loop/attribution.ts` has input to read.
 */
import type {
  AnalystRoundStance,
  AnalystView,
  AssetClass,
  DebateResult,
  LlmClient,
  SpendCap,
} from '../../../pipeline/debate-engine/index.js';
import {
  applyAnalystWeights,
  buildAnalystContributions,
  buildDebateLog,
  buildDebateRoundLogRows,
  computeConvictionScore,
  computeDebateId,
  type DebatePersonas,
  type DebaterPersona,
  detectDisagreements,
  enforceLatencyBudget,
  JsonDebateLogger,
  LlmAdmissionRefusedError,
  llmCallsPerDebate,
  MAX_ROUNDS,
  MAX_ROUNDS_BY_ASSET_CLASS,
  type MediatorAssessment,
  type MediatorPersona,
  type PartialDebateState,
  type PersonaResponse,
  type RateLimiter,
  type RoundContext,
  type RoundStance,
  type RoundVerdict,
  runBearPersona,
  runBullPersona,
  runDebate,
  runMediatorPersona,
  spendCapRefusalRemedy,
} from '../../../pipeline/debate-engine/index.js';
import {
  type Clock,
  type DebateLog,
  type DebateLogStore,
  describeThrownSafely,
  type Logger,
  sanitizeLogText,
} from '../../../shared/index.js';
import type { TickSteps } from '../types.js';

/** The one method the debate step needs from the tuning store (#435) */
export interface AnalystWeightSource {
  getAnalystWeights(): Record<string, number>;
}

import {
  checkGateRefusalRate,
  type GateRefusalRateAlertChannel,
  type GateRefusalRateMonitor,
  type GateRefusalWindowSource,
  type LlmGateRefusalSink,
} from './gate-refusal-rate-guard.js';
import {
  checkLlmFailureRate,
  type LlmFailureRateAlertChannel,
  type LlmFailureRateMonitor,
  type LlmFailureRateWindowSource,
} from './llm-failure-rate-guard.js';
import { RateLimitedLlmClient } from './rate-limited-llm-client.js';

/** `buildDebateStep`'s #1396 dependency bundle; omitted, `checkLlmFailureRate` is skipped entirely */
export interface LlmFailureRateGuardDeps {
  windowSource: LlmFailureRateWindowSource;
  monitor: LlmFailureRateMonitor;
  alertChannel: LlmFailureRateAlertChannel | undefined;
}

/**
 * `buildDebateStep`'s #1533 dependency bundle. Deliberately not merged into
 * `LlmFailureRateGuardDeps`: same store and call site, but different window,
 * denominator, threshold, latch and alert.
 */
export interface GateRefusalRateGuardDeps {
  windowSource: GateRefusalWindowSource;
  monitor: GateRefusalRateMonitor;
  alertChannel: GateRefusalRateAlertChannel | undefined;
  /** Required, unlike the rest of this bundle: supplying it means refusals should be counted */
  gateRefusalSink: LlmGateRefusalSink;
}

/** Fire-and-forget window check, invoked on both the completed-debate and the gate-refused path (#1533) */
function checkGateRefusalRateIfConfigured(
  guard: GateRefusalRateGuardDeps | undefined,
  logger: Logger | undefined,
  now: Date,
): void {
  if (guard === undefined) return;
  void checkGateRefusalRate(
    {
      windowSource: guard.windowSource,
      monitor: guard.monitor,
      alertChannel: guard.alertChannel,
      logger,
    },
    now,
  );
}

/**
 * The persona set plus the debate's synthesis-in-progress (#374).
 * `runDebate` exposes no round state, so `getCurrentState` reads it off the
 * mediator closure, which already accumulates it, rather than plumbing it
 * out of the orchestrator. Extends `DebatePersonas` so existing callers can
 * pass the result straight to `runDebate`.
 */
export interface DebatePersonasWithState extends DebatePersonas {
  /** Last completed round's synthesis, or `undefined` if the budget fired before any round finished */
  getCurrentState: () => PartialDebateState | undefined;
  /**
   * The round cap these personas were built for, echoed back so the caller
   * passes the same value to `runDebate` (#581) — reading it off this object
   * instead of a second argument keeps the two caps from drifting
   */
  maxRounds: number;
}

// Split out of the mediator's `assess` closure purely to keep its cognitive
// complexity down — a pure computation over already-resolved round data, with
// no ordering dependency on anything else in the round (the caller still
// computes `disagreement`/`confidence` first and calls this after, exactly as
// the inline version did)
function buildPartialDebateState(
  debate_id: string,
  context: RoundContext,
  response: Awaited<ReturnType<typeof runMediatorPersona>>,
  confidence: number,
  disagreement: Awaited<ReturnType<typeof detectDisagreements>>,
  accumulatedStances: AnalystRoundStance[],
  roundVerdicts: readonly RoundVerdict[],
): PartialDebateState {
  return {
    synthesis: response.rationale,
    position: `${response.stance}: ${response.rationale}`,
    confidence,
    contributions: buildAnalystContributions(context.views, accumulatedStances),
    disagreement_summary: disagreement.summary,
    // A partial state is non-converged by construction, and `runDebate` holds
    // the invariant that a non-converged result carries non-empty
    // `open_items` so Trader/Risk can apply caution. Its own fallback — the
    // disagreement summary — is empty on every non-final round
    // (`detectDisagreements` runs once per debate), so falling back to it
    // here would satisfy the invariant with an empty string. This says what
    // actually happened instead
    open_items:
      disagreement.conflicts.length > 0
        ? disagreement.conflicts.map((conflict) => conflict.nature)
        : ['debate did not converge before the latency budget fired'],
    rounds_completed: context.round,
    direction: response.stance,
    // Snapshot rather than the live array, matching `contributions` above
    // (`buildAnalystContributions` over a fresh copy of `accumulatedStances`)
    // — a caller holding an old `currentState` reads what had completed AT
    // THAT SNAPSHOT, not whatever `roundVerdicts` grows to later
    round_verdicts: [...roundVerdicts],
    debate_id,
  };
}

/**
 * Builds one debate's bull/bear/mediator port set over a shared LLM client.
 * Stateful per debate, not reusable across debates: safe only because
 * round-orchestrator.ts always calls bull.argue -> bear.argue ->
 * mediator.assess in that order, once per round, on one `runDebate` call.
 */
export function buildDebatePersonas(
  llmClient: LlmClient,
  trace_id: string,
  clock: Clock,
  /** Debate every LLM call is billed to (#326); optional so existing tests without one meter as unattributed */
  debate_id?: string,
  /**
   * The round cap this debate runs under (#581), echoed back on
   * `DebatePersonasWithState.maxRounds` so the caller reads it from there
   * rather than repeating the value
   */
  maxRounds: number = MAX_ROUNDS,
  /** Reaches only `detectDisagreements` (#1394), which previously swallowed failures silently */
  logger?: Logger,
): DebatePersonasWithState {
  let lastBull: PersonaResponse | undefined;
  let lastBear: PersonaResponse | undefined;
  const accumulatedStances: AnalystRoundStance[] = [];
  const roundVerdicts: RoundVerdict[] = [];
  let currentState: PartialDebateState | undefined;

  const bull: DebaterPersona = {
    async argue(context) {
      const response = await runBullPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        signal: context.signal,
      });
      lastBull = response;
      return { persona: 'bull', round: context.round, argument: response.rationale };
    },
  };

  const bear: DebaterPersona = {
    async argue(context) {
      const response = await runBearPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        signal: context.signal,
      });
      lastBear = response;
      return { persona: 'bear', round: context.round, argument: response.rationale };
    },
  };

  const mediator: MediatorPersona = {
    async assess(context: RoundContext): Promise<MediatorAssessment> {
      if (lastBull === undefined || lastBear === undefined) {
        throw new Error(
          'debate-adapter: mediator.assess called before both bull and bear argued this round',
        );
      }

      const response = await runMediatorPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        bullResponse: lastBull,
        bearResponse: lastBear,
        signal: context.signal,
      });

      const stances: RoundStance[] = context.views.map((view) => ({
        analyst_id: view.analyst_id,
        stance: view.direction,
      }));
      for (const stance of stances) {
        accumulatedStances.push({
          analyst_id: stance.analyst_id,
          round: context.round,
          stance: stance.stance,
        });
      }

      const isFinalRound = response.converged || context.round === maxRounds;
      const disagreement = isFinalRound
        ? await detectDisagreements(
            context.views,
            llmClient,
            context.signal,
            { trace_id, debate_id },
            logger,
          )
        : { summary: '', conflicts: [], method: 'directional_fallback' as const };

      // response.stance passed as a participant so the debate can move
      // conviction at all (#625 defect 2) — without it, conviction was a pure
      // function of the analyst views regardless of debate outcome
      const confidence = computeConvictionScore(context.views, accumulatedStances, response.stance);
      roundVerdicts.push({ round: context.round, direction: response.stance, confidence });

      // Only recorded once debate_id exists, so a persona set built without
      // one reports no state rather than an id that won't match debate_log
      if (debate_id !== undefined) {
        currentState = buildPartialDebateState(
          debate_id,
          context,
          response,
          confidence,
          disagreement,
          accumulatedStances,
          roundVerdicts,
        );
      }

      return {
        converged: response.converged,
        stances,
        synthesis: {
          synthesis: response.rationale,
          // The one genuine invention in this adapter; not load-bearing —
          // Trader reads only direction/confidence
          position: `${response.stance}: ${response.rationale}`,
          confidence,
          direction: response.stance,
          disagreement_summary: disagreement.summary,
          open_items: disagreement.conflicts.map((conflict) => conflict.nature),
        },
      };
    },
  };

  return { bull, bear, mediator, clock, getCurrentState: () => currentState, maxRounds };
}

/**
 * Writes the one `debate_log` row this debate is entitled to (#364). Writes
 * for every resolved debate, converged or not; writes nothing when a debate
 * throws partway, since there is no `DebateResult` to write and `debate_id`
 * is a content-hash PK a stub row would permanently occupy.
 *
 * First-write-wins, checked before insert. This is a backstop, not the
 * primary mechanism (`buildDebateStep` already checks post-#617 before
 * running the debate); reaching it means a debate was fully paid for and is
 * about to be discarded, and it also protects against a second process
 * racing the same store. The read+insert are two statements rather than one
 * atomic upsert because both are synchronous `better-sqlite3` calls with no
 * in-process interleaving possible — only a second process could race it,
 * which gets `writeLog`'s duplicate error rather than this quiet skip.
 *
 * A non-duplicate write failure propagates: `debate_log` is the Feedback
 * Loop's system-of-record, so failing the tick before Trader is fail-safe.
 *
 * Exported for `debate-adapter.test.ts` alone — a partial/timed-out debate
 * with `rounds_completed >= 1` is otherwise unreachable via
 * `buildDebateStep`, which hardwires `maxRounds` to 1 (#1080).
 */
export function persistDebateLog(params: {
  store: DebateLogStore;
  result: DebateResult;
  instrument: string;
  clock: Clock;
  trace_id: string;
  logger: Logger | undefined;
}): DebateLog | undefined {
  const { store, result, instrument, clock, trace_id, logger } = params;

  const winner = store.getByDebateId(result.debate_id);
  if (winner !== undefined) {
    logger?.log({
      trace_id,
      stage: 'debate',
      event: 'debate_log_duplicate_write',
      level: 'warn',
      message:
        `debate: ${instrument} already has a debate_log row for debate_id ` +
        `${result.debate_id} — skipping the duplicate write (first write wins). ` +
        'SINCE #617 THIS SHOULD BE RARE: `buildDebateStep` checks for the row before the ' +
        'debate runs and replays it, so reaching here means a debate was paid for and then ' +
        'discarded. The remaining legitimate cause is a row written concurrently by another ' +
        'process against the same shared store.',
      payload: { instrument, debate_id: result.debate_id },
    });

    // Handed back so the caller converges on the stored row rather than
    // returning its own discarded sample — else Feedback Loop attributes the
    // trade to the winner's row while sizing was done on the loser's
    return winner;
  }

  const written_at = clock.now();
  // One transaction: the FK on debate_round_log always resolves since
  // debate_log commits first inside it, and a throw from either write leaves
  // neither row
  store.writeLogWithRounds(
    buildDebateLog(result, instrument, written_at, trace_id),
    buildDebateRoundLogRows(result, written_at),
  );

  return undefined;
}

/**
 * Worst-case `RateLimiter.reserve` cost for one debate. Derived from
 * `MAX_ROUNDS` (bull/bear/mediator triple per round plus one final
 * `detectDisagreements` call), not chosen — pinned by a test so a round-cap
 * change cannot silently under-reserve.
 */
export const WORST_CASE_LLM_CALLS_PER_DEBATE = llmCallsPerDebate(MAX_ROUNDS);

/**
 * Same worst case at the asset class's round cap (#581) — crypto is capped
 * at one round, so reserving the global worst case would starve later
 * debates of admission for calls that cannot happen
 */
export function worstCaseLlmCallsForAssetClass(assetClass: AssetClass): number {
  return llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS[assetClass]);
}

/**
 * What a debate the rate limiter refused to admit returns (#388), rather
 * than throwing: a routine, expected-under-load refusal should not log as an
 * `error`-level instrument failure. `confidence: 0` is below any sane
 * `conviction_floor`, so `Trader.decide` short-circuits to `no_trade`. No
 * `debate_log` row is written — same reasoning as a debate that throws
 * partway (see `persistDebateLog`).
 */
function rateLimitedDebateResult(debate_id: string, bar: Date, reason: string): DebateResult {
  return {
    synthesis: `Debate not started: ${reason}`,
    position: 'No position — the debate was not admitted under the LLM rate-limit budget.',
    confidence: 0,
    contributions: [],
    disagreement_summary: 'Debate not started; no disagreement was assessed.',
    open_items: [`debate not started: ${reason}`],
    converged: false,
    rounds_completed: 0,
    latency_ms: 0,
    direction: 'neutral',
    debate_id,
    // The bar this tick belongs to, even though no debate ran (#687)
    bar_timestamp: bar,
    read: true,
    rate_limited: { reason },
  };
}

/**
 * Same shape as `rateLimitedDebateResult`, for a refusal on cost rather than
 * rate. Kept separate since the two mean different things to a soak-log
 * reader: "too fast, will pass" vs "out of money, needs an operator".
 */
function spendCappedDebateResult(debate_id: string, bar: Date, reason: string): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the LLM spend cap.',
  };
}

/**
 * What a debate the account-wide in-flight gate refused returns (#1080),
 * for the same reason `rateLimitedDebateResult` avoids a throw. The gate can
 * refuse mid-debate (after an MI refresh takes the permit), in which case
 * earlier billed persona answers are discarded here rather than retried —
 * not a regression, since a throw discarded them too. No `debate_log` row;
 * refusals are counted off the gate's own log line instead.
 */
function gateRefusedDebateResult(debate_id: string, bar: Date, reason: string): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the in-flight LLM cap.',
  };
}

/**
 * The debate this bar already resolved, rebuilt from its `debate_log` row
 * (#617) — closes the gap where the Trader sized on a live sample different
 * from the one Feedback Loop later attributes. `rate_limited` is absent:
 * nothing was refused. `latency_ms: 0` since this call spent no time
 * debating; `debate_id`/`bar_timestamp` are read off the row rather than
 * re-derived, since the row was looked up by `debate_id` already.
 */
function replayedDebateResult(persisted: ReplayableDebateLog): DebateResult {
  return {
    synthesis: persisted.synthesis,
    position: persisted.position,
    confidence: persisted.confidence,
    contributions: persisted.contributions,
    disagreement_summary: persisted.disagreement_summary,
    open_items: persisted.open_items,
    converged: persisted.converged,
    rounds_completed: persisted.rounds,
    latency_ms: 0,
    direction: persisted.direction,
    debate_id: persisted.debate_id,
    bar_timestamp: persisted.bar_timestamp,
    // Hardcoded: `debate_log` has no `read` column to read back (#1418)
    read: true,
  };
}

/** A `DebateLog` carrying every replay field the Trader consumes */
type ReplayableDebateLog = DebateLog & Required<Pick<DebateLog, ReplayField>>;

type ReplayField =
  | 'confidence'
  | 'synthesis'
  | 'position'
  | 'disagreement_summary'
  | 'open_items'
  | 'converged';

const REPLAY_FIELDS: readonly ReplayField[] = [
  'confidence',
  'synthesis',
  'position',
  'disagreement_summary',
  'open_items',
  'converged',
];

/**
 * Whether a persisted row can stand in for a live debate. Confidence alone
 * is not enough: the six replay fields are independently optional, and a
 * row carrying only confidence would replay as a fabricated empty debate.
 * All six or none — a partial row falls through and the debate re-runs.
 */
function isReplayable(persisted: DebateLog | undefined): persisted is ReplayableDebateLog {
  return persisted !== undefined && REPLAY_FIELDS.every((field) => persisted[field] !== undefined);
}

export function buildDebateStep(
  llmClient: LlmClient,
  /** Required, not optional (#364) */
  debateLog: DebateLogStore,
  /**
   * Required and positional third so an omission is a compile error, not a
   * silently unpaced run (#388)
   */
  rateLimiter: RateLimiter,
  /** The hard dollar ceiling (ADR-0008). `UNCAPPED_SPEND` states "no ceiling" explicitly at the call site. */
  spendCap: SpendCap,
  logger?: Logger,
  /** Live `analyst_weights` table (#435). Optional so a test/backtest can stay unweighted. */
  analystWeights?: AnalystWeightSource,
  /** #1396 llm-failure-rate bundle. Optional so existing callers keep compiling unchanged. */
  llmFailureRateGuard?: LlmFailureRateGuardDeps,
  /** #1533 gate-refusal-rate bundle — a separate signal from `llmFailureRateGuard` */
  gateRefusalRateGuard?: GateRefusalRateGuardDeps,
): TickSteps['debate'] {
  /**
   * The debate each bar resolved to, per instrument (#743) — belt under the
   * tick/decision split's suspender: even if the decision gate re-enters a
   * bar, the bar's resolved `debate_id` is remembered so the Trader can never
   * get a second confidence sample for the same bar from this step.
   * In-memory and restart-clean by design (#785): a restart mid-bar may pay
   * for one duplicate debate, accepted as bounded (at most once per
   * instrument per restart, restarts are a human/rare action here, and the
   * cost is a wasted LLM call, never a duplicate order).
   */
  const resolvedBarByInstrument = new Map<string, { barMs: number; debate_id: string }>();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: an ordered gate/replay pipeline where each step's position is individually documented as load-bearing — the same-bar memo and persisted-log replays must run before any spend/rate is consumed, the spend check must precede the rate reservation (reserve mutates counters, so a later refusal must not have already booked one), and resolvedBarByInstrument.set must run AFTER persistDebateLog so a throw leaves the bar unresolved for the crash-retry path (#743) — extraction risks silently reordering one of these
  return async ({ trace_id, instrument, asset_class, views, clock, bar }) => {
    // Computed ahead of the debate (#326): personas attribute spend rows
    // while the debate is still running, and a throw partway still billed
    // for the calls it made. Uses the gate's own bar, not a fresh floor
    // (#743/#687) — see `floorToBar` for the hour grid
    const debate_id = computeDebateId(instrument, bar, views);

    // Checked before the content gate below since it is immune to the
    // within-bar view drift #742 introduced (5m technical reads)
    function replayFromSameBarMemo(): DebateResult | undefined {
      const resolved = resolvedBarByInstrument.get(instrument);
      if (resolved !== undefined && resolved.barMs === bar.getTime()) {
        const remembered = debateLog.getByDebateId(resolved.debate_id);
        if (isReplayable(remembered)) {
          logger?.log({
            trace_id,
            stage: 'debate',
            level: 'info',
            message:
              `debate: ${instrument} replayed from debate_log for debate_id ` +
              `${resolved.debate_id} — this bar already resolved to a debate this process ran, ` +
              'so a fresh run would hand the Trader a second confidence sample for the same bar ' +
              '(#617/#781). No LLM call was made.',
            payload: { instrument, asset_class, debate_id: resolved.debate_id, replayed: true },
          });
          return replayedDebateResult(remembered);
        }
      }
      return undefined;
    }
    const memoReplay = replayFromSameBarMemo();
    if (memoReplay !== undefined) {
      return memoReplay;
    }

    // SAME-BAR SHORT-CIRCUIT (#617): debates are keyed to 1h bars, and this
    // covers the crash-retry/restart-within-a-bar case (the tick/decision
    // split, #743, already runs this step at most once per bar otherwise)
    // Returning the persisted debate keeps the Trader's input stable within a
    // bar rather than re-running an identical question and risking a
    // confidence drift that opens an extra lot on the same bar. A row from
    // before migration 0026 has no replay fields and falls through to re-run
    function replayFromDebateLog(): DebateResult | undefined {
      const persisted = debateLog.getByDebateId(debate_id);
      if (isReplayable(persisted)) {
        resolvedBarByInstrument.set(instrument, { barMs: bar.getTime(), debate_id });
        logger?.log({
          trace_id,
          stage: 'debate',
          level: 'info',
          message:
            `debate: ${instrument} replayed from debate_log for debate_id ${debate_id} — this ` +
            'tick shares a 1h bar with an earlier one and every debate input is bar-keyed, so a ' +
            'fresh debate would re-sample an identical question. No LLM call was made.',
          payload: { instrument, asset_class, debate_id, replayed: true },
        });
        return replayedDebateResult(persisted);
      }
      return undefined;
    }
    const persistedReplay = replayFromDebateLog();
    if (persistedReplay !== undefined) {
      return persistedReplay;
    }

    // BUDGET checked before the rate-limit window is booked (ADR-0008):
    // `reserve` mutates the limiter's counters, so booking a window for a
    // debate the budget will refuse anyway wastes rate allowance a later
    // debate needs. This check is a pure read with no reservation, so
    // concurrent instruments can all pass it before any spend is recorded —
    // an accepted, financially trivial overshoot (~$0.024 worst case at
    // today's concurrency)
    function checkSpendCap(): DebateResult | undefined {
      const spend = spendCap.check();
      if (!spend.admitted) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_spend_cap',
          level: 'error',
          message:
            `debate: ${instrument} not started — ${sanitizeLogText(spend.reason ?? 'spend cap')}. ` +
            'No LLM call was made and no debate_log row is written; the tick will short-circuit ' +
            `at Trader with no_trade. ${spendCapRefusalRemedy(spend.kind)} Open ` +
            'positions are unaffected — their bracket legs remain live venue-side, and ' +
            'Execution, reconcile and fill ingestion all keep running.',
          payload: {
            instrument,
            asset_class,
            debate_id,
            spent_usd: spend.spent_usd,
            budget_usd: spend.budget_usd,
            kind: spend.kind,
          },
        });
        return spendCappedDebateResult(debate_id, bar, spend.reason ?? 'spend cap reached');
      }
      return undefined;
    }
    const spendRefusal = checkSpendCap();
    if (spendRefusal !== undefined) {
      return spendRefusal;
    }

    function checkRateLimit(): DebateResult | undefined {
      const reservation = rateLimiter.reserve(
        asset_class,
        worstCaseLlmCallsForAssetClass(asset_class),
      );
      if (!reservation.granted) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_rate_limit',
          level: 'warn',
          message:
            `debate: ${instrument} not started — ${sanitizeLogText(reservation.reason)}. No LLM ` +
            'call was made and no debate_log row is written; the tick will short-circuit at ' +
            'Trader with no_trade. Persistent refusals mean rateLimiterConfig is sized under the ' +
            "universe's real debate rate, not that the market is quiet.",
          payload: { instrument, asset_class, debate_id },
        });
        return rateLimitedDebateResult(debate_id, bar, reservation.reason);
      }
      return undefined;
    }
    const rateLimitRefusal = checkRateLimit();
    if (rateLimitRefusal !== undefined) {
      return rateLimitRefusal;
    }

    // Round cap per asset class (#581): crypto runs one round to fit its
    // latency budget; stocks keep the 3-round hybrid termination
    const personas = buildDebatePersonas(
      new RateLimitedLlmClient(llmClient, rateLimiter, asset_class),
      trace_id,
      clock,
      debate_id,
      MAX_ROUNDS_BY_ASSET_CLASS[asset_class],
      logger,
    );

    // LATENCY BUDGET (#374): without it a pathological debate held the tick,
    // its LLM connections and rate-limit budget for as long as the provider
    // took. Per asset class (crypto 30s, stocks 60s). A timed-out debate
    // still resolves (partial synthesis or low-confidence fallback) and
    // flows into `persistDebateLog` like any other
    let result: DebateResult;
    try {
      result = await enforceLatencyBudget({
        assetClass: asset_class,
        trace_id,
        debate_id,
        bar,
        produceResult: (signal) =>
          runDebate({ views, instrument, bar }, personas, {
            signal,
            maxRounds: personas.maxRounds,
          }),
        getCurrentState: personas.getCurrentState,
        logger: new JsonDebateLogger(logger ?? { log: () => {} }),
      });
    } catch (cause) {
      const handled = handleDebateFailure(cause);
      if (handled !== undefined) {
        return handled;
      }
      throw cause;
    }

    // Gate refused this debate a permit (#1080) — degrade, not fault. Skips
    // `resolvedBarByInstrument.set` below, same as the rate-limiter refusal,
    // so a later pass may still run a real debate
    function handleDebateFailure(cause: unknown): DebateResult | undefined {
      if (cause instanceof LlmAdmissionRefusedError) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_gate',
          level: 'warn',
          message:
            `debate: ${instrument} not admitted — ${sanitizeLogText(cause.message)}. No ` +
            'debate_log row is written and the tick short-circuits at Trader with no_trade. ' +
            'Persistent refusals mean maxInFlightLlmCalls is sized under the pass width, not ' +
            'that the market is quiet.',
          payload: {
            instrument,
            asset_class,
            debate_id,
            reason: cause.reason,
            queue_depth: cause.queue_depth,
            in_flight: cause.in_flight,
            budget_ms: cause.budget_ms,
            waited_ms: cause.waited_ms,
          },
        });
        // No `debate_log` row for this debate, so this is the only place a
        // refusal is counted (#1533). Own try/catch: a bad write here must
        // not turn a degrade-not-fault refusal into an unhandled failure
        if (gateRefusalRateGuard !== undefined) {
          try {
            gateRefusalRateGuard.gateRefusalSink.recordGateRefusal(clock.now());
          } catch (recordError) {
            logger?.log({
              trace_id,
              stage: 'debate',
              event: 'llm_gate_refusal_record_failed',
              level: 'error',
              message:
                'Failed to record a gate refusal for the gate-refusal-rate guard — this refusal ' +
                'is undercounted in its window',
              payload: { instrument, debate_id, error: describeThrownSafely(recordError) },
            });
          }
          checkGateRefusalRateIfConfigured(gateRefusalRateGuard, logger, clock.now());
        }
        return gateRefusedDebateResult(debate_id, bar, cause.message);
      }
      logDebateFailure({ logger, trace_id, instrument, bar, views, cause });
      return undefined;
    }

    // Applied after `runDebate` so `debate_id` keeps meaning "identity of the
    // debate's inputs" (#435/#377); the weighted result is what gets logged,
    // so replay restores the conviction the Trader actually sized on
    const weighted =
      analystWeights === undefined
        ? result
        : applyAnalystWeights(result, analystWeights.getAnalystWeights());

    const raced = persistDebateLog({
      store: debateLog,
      result: weighted,
      instrument,
      clock,
      trace_id,
      logger,
    });

    // Recorded after the write so a debate that threw never marks its bar
    // resolved, leaving the crash-retry path open (#743)
    resolvedBarByInstrument.set(instrument, { barMs: bar.getTime(), debate_id });

    // Fire-and-forget: `checkLlmFailureRate` never throws; `void` keeps its
    // alert POST off this tick's critical path (#1396)
    if (llmFailureRateGuard !== undefined) {
      void checkLlmFailureRate(
        {
          windowSource: llmFailureRateGuard.windowSource,
          monitor: llmFailureRateGuard.monitor,
          alertChannel: llmFailureRateGuard.alertChannel,
          logger,
        },
        clock.now(),
      );
    }

    // Also called on the success path so the ratio can fall — a window read
    // only on refusal could never observe refusals ageing out (#1533)
    checkGateRefusalRateIfConfigured(gateRefusalRateGuard, logger, clock.now());

    // Lost the write race: return the winner's row so the Trader sizes on
    // the same bytes Feedback Loop will later attribute. Falls back to the
    // fresh result if the raced row isn't fully replayable
    if (isReplayable(raced)) {
      return replayedDebateResult(raced);
    }

    return weighted;
  };
}

/**
 * Makes the no-row case visible rather than silent (see `persistDebateLog`).
 * `debate_id` is recomputed from the same (instrument, bar, views) the failed
 * debate would have hashed, so an operator can grep the log for the id that
 * is missing from `debate_log`.
 */
function logDebateFailure(params: {
  logger: Logger | undefined;
  trace_id: string;
  instrument: string;
  bar: Date;
  views: AnalystView[];
  cause: unknown;
}): void {
  const { logger, trace_id, instrument, bar, views, cause } = params;
  if (logger === undefined) {
    return;
  }
  logger.log({
    trace_id,
    stage: 'debate',
    event: 'debate_unresolved',
    level: 'error',
    message:
      `debate: ${instrument} failed before resolving — no debate_log row is written for a ` +
      'debate that produced no result (the write-once debate_id stays free for the re-run): ' +
      sanitizeLogText(describeThrownSafely(cause)),
    payload: { instrument, debate_id: computeDebateId(instrument, bar, views) },
  });
}
