/**
 * Latency budget enforcement (#33) — see docs/specs/debate-engine-spec.md
 * "Module: Latency Budget". Asset-class-specific hard timeout: crypto 15s,
 * stocks 60s. If the debate hasn't produced a result within budget, it is
 * force-terminated using whatever partial state is available.
 *
 * Blocked-by #34 (Round Structure & Termination Orchestrator) does not yet
 * exist, so this races an arbitrary `produceResult` promise rather than
 * reaching into round-orchestration internals — same ahead-of-#34 pattern
 * as `analyst-contribution.ts` (#36) and `debate-log-store.ts`. Once #34
 * lands, it calls `enforceLatencyBudget` around its own round loop.
 *
 * Uses real `setTimeout` (not the injected `Clock`), matching
 * `analyst-response-collector.ts`'s timeout race — `Clock` is stepped
 * manually by the backtest harness and never fires on its own, so it cannot
 * drive a race against real elapsed time. Tests use `vi.useFakeTimers()`.
 */
import type { DebateLogger } from './debate-logger.js';
import type { AssetClass } from './rate-limiter.js';
import type { DebateResult, Direction } from './types.js';

export type { AssetClass };

/** Budget by asset class, in milliseconds (spec's "Budget by Asset Class"). */
export const LATENCY_BUDGET_MS: Record<AssetClass, number> = {
  crypto: 15_000,
  stocks: 60_000,
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
   * Receives the debate's cancellation signal. Existing zero-argument callers
   * still typecheck (TypeScript allows a function that ignores parameters) —
   * they simply keep the old abandon-on-timeout behaviour, which is why the
   * production caller must thread it into `runDebate`.
   */
  produceResult: (signal: AbortSignal) => Promise<DebateResult>;
  getCurrentState: () => PartialDebateState | undefined;
  logger: DebateLogger;
}): Promise<DebateResult> {
  const { assetClass, trace_id, debate_id, produceResult, getCurrentState, logger } = params;
  const budget_ms = LATENCY_BUDGET_MS[assetClass];
  const started_at = Date.now();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debate = produceResult(controller.signal).then(
    (result): { status: 'completed'; result: DebateResult } => ({
      status: 'completed',
      result,
    }),
  );

  // A cancelled debate REJECTS, and it rejects after this function has already
  // returned its fallback — so nothing is awaiting it. Attaching this handler
  // is what stops a deliberate cancellation from surfacing as an unhandled
  // rejection (fatal under `--unhandled-rejections=strict`, and noise in the
  // soak log either way). It does not swallow a pre-timeout failure: the race
  // below still sees, and still propagates, a rejection that arrives first.
  debate.catch(() => {});

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

  // Aborted BEFORE `getCurrentState()` and before any logging: the first thing
  // that must happen once the budget is blown is that the spending stops.
  controller.abort(new DebateBudgetExceededError(budget_ms, elapsed_ms));

  const partial = getCurrentState();

  logger.logTimeout({
    trace_id,
    debate_id,
    elapsed_ms,
    budget_ms,
    reason: partial
      ? 'latency budget exceeded: using mediator synthesis in progress'
      : 'latency budget exceeded: no partial synthesis available, using low-confidence fallback',
  });

  const timed_out = { budget_ms, elapsed_ms };

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
    timed_out,
  };
}
