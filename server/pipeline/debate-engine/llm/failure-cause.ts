import {
  LlmInFlightRefusedError,
  NousApiError,
  NousRefusalError,
  NousTruncatedError,
} from '../../../shared/llm/index.js';
import {
  LlmAdmissionRefusedError,
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';

export type FailureCause =
  | 'refusal'
  | 'truncated'
  | 'unparseable'
  | 'timeout'
  | 'rate_limited'
  | 'cancelled'
  | 'gate_refused'
  | 'transport'
  | 'other';

export function classifyFailureCause(error: unknown): FailureCause {
  try {
    return classify(error);
  } catch {
    return 'other';
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat instanceof-dispatch chain, one error class to one FailureCause each; splitting it into sub-functions would hide the one property that matters here — that every case is mutually exclusive and independently readable, not nested logic.
function classify(error: unknown): FailureCause {
  if (error instanceof LlmRefusalError || error instanceof NousRefusalError) return 'refusal';
  if (error instanceof LlmTruncatedError || error instanceof NousTruncatedError) return 'truncated';
  if (error instanceof LlmMalformedResponseError) return 'unparseable';
  if (error instanceof LlmAdmissionRefusedError || error instanceof LlmInFlightRefusedError) {
    return 'gate_refused';
  }
  if (error instanceof LlmCancelledError) return 'cancelled';
  if (error instanceof LlmTimeoutError) return 'timeout';
  if (error instanceof LlmRateLimitError) return 'rate_limited';

  const status = statusOf(error);
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status !== undefined) return 'transport';

  if (error instanceof LlmProviderError || error instanceof NousApiError) return 'transport';

  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError') return 'timeout';

  return 'other';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
