/**
 * Latency budget enforcement — asset-class-specific hard timeout, sized
 * against the sequential LLM calls a debate at that asset class's round cap
 * issues. If the debate hasn't produced a result within budget, it is
 * force-terminated using whatever partial state is available.
 *
 * Races an arbitrary `produceResult` promise rather than reaching into
 * round-orchestration internals, so it does not depend on that module's
 * structure.
 *
 * Uses real `setTimeout` (not the injected `Clock`): `Clock` is stepped
 * manually by the backtest harness and never fires on its own, so it cannot
 * drive a race against real elapsed time. Tests use `vi.useFakeTimers()`.
 */
import { type DebateTerminationCause, describeThrownSafely } from '../../shared/index.js';
import type { DebateLogger } from './debate-logger.js';
import { LlmMalformedResponseError, LlmRateLimitError, LlmTimeoutError } from './llm/errors.js';
import type { AssetClass } from './rate-limiter.js';
import type { DebateResult, Direction, RoundVerdict } from './types.js';

export type { AssetClass };

/**
 * Sequential LLM calls one debate issues at a given round cap.
 *
 * A round is bull, bear, mediator — strictly sequential, each awaited before
 * the next (`round-orchestrator.ts`). `detectDisagreements` runs once per
 * debate, inside the FINAL round's mediator step (`debate-adapter.ts`'s
 * `isFinalRound` gate), so it is a per-debate constant and not a per-round one.
 */
export const LLM_CALLS_PER_ROUND = 3;
const DISAGREEMENT_DETECTION_CALLS_PER_DEBATE = 1;
export function llmCallsPerDebate(maxRounds: number): number {
  return LLM_CALLS_PER_ROUND * maxRounds + DISAGREEMENT_DETECTION_CALLS_PER_DEBATE;
}

/**
 * Round cap by asset class. `MAX_ROUNDS` (round-orchestrator.ts) stays 3 as
 * the structural ceiling `runDebate` validates against; this is a policy
 * inside it, and it is the constant to move if the measurement below changes.
 *
 * Crypto: shrink the debate so it fits its budget rather than truncating
 * every tick, which cost both quality (disagreement detection runs only on
 * the final round) and attribution (every row read `converged: false,
 * timed_out`).
 *
 * Stocks: MEASURED across a 4-name era (per-call p50 5,620ms, three rounds
 * reachable within a 60s budget) and a later 20-name fan-out (per-call p50
 * 18,306ms — a 3.3x inflation that no longer affords ten sequential calls
 * within the tick cadence). The cap is a consequence of width, not a
 * codification of a capability nothing exercised.
 *
 * The successor condition is this constant: if per-call latency returns to
 * the ~5.6s regime, raise it and the budget below follows by derivation.
 */
export const MAX_ROUNDS_BY_ASSET_CLASS: Record<AssetClass, number> = {
  crypto: 1,
  stocks: 1,
};

/**
 * Per-call ceiling the stocks budget is sized against, MEASURED over two
 * soak sessions: 113 `llm_spend` rows give p50 19,017ms, p90 26,999ms, p95
 * 27,510ms. The distribution is RIGHT-CENSORED — a call that exhausts the
 * per-attempt timeout writes no row at all — so these are a lower bound on
 * the true tail, which is the direction that matters here. Sessions taken
 * under an earlier flat client timeout are excluded, since mixing them
 * would move the censoring level rather than the shape of the distribution.
 *
 * `DEFAULT_LLM_TIMEOUT_MS` (production/defaults.ts) recovers this number by
 * dividing the budget below by the same call count, so a call cannot exceed
 * it without the per-attempt timeout firing.
 */
const MEASURED_DEBATE_CALL_CEILING_MS = 28_000;

/**
 * Budget by asset class, in milliseconds.
 *
 * Stocks is arithmetic and nothing else: every sequential call the round cap
 * above affords, at the measured per-call ceiling. Derived from
 * `MAX_ROUNDS_BY_ASSET_CLASS` rather than a literal so the budget, the round
 * cap and the per-attempt timeout cannot drift apart.
 *
 * Crypto covers its measured one-round debate (~17-20s including
 * disagreement detection) with headroom. It is NOT re-derived from the
 * arithmetic above: crypto is out of scope and the universe holds no crypto
 * instrument, so re-deriving it would be inventing a number for a system
 * that no longer runs.
 */
export const LATENCY_BUDGET_MS: Record<AssetClass, number> = {
  crypto: 30_000,
  stocks: llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks) * MEASURED_DEBATE_CALL_CEILING_MS,
};

/**
 * The mediator's synthesis-in-progress at the moment the budget fires, if
 * the round orchestrator has one. When absent, `enforceLatencyBudget` falls
 * back to a default low-confidence result (spec's "otherwise default to
 * low-confidence result").
 */
export interface PartialDebateState {
  synthesis: string;
  position: string;
  confidence: number;
  contributions: DebateResult['contributions'];
  disagreement_summary: string;
  open_items: string[];
  rounds_completed: number;
  direction: Direction;
  debate_id: string;
  /** Every round completed so far, in round order — see `DebateResult.round_verdicts` */
  round_verdicts: RoundVerdict[];
}

