/**
 * Latency budget enforcement (#33) — see docs/specs/debate-engine-spec.md
 * "Module: Latency Budget". Asset-class-specific hard timeout, sized against
 * the sequential LLM calls a debate at that asset class's round cap issues
 * (#1080). If the debate hasn't produced a result within budget, it is
 * force-terminated using whatever partial state is available.
 *
 * Blocked-by #34 (Round Structure & Termination Orchestrator) did not exist
 * when this was written, so it races an arbitrary `produceResult` promise
 * rather than reaching into round-orchestration internals — same
 * ahead-of-#34 pattern as `analyst-contribution.ts` (#36) and
 * `debate-log-store.ts`.
 *
 * STATUS: wired into the live tick since #374 — `buildDebateStep`
 * (orchestrator/production/debate-adapter.ts) runs every debate through
 * `enforceLatencyBudget`, with `getCurrentState` read off the mediator
 * closure and the cancellation contract from #347 threaded into `runDebate`.
 *
 * Uses real `setTimeout` (not the injected `Clock`), matching
 * `analyst-response-collector.ts`'s timeout race — `Clock` is stepped
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
 * Round cap by asset class. `MAX_ROUNDS` (round-orchestrator.ts) stays 3 as the
 * structural ceiling `runDebate` validates against; this is a policy inside it,
 * and it is the constant to move if the measurement below changes.
 *
 * Crypto: #581, option 2 — shrink the debate so it fits its budget rather than
 * truncating every tick. The prior shape was cut off mid-round on every tick,
 * which cost both quality (disagreement detection runs only on the final round,
 * so it never ran) and attribution (every row read `converged: false,
 * timed_out`).
 *
 * Stocks: #1080 (2026-09-14). MEASURED over the store's 184 debates and the
 * `llm_spend` rows behind them, split at the 2026-09-03 fan-out from 4 names to
 * 20. Both eras are EQUITIES ONLY — the pre-era names are SPY, QQQ, AAPL and
 * TSLA over 2026-08-26 to 2026-09-02, so no crypto row (capped at one round
 * since #581, and out of scope since 2026-08-16) is in either sample:
 *
 *   pre-fan-out  — 57 debates over 4 instruments: per-call p50 5,620ms
 *                  (n=441), 9 converged, 45 ran 2+ rounds, 1 at `rounds = 0`.
 *                  Ten sequential calls is ~56s, inside the 60,000ms budget of
 *                  the day. This also corroborates #346's ~5s/call.
 *   post-fan-out — 127 debates over 20 instruments: per-call p50 18,306ms
 *                  (n=266), 1 converged, 102 at `rounds = 0`. The same ten
 *                  calls is ~183s against the same 60,000ms.
 *
 * Three rounds was therefore REACHABLE and in use, and fan-out took it away by
 * inflating per-call latency 3.3x. The cap is a consequence of width, not a
 * codification of a capability nothing exercised, and it is a real reduction
 * against the 4-name era — taken because at the post-fan-out latency no budget
 * that also respects the 2-minute tick cadence affords ten sequential calls.
 *
 * The successor condition is this constant: if per-call latency returns to the
 * ~5.6s regime (#1023's per-call work, or a narrower universe), raise it and
 * the budget below follows by derivation.
 */
export const MAX_ROUNDS_BY_ASSET_CLASS: Record<AssetClass, number> = {
  crypto: 1,
  stocks: 1,
};

/**
 * Per-call ceiling the stocks budget is sized against, MEASURED (#1080,
 * 2026-09-14) over the 2026-09-07 and 2026-09-10 soak sessions: 113 returning
 * `llm_spend` rows at `stage: 'debate'` give p50 19,017ms, p90 26,999ms,
 * p95 27,510ms. The distribution is RIGHT-CENSORED — a call that exhausts the
 * per-attempt timeout writes no row at all (see AC5 on #1080) — so these are a
 * lower bound on the true tail, which is the direction that matters here.
 *
 * Those two sessions are the sample ON PURPOSE, not all 266 post-fan-out rows
 * in the store: the wider set mixes in 2026-09-03/04 rows taken under the flat
 * 30,000ms client default #1103 replaced, which is the whole of its tail above
 * 28,000ms (14 rows, max 29,979ms). Mixing them moves the censoring level, not
 * the shape of the distribution this constant is sized against.
 *
 * `DEFAULT_LLM_TIMEOUT_MS` (production/defaults.ts) recovers this number by
 * dividing the budget below by the same call count, so a call cannot exceed it
 * without the per-attempt timeout firing.
 */
