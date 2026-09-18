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

export interface LlmFailureRateGuardDeps {
  windowSource: LlmFailureRateWindowSource;
  monitor: LlmFailureRateMonitor;
  alertChannel: LlmFailureRateAlertChannel | undefined;
}

export interface GateRefusalRateGuardDeps {
  windowSource: GateRefusalWindowSource;
  monitor: GateRefusalRateMonitor;
  alertChannel: GateRefusalRateAlertChannel | undefined;
  gateRefusalSink: LlmGateRefusalSink;
}

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

export interface DebatePersonasWithState extends DebatePersonas {
  getCurrentState: () => PartialDebateState | undefined;
  maxRounds: number;
}

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
    open_items:
      disagreement.conflicts.length > 0
        ? disagreement.conflicts.map((conflict) => conflict.nature)
        : ['debate did not converge before the latency budget fired'],
    rounds_completed: context.round,
    direction: response.stance,
    round_verdicts: [...roundVerdicts],
    debate_id,
  };
}

export function buildDebatePersonas(
  llmClient: LlmClient,
  trace_id: string,
  clock: Clock,
  debate_id?: string,
  maxRounds: number = MAX_ROUNDS,
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

      const confidence = computeConvictionScore(context.views, accumulatedStances, response.stance);
      roundVerdicts.push({ round: context.round, direction: response.stance, confidence });

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

    return winner;
  }

  const written_at = clock.now();
  store.writeLogWithRounds(
    buildDebateLog(result, instrument, written_at, trace_id),
    buildDebateRoundLogRows(result, written_at),
  );

  return undefined;
}

export const WORST_CASE_LLM_CALLS_PER_DEBATE = llmCallsPerDebate(MAX_ROUNDS);

export function worstCaseLlmCallsForAssetClass(assetClass: AssetClass): number {
  return llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS[assetClass]);
}

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
    bar_timestamp: bar,
    read: true,
    rate_limited: { reason },
  };
}

function spendCappedDebateResult(debate_id: string, bar: Date, reason: string): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the LLM spend cap.',
  };
}

function gateRefusedDebateResult(debate_id: string, bar: Date, reason: string): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the in-flight LLM cap.',
  };
}

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
    read: true,
  };
}

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

function isReplayable(persisted: DebateLog | undefined): persisted is ReplayableDebateLog {
  return persisted !== undefined && REPLAY_FIELDS.every((field) => persisted[field] !== undefined);
}

export function buildDebateStep(
  llmClient: LlmClient,
  debateLog: DebateLogStore,
  rateLimiter: RateLimiter,
  spendCap: SpendCap,
  logger?: Logger,
  analystWeights?: AnalystWeightSource,
  llmFailureRateGuard?: LlmFailureRateGuardDeps,
  gateRefusalRateGuard?: GateRefusalRateGuardDeps,
): TickSteps['debate'] {
  const resolvedBarByInstrument = new Map<string, { barMs: number; debate_id: string }>();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: an ordered gate/replay pipeline where each step's position is individually documented as load-bearing — the same-bar memo and persisted-log replays must run before any spend/rate is consumed, the spend check must precede the rate reservation (reserve mutates counters, so a later refusal must not have already booked one), and resolvedBarByInstrument.set must run AFTER persistDebateLog so a throw leaves the bar unresolved for the crash-retry path (#743) — extraction risks silently reordering one of these
  return async ({ trace_id, instrument, asset_class, views, clock, bar }) => {
    const debate_id = computeDebateId(instrument, bar, views);

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

    const personas = buildDebatePersonas(
      new RateLimitedLlmClient(llmClient, rateLimiter, asset_class),
      trace_id,
      clock,
      debate_id,
      MAX_ROUNDS_BY_ASSET_CLASS[asset_class],
      logger,
    );

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

    resolvedBarByInstrument.set(instrument, { barMs: bar.getTime(), debate_id });

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

    checkGateRefusalRateIfConfigured(gateRefusalRateGuard, logger, clock.now());

    if (isReplayable(raced)) {
      return replayedDebateResult(raced);
    }

    return weighted;
  };
}

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
