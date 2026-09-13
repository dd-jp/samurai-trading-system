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
import type { DebateResult, Direction } from './types.js';

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
 * Per-call ceiling the budget below is sized against, MEASURED (#1080,
 * 2026-09-14) over the 2026-09-07 and 2026-09-10 soak sessions: 113 returning
 * `llm_spend` rows at `stage: 'debate'` give p50 19,017ms, p90 26,999ms,
 * p95 27,510ms. The distribution is RIGHT-CENSORED — a call that exhausts the
 * per-attempt timeout writes no row at all (see AC5 on #1080) — so these are a
 * lower bound on the true tail, which is the direction that matters here.
 *
 * It equals `DEFAULT_LLM_TIMEOUT_MS` (production/defaults.ts) by construction:
 * that constant derives from this budget divided by the call count below, and
 * this value is the measurement the pair was chosen against. A call cannot
 * exceed it without the per-attempt timeout firing.
 */
export const MEASURED_DEBATE_CALL_CEILING_MS = 28_000;

/**
 * Budget by asset class, in milliseconds (spec's "Budget by Asset Class").
 *
 * Crypto was 15s until #581: the first real paper tick measured every crypto
 * debate timing out at 15s while the FASTEST completed equity debate took ~17s
 * — the budget was below one round of sequential bull/bear/mediator calls at
 * real LLM latency, so 100% of crypto decisions were partial syntheses. 30s
 * covers the measured one-round debate (~17-20s incl. disagreement detection)
 * with headroom while staying half the stocks budget, because crypto signals
 * decay faster. The budget and the round cap below are ONE decision: raising
 * the budget without capping rounds would let a 3-round crypto debate run
 * ~45-60s of 24/7 spend and blow the ADR-0008 $50 soak cap (priced in #581's
 * cost-coupling comment).
 *
 * **Stocks was 60,000 until #1080 (2026-09-14), and it was unreachable by
 * arithmetic, not by contention.** A three-round stocks debate is
 * `llmCallsPerDebate(3)` = 10 sequential calls; at the measured p50 of 19,017ms
 * that is 190s against a 60s budget, and even ONE round is 4 calls = 76s at p50.
 * The store shows what that produced: of 58 debates over the two measured
 * sessions, 46 issued two calls or fewer, one converged, and 46 recorded
 * `rounds = 0` — the budget fired before the first round closed, every time.
 * Across the store's whole history exactly one debate of 184 converged.
 *
 * Stocks is now sized the way #581 sized crypto, as ONE decision with the round
 * cap below: one round, and a budget that affords every call that round issues
 * at the measured per-call ceiling — `llmCallsPerDebate(1) * 28,000` = 112,000.
 * It is deliberately not a round number: it is the arithmetic, pinned by a test.
 *
 * Crypto is left at 30,000 rather than re-derived: crypto left Samurai's scope
 * on 2026-08-16 (ADR-0015's amendment), the universe holds no crypto
 * instrument, and #581's figure is a decision about a system that no longer
 * runs. It does NOT satisfy the arithmetic above and never did — see
 * `LOGICAL_LLM_CALL_BUDGET_MS` (production/defaults.ts), which states the same
 * gap from the retry side.
 */
export const LATENCY_BUDGET_MS: Record<AssetClass, number> = {
  crypto: 30_000,
  stocks: llmCallsPerDebate(1) * MEASURED_DEBATE_CALL_CEILING_MS,
};

/**
 * Round cap by asset class (#581, option 2: shrink the crypto debate so it
 * genuinely fits its budget rather than truncating every tick).
 *
 * Crypto gets ONE round — bull, bear, mediator, once — because the debate is
 * strictly sequential (~5s/call measured, #346) and a second round cannot fit
 * any budget that respects crypto signal decay. A one-round debate is a
 * designed debate that completes; the old shape was a three-round debate that
 * was cut off mid-round on every tick, which is worse on both quality (no
 * disagreement detection ran — that only runs on the final round) and
 * attribution (every crypto row read `converged: false, timed_out`).
 *
 * **Stocks joined crypto at one round in #1080 (2026-09-14)**, for the same
 * reason and on the same evidence shape. The spec's 3-round hybrid termination
 * was never what ran: 46 of 58 measured debates recorded `rounds = 0`, and one
 * debate in the store's entire 184-row history has `converged = 1`. A round cap
 * of 3 was not buying three rounds; it was buying a budget nothing could finish
 * inside, and a `confidence: 0` fallback on nearly every tick. This codifies
 * what the measurement already showed rather than removing a capability that
 * was being used. `MAX_ROUNDS` (round-orchestrator.ts) stays 3 as the ceiling
 * `runDebate` validates against — the cap chosen here is a per-asset-class
 * policy inside it, not the structural bound.
 *
 * If debate-as-edge requires multi-round convergence, the lever is per-call
 * latency (#1023), not this cap: at the measured p50 no budget that also
 * respects the 2-minute tick cadence affords ten sequential calls.
 */
export const MAX_ROUNDS_BY_ASSET_CLASS: Record<AssetClass, number> = {
  crypto: 1,
  stocks: 1,
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
    // that arrives before the budget fires" below.
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
  // "swallows the cancelled debate rejection" test, which listens for one.
  const result = await Promise.race([
    debate,
    new Promise<{ status: 'timed_out' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timed_out' }), budget_ms);
    }),
  ]);

  // Cleared on BOTH paths. The debate winning the race used to leave the
  // budget timer pending until it fired for nothing — one leaked timer per
  // tick, every tick, for the length of the soak.
  clearTimeout(timer);

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
  // can run concurrently — sees why it was cut off.
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
  // free-text `reason`, which nothing but a log reader parses.
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
      debate_id: partial.debate_id,
      // From the caller, not from `partial`: a timed-out debate is still a
      // decision for the bar the tick was taken in, and the two shapes below
      // must name the same bar whether or not a round completed (#687).
      bar_timestamp: bar,
      // A round finished before the budget fired, so this IS a real (if
      // truncated) read — `timed_out` already says the debate was cut
      // short; `read` says the resulting direction is not a blank scaffold.
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
    debate_id,
    bar_timestamp: bar,
    // `timed_out` already makes `debateWasDegraded` true; see
    // DebateResult.read's docblock for why this scaffold still sets
    // `read: true` rather than `false`.
    read: true,
    timed_out,
  };
}

/**
 * A human-readable elaboration of `timed_out.cause` for whoever reads the raw
 * `logger.logTimeout` line — the persisted discriminator a QUERY reads is
 * `debate_log.termination_cause` (`timed_out.cause`, set above), not this
 * string.
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