const MEASURED_DEBATE_CALL_CEILING_MS = 28_000;

/**
 * Budget by asset class, in milliseconds (spec's "Budget by Asset Class").
 *
 * Stocks is arithmetic and nothing else: every sequential call the round cap
 * above affords, at the measured per-call ceiling. Deliberately not a round
 * number, and pinned by test. Derived from `MAX_ROUNDS_BY_ASSET_CLASS` rather
 * than from a literal so the budget, the round cap and the per-attempt timeout
 * cannot drift apart — moving the cap moves all three.
 *
 * Crypto is #581's figure, covering its measured one-round debate (~17-20s
 * including disagreement detection) with headroom. It is NOT re-derived from
 * the arithmetic above and does not satisfy it: crypto left Samurai's scope on
 * 2026-08-16 (ADR-0015's amendment) and the universe holds no crypto
 * instrument, so re-deriving it would be inventing a number for a system that
 * no longer runs. `DEBATE_BUDGET_MS` (production/defaults.ts) states the same
 * gap from the retry side.
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
  /** Every round completed so far, in round order (#1517) — see `DebateResult.round_verdicts` */
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
 * (#1380) — exactly `AnthropicLlmClient`'s own `isRetryable` set
 * (`LlmTimeoutError`, `LlmRateLimitError`, `LlmMalformedResponseError`), the
 * classes the spec calls transient because a fresh attempt might succeed.
 * Deliberately NOT the full `LlmError` union:
 *
 *  - `LlmProviderError` is `isRetryable`'s own "assumed non-transient"
 *    catch-all (auth errors, bad requests, 5xx, network) — `classifyProviderError`
 *    (anthropic-client.ts) wraps EVERY unclassified transport throw into one,
 *    including a dead API key or a malformed request this codebase itself
 *    sent. Degrading that into a routine `budget_exhausted`/`timed_out_partial`
 *    `warn` line would let a persistently broken deployment run forever
 *    looking like fan-out pressure instead of the config/code fault it is —
 *    strictly worse than the crash it would otherwise cause, since a crash at
 *    least surfaces the fault immediately. It keeps crashing the pass,
 *    unchanged.
 *  - `LlmRefusalError` (#1391) names a model that DECLINED this prompt. It is
 *    deterministic in the request, so the next tick's identical prompt refuses
 *    identically — degrading it would hide a permanently blocked persona
 *    behind a line that reads like ordinary fan-out pressure, tick after tick.
 *    Truncation already crashes the pass for that reason (it arrives as an
 *    `LlmTruncatedError`, outside `LlmFailure` below), and a refusal is its
 *    sibling. Not that every refusal
 *    reaches here: `disagreement-detector.ts` catches bare and falls back to
 *    the directional heuristic, so a model that refuses THAT prompt is re-billed
 *    silently on every debate. Out of scope for #1391 and recorded there.
 *  - `LlmCancelledError` names a cancellation this same function issued (via
 *    `controller.abort()` below), not a provider fault — never retried, and
 *    per its own doc in `llm/errors.ts`, folding it in here would make a
 *    deliberate act indistinguishable from a real outage. It cannot reach the
 *    `.then` rejection handler below before this function's own abort call in
 *    any case, since `controller` is owned exclusively by this invocation.
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
 * The three ways the race below can settle. `llm_failed` is #1380's addition
 * — a rejection `produceResult` handed back before the budget timer fired,
 * narrowed to `LlmFailure` at the `.then` rejection handler so a genuine bug
 * elsewhere (a real error in the round orchestrator or a persona) is excluded
 * and still crashes the pass (see the comment there for why).
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
 * CANCELLATION (#347). `Promise.race` stops the CALLER waiting; it does not
 * stop the debate. Before this ticket the losing `produceResult()` chain ran
 * to completion — up to six more bull/bear/mediator LLM calls, each issued,
 * awaited and BILLED, whose answers were then discarded, while holding HTTP
 * connections and provider rate-limit budget into the next tick. So the budget
 * now hands the debate an `AbortSignal` and aborts it when the timer fires.
 *
 * WHAT IS RECORDED, and why: exactly what was recorded before — whatever
 * `getCurrentState()` returns, read AFTER the abort. Cancelling changes what
 * the debate does NEXT, never what it already produced. A round that completed
 * before the budget fired is in the partial state and is used; the round in
 * flight at that instant has no assessment to record (its persona calls never
 * returned), so there is nothing to discard or keep — the choice does not
 * arise. That keeps the caller-visible contract identical to before: partial
 * synthesis when one exists, low-confidence fallback when none does.
 */
export async function enforceLatencyBudget(params: {
  assetClass: AssetClass;
  trace_id: string;
  debate_id: string;
  /**
   * The bar `debate_id` was hashed over (#687). Required alongside it rather
   * than read off the partial state, because a timed-out debate may have no
   * partial state at all — and the fallback `DebateResult` this function
   * returns is still the one the Trader keys its order on, so it has to name a
   * bar. Same value, same call site: `buildDebateStep` floors one clock read
   * and passes it to `computeDebateId` and to here.
   */
  bar: Date;
  /**
   * Receives the debate's cancellation signal. Existing zero-argument callers
   * still typecheck (TypeScript allows a function that ignores parameters) —
   * they simply keep the old abandon-on-timeout behaviour, which is why the
   * production caller must thread it into `runDebate`.
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
    // #1380: a retried call's two attempts each spend the client's FULL
    // per-attempt timeout, so this rejection can land BEFORE the timer below
    // fires. Left unhandled, it would escape `Promise.race` entirely, since a
    // race only resolves or rejects on what its promises do — it does not
    // degrade a rejection into an outcome on its own. Narrowed to
    // `LlmFailure` (see that type's own doc) so this degrades the debate the
    // same way a genuine budget expiry does; anything else (a real bug in the
    // round orchestrator or a persona) still rejects `Promise.race` and still
    // crashes the pass, unchanged — see "still propagates a debate failure
    // that arrives before the budget fires" below
    (error: unknown): RaceOutcome => {
      if (isLlmFailure(error)) {
        return { status: 'llm_failed', error };
      }
      throw error;
    },
  );

  // A cancelled debate rejects AFTER this function has returned its fallback,
  // and no explicit swallow is needed for that: `Promise.race` attaches its own
  // handlers to `debate`, so the late rejection is handled-and-ignored rather
  // than reaching `process.on('unhandledRejection')`. Pinned by the
  // "swallows the cancelled debate rejection" test, which listens for one
  // Cleared on EVERY exit, the rejecting one included: a non-`LlmFailure`
  // throw (a gate refusal, #1080's steady state for most of a pass) escapes
  // the race and used to leave the budget timer pending until it fired for
  // nothing — one leaked handle per refused instrument, every tick
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
  // call fails outright (#1380) — is that the spending stops. On the
  // `llm_failed` path the abort reason IS the `LlmFailure` itself (rather
  // than a synthetic `DebateBudgetExceededError` that never actually fired),
  // so a sibling call still in flight within the same round — bull and bear
  // can run concurrently — sees why it was cut off
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

  // `cause` (#1380) is the PERSISTED discriminator: `debateDecisionWord` and
  // `buildDebateLog` read only `budget_ms`/`elapsed_ms` off this object today
  // and stay unchanged, so a genuine budget expiry and an outright LLM
  // failure keep writing the identical `DEGRADED_DECISIONS` word and
  // `termination` value — `cause` is additive, carried into
  // `debate_log.termination_cause` by `buildDebateLog`, which is what lets a
  // query exclude LLM-failure rows from a budget-tuning measurement (like
  // #1080's) with one predicate instead of relying on `logTimeout`'s
  // free-text `reason`, which nothing but a log reader parses
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
      // must name the same bar whether or not a round completed (#687)
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
 * `debate_log.termination_cause` (`timed_out.cause`, set above), not this
 * string
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
