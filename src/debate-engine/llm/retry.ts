/**
 * Exponential-backoff retry wrapper for `LlmClient` calls (ticket #31 AC:
 * "Retry logic with exponential backoff (configurable)"). Delay uses real
 * `setTimeout`, matching `analyst-response-collector.ts`'s timeout pattern
 * — tests drive it with `vi.useFakeTimers()` / `advanceTimersByTimeAsync`
 * rather than a mock clock, since this is a plain async delay, not a
 * pipeline-time concept the injected `Clock` models.
 */
import { LlmMalformedResponseError, LlmRateLimitError, LlmTimeoutError } from './errors.js';
import type { LlmRetryConfig } from './types.js';

/**
 * Only failure modes the spec calls out as transient are retried
 * (timeout, rate limit, malformed response — a fresh sample may parse
 * cleanly). Anything else (auth errors, bad requests, unclassified
 * `LlmProviderError`s) is assumed non-transient and rethrown immediately.
 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, config: LlmRetryConfig): number {
  const raw = config.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, config.maxDelayMs);
}

/**
 * Runs `fn`, retrying up to `config.maxAttempts` total attempts on a
 * retryable error with exponential backoff between attempts. The last
 * error is rethrown once attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, config: LlmRetryConfig): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.maxAttempts) {
        throw error;
      }
      await delay(backoffDelayMs(attempt, config));
    }
  }

  // Unreachable: the loop always either returns or throws.
  throw lastError;
}