const LOW_CONFIDENCE_FALLBACK = {
  synthesis: 'Debate terminated before any round completed; no synthesis available.',
  position: 'No position — insufficient debate to recommend action.',
  confidence: 0,
  direction: 'neutral' as Direction,
} as const;

/**
 * Reason handed to the debate's `AbortSignal` when the budget fires. Carries
 * the numbers so anything that surfaces it (a log line, a rethrown error)
 * says WHY the call stopped rather than a bare "aborted".
 */
export class DebateBudgetExceededError extends Error {
  readonly budget_ms: number;
  readonly elapsed_ms: number;

  constructor(budget_ms: number, elapsed_ms: number) {
    super(`debate cancelled: latency budget of ${budget_ms}ms exceeded after ${elapsed_ms}ms`);
    this.name = 'DebateBudgetExceededError';
    this.budget_ms = budget_ms;
    this.elapsed_ms = elapsed_ms;
  }
}

/**
 * `LlmClient` failures this module degrades rather than lets crash the pass
 * — exactly `AnthropicLlmClient`'s own `isRetryable` set (`LlmTimeoutError`,
 * `LlmRateLimitError`, `LlmMalformedResponseError`), the classes the spec
 * calls transient because a fresh attempt might succeed. Deliberately NOT
 * the full `LlmError` union:
 *
 *  - `LlmProviderError` is `isRetryable`'s own "assumed non-transient"
 *    catch-all (auth errors, bad requests, 5xx, network). Degrading that
 *    into a routine warn line would let a persistently broken deployment
 *    run forever looking like fan-out pressure instead of the config/code
 *    fault it is. It keeps crashing the pass, unchanged.
 *  - `LlmRefusalError` names a model that DECLINED this prompt. It is
 *    deterministic in the request, so the next tick's identical prompt
 *    refuses identically — degrading it would hide a permanently blocked
 *    persona behind a line that reads like ordinary fan-out pressure.
 *  - `LlmCancelledError` names a cancellation this same function issued (via
 *    `controller.abort()` below), not a provider fault — never retried, and
 *    folding it in here would make a deliberate act indistinguishable from
 *    a real outage.
 */
type LlmFailure = LlmTimeoutError | LlmRateLimitError | LlmMalformedResponseError;

function isLlmFailure(error: unknown): error is LlmFailure {
  return (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError
  );
}

/**
 * The three ways the race below can settle. `llm_failed` is a rejection
 * `produceResult` handed back before the budget timer fired, narrowed to
 * `LlmFailure` at the `.then` rejection handler so a genuine bug elsewhere
 * (a real error in the round orchestrator or a persona) is excluded and
 * still crashes the pass.
 */
type RaceOutcome =
  | { status: 'completed'; result: DebateResult }
  | { status: 'timed_out' }
  | { status: 'llm_failed'; error: LlmFailure };

/**
 * Races `produceResult` against the asset class's hard budget. On timeout,
 * builds a `DebateResult` from `getCurrentState()` (or the low-confidence
 * fallback if no partial state exists), flags `converged: false`, attaches
 * `timed_out` metadata, and logs the event via `logger.logTimeout`.
 *
 * CANCELLATION. `Promise.race` stops the CALLER waiting; it does not stop
 * the debate on its own — without an explicit abort, the losing
 * `produceResult()` chain would run to completion (further LLM calls,
 * issued, awaited and BILLED, whose answers are then discarded), holding
 * HTTP connections and provider rate-limit budget into the next tick. So
 * the budget hands the debate an `AbortSignal` and aborts it when the timer
 * fires.
 *
 * WHAT IS RECORDED: whatever `getCurrentState()` returns, read AFTER the
 * abort. Cancelling changes what the debate does NEXT, never what it
 * already produced — a round that completed before the budget fired is in
 * the partial state and is used; the round in flight has no assessment to
 * record, so there is nothing to discard or keep.
 */
