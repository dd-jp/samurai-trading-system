import { type DebateTerminationCause, describeThrownSafely } from '../../shared/index.js';
import type { DebateLogger } from './debate-logger.js';
import { LlmMalformedResponseError, LlmRateLimitError, LlmTimeoutError } from './llm/errors.js';
import type { AssetClass } from './rate-limiter.js';
import type { DebateResult, Direction, RoundVerdict } from './types.js';

export type { AssetClass };

const LLM_CALLS_PER_ROUND = 3;
const DISAGREEMENT_DETECTION_CALLS_PER_DEBATE = 1;
export function llmCallsPerDebate(maxRounds: number): number {
  return LLM_CALLS_PER_ROUND * maxRounds + DISAGREEMENT_DETECTION_CALLS_PER_DEBATE;
}

export const MAX_ROUNDS_BY_ASSET_CLASS: Record<AssetClass, number> = {
  crypto: 1,
  stocks: 1,
};

const MEASURED_DEBATE_CALL_CEILING_MS = 28_000;

export const LATENCY_BUDGET_MS: Record<AssetClass, number> = {
  crypto: 30_000,
  stocks: llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks) * MEASURED_DEBATE_CALL_CEILING_MS,
};

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
  round_verdicts: RoundVerdict[];
}

const LOW_CONFIDENCE_FALLBACK = {
  synthesis: 'Debate terminated before any round completed; no synthesis available.',
  position: 'No position — insufficient debate to recommend action.',
  confidence: 0,
  direction: 'neutral' as Direction,
} as const;

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

type LlmFailure = LlmTimeoutError | LlmRateLimitError | LlmMalformedResponseError;

function isLlmFailure(error: unknown): error is LlmFailure {
  return (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError
  );
}

type RaceOutcome =
  | { status: 'completed'; result: DebateResult }
  | { status: 'timed_out' }
  | { status: 'llm_failed'; error: LlmFailure };

export async function enforceLatencyBudget(params: {
  assetClass: AssetClass;
  trace_id: string;
  debate_id: string;
  bar: Date;
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
    (error: unknown): RaceOutcome => {
      if (isLlmFailure(error)) {
        return { status: 'llm_failed', error };
      }
      throw error;
    },
  );

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
      bar_timestamp: bar,
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
    read: true,
    timed_out,
  };
}

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
