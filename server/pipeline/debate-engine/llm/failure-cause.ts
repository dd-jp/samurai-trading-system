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

// Order is the point: each rule is checked in sequence and the first match wins, exactly as
// the instanceof-chain this replaced did — do not reorder without re-checking the status-code
// and name-based rules still fall after every more specific instanceof rule above them
const CLASSIFICATION_RULES: ReadonlyArray<{
  test: (error: unknown) => boolean;
  cause: FailureCause;
}> = [
  { test: (e) => e instanceof LlmRefusalError || e instanceof NousRefusalError, cause: 'refusal' },
  {
    test: (e) => e instanceof LlmTruncatedError || e instanceof NousTruncatedError,
    cause: 'truncated',
  },
  { test: (e) => e instanceof LlmMalformedResponseError, cause: 'unparseable' },
  {
    test: (e) => e instanceof LlmAdmissionRefusedError || e instanceof LlmInFlightRefusedError,
    cause: 'gate_refused',
  },
  { test: (e) => e instanceof LlmCancelledError, cause: 'cancelled' },
  { test: (e) => e instanceof LlmTimeoutError, cause: 'timeout' },
  { test: (e) => e instanceof LlmRateLimitError, cause: 'rate_limited' },
  { test: (e) => statusOf(e) === 429, cause: 'rate_limited' },
  { test: (e) => statusOf(e) === 408 || statusOf(e) === 504, cause: 'timeout' },
  { test: (e) => statusOf(e) !== undefined, cause: 'transport' },
  { test: (e) => e instanceof LlmProviderError || e instanceof NousApiError, cause: 'transport' },
  { test: (e) => nameOf(e) === 'AbortError', cause: 'cancelled' },
  { test: (e) => nameOf(e) === 'TimeoutError', cause: 'timeout' },
];

function classify(error: unknown): FailureCause {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(error)) return rule.cause;
  }
  return 'other';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