export async function enforceLatencyBudget(params: {
  assetClass: AssetClass;
  trace_id: string;
  debate_id: string;
  /**
   * The bar `debate_id` was hashed over. Required alongside it rather than
   * read off the partial state, because a timed-out debate may have no
   * partial state at all — and the fallback `DebateResult` this function
   * returns is still the one the Trader keys its order on, so it has to name
   * a bar.
   */
  bar: Date;
  /**
   * Receives the debate's cancellation signal. Existing zero-argument callers
   * still typecheck (TypeScript allows a function that ignores parameters) —
   * they simply keep the old abandon-on-timeout behaviour.
   */
  produceResult: (signal: AbortSignal) => Promise<DebateResult>;
  getCurrentState: () => PartialDebateState | undefined;
  logger: DebateLogger;
}): Promise<DebateResult> {
  const { assetClass, trace_id, debate_id, bar, produceResult, getCurrentState, logger } = params;
  const budget_ms = LATENCY_BUDGET_MS[assetClass];
  const started_at = Date.now();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debate = produceResult(controller.signal).then(
    (result): RaceOutcome => ({ status: 'completed', result }),
    // A retried call's two attempts each spend the client's FULL per-attempt
    // timeout, so this rejection can land BEFORE the timer below fires. Left
    // unhandled, it would escape `Promise.race` entirely. Narrowed to
    // `LlmFailure` (see that type's own doc) so this degrades the debate the
    // same way a genuine budget expiry does; anything else still rejects
    // `Promise.race` and still crashes the pass
    (error: unknown): RaceOutcome => {
      if (isLlmFailure(error)) {
        return { status: 'llm_failed', error };
      }
      throw error;
    },
  );

  // A cancelled debate rejects AFTER this function has returned its
  // fallback, and no explicit swallow is needed for that: `Promise.race`
  // attaches its own handlers to `debate`, so the late rejection is
  // handled-and-ignored rather than reaching `process.on('unhandledRejection')`
  // Cleared on EVERY exit, the rejecting one included: a non-`LlmFailure`
  // throw escapes the race and used to leave the budget timer pending until
  // it fired for nothing — one leaked handle per refused instrument
  let result: Awaited<typeof debate> | { status: 'timed_out' };
  try {
    result = await Promise.race([
      debate,
      new Promise<{ status: 'timed_out' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timed_out' }), budget_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (result.status === 'completed') {
    return result.result;
  }

  const elapsed_ms = Date.now() - started_at;

  // Aborted BEFORE `getCurrentState()` and before any logging: the first
  // thing that must happen once the budget is blown — or the debate's LLM
  // call fails outright — is that the spending stops. On the `llm_failed`
  // path the abort reason IS the `LlmFailure` itself, so a sibling call
  // still in flight within the same round sees why it was cut off
  controller.abort(
    result.status === 'llm_failed'
      ? result.error
      : new DebateBudgetExceededError(budget_ms, elapsed_ms),
  );

  const partial = getCurrentState();

  logger.logTimeout({
    trace_id,
    debate_id,
    elapsed_ms,
    budget_ms,
    reason: timeoutReason(result, partial !== undefined),
  });

  // `cause` is the PERSISTED discriminator, additive on top of the existing
  // `budget_ms`/`elapsed_ms` fields: carried into `debate_log.termination_cause`
  // by `buildDebateLog`, which lets a query exclude LLM-failure rows from a
  // budget-tuning measurement with one predicate instead of relying on
  // `logTimeout`'s free-text `reason`
  const cause: DebateTerminationCause = result.status === 'llm_failed' ? 'llm_failure' : 'budget';
  const timed_out = { budget_ms, elapsed_ms, cause };

  if (partial) {
    return {
      synthesis: partial.synthesis,
      position: partial.position,
      confidence: partial.confidence,
      contributions: partial.contributions,
      disagreement_summary: partial.disagreement_summary,
      open_items: partial.open_items,
      converged: false,
      rounds_completed: partial.rounds_completed,
      latency_ms: elapsed_ms,
      direction: partial.direction,
      round_verdicts: partial.round_verdicts,
      debate_id: partial.debate_id,
      // From the caller, not from `partial`: a timed-out debate is still a
      // decision for the bar the tick was taken in, and the two shapes below
      // must name the same bar whether or not a round completed
      bar_timestamp: bar,
      // A round finished before the budget fired, so this IS a real (if
      // truncated) read — `timed_out` already says the debate was cut
      // short; `read` says the resulting direction is not a blank scaffold
      read: true,
      timed_out,
    };
  }

  return {
    synthesis: LOW_CONFIDENCE_FALLBACK.synthesis,
    position: LOW_CONFIDENCE_FALLBACK.position,
    confidence: LOW_CONFIDENCE_FALLBACK.confidence,
    contributions: [],
    disagreement_summary: 'Debate terminated before disagreement could be assessed.',
    open_items: ['debate did not complete within latency budget'],
    converged: false,
    rounds_completed: 0,
    latency_ms: elapsed_ms,
    direction: LOW_CONFIDENCE_FALLBACK.direction,
    round_verdicts: [],
    debate_id,
    bar_timestamp: bar,
    // `timed_out` already makes `debateWasDegraded` true; see
    // DebateResult.read's docblock for why this scaffold still sets
    // `read: true` rather than `false`
    read: true,
    timed_out,
  };
}

/**
 * A human-readable elaboration of `timed_out.cause` for whoever reads the raw
 * `logger.logTimeout` line — the persisted discriminator a QUERY reads is
 * `debate_log.termination_cause`, not this string
 */
function timeoutReason(
  result: Exclude<RaceOutcome, { status: 'completed' }>,
  hasPartial: boolean,
): string {
  if (result.status === 'llm_failed') {
    const cause = describeThrownSafely(result.error);
    return hasPartial
      ? `the debate's LLM call failed (${cause}) — using mediator synthesis in progress`
      : `the debate's LLM call failed (${cause}) — no partial synthesis available, ` +
          'using low-confidence fallback';
  }
  return hasPartial
    ? 'latency budget exceeded: using mediator synthesis in progress'
    : 'latency budget exceeded: no partial synthesis available, using low-confidence fallback';
}
