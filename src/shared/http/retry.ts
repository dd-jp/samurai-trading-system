/**
 * Provider-agnostic exponential-backoff retry wrapper (issue #271,
 * generalized from the LLM-specific `withRetry` that shipped in
 * `src/debate-engine/llm/retry.ts` for ticket #31). Every real HTTP client
 * the transport-layer-spec.md "Shared Transport Conventions" module
 * introduces (Alpaca, Polygon, Telegram) — plus the pre-existing
 * `AnthropicLlmClient` — shares this loop; each call site supplies its own
 * `RetryConfig` sizing and its own `isRetryable` predicate over its own
 * error hierarchy, since what counts as transient differs per provider.
 */

export interface RetryConfig {
  /** Total attempts including the first, e.g. 3 = up to 2 retries. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Backoff is capped here so a long-running provider outage doesn't blow the caller's latency budget. */
  maxDelayMs: number;
  /**
   * Randomness source for the backoff jitter, `[0, 1)`. Defaults to
   * `Math.random`; tests inject a constant for deterministic delays.
   */
  random?: () => number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with equal jitter (execution-spec.md story 15:
 * "bounded exponential backoff + jitter"): half the exponential delay is
 * kept, half is randomized. Without it, every retry loop in a fleet that
 * restarted together fires on the same cadence — a synchronized retry storm
 * against per-IP/per-account broker limits.
 */
function backoffDelayMs(attempt: number, config: RetryConfig): number {
  const capped = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
  const random = config.random ?? Math.random;
  return capped / 2 + random() * (capped / 2);
}

/**
 * A retryable error may carry a provider-supplied hint for how long to wait
 * before the next attempt (e.g. a rate-limit error's `Retry-After`). When
 * present and a finite non-negative number, it overrides the computed
 * exponential backoff for that attempt — still clamped to `maxDelayMs`, since
 * a provider-controlled value must not be able to park the retry loop past
 * the caller's latency budget. Duck-typed rather than tied to any one
 * client's error hierarchy, since each client defines its own error classes.
 */
function retryAfterHintMs(error: unknown, config: RetryConfig): number | undefined {
  if (typeof error !== 'object' || error === null || !('retryAfterMs' in error)) {
    return undefined;
  }
  const hint = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint < 0) {
    return undefined;
  }
  return Math.min(hint, config.maxDelayMs);
}

/**
 * Runs `fn`, retrying up to `config.maxAttempts` total attempts on an error
 * `isRetryable` accepts, with exponential backoff between attempts (unless
 * the error carries a `retryAfterMs` hint, which takes precedence for that
 * attempt's delay). The last error is rethrown once attempts are exhausted
 * or `isRetryable` rejects it.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  if (config.maxAttempts < 1) {
    throw new Error(`RetryConfig.maxAttempts must be >= 1, got ${config.maxAttempts}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.maxAttempts) {
        throw error;
      }
      await delay(retryAfterHintMs(error, config) ?? backoffDelayMs(attempt, config));
    }
  }

  // Unreachable: the loop always either returns or throws.
  throw lastError;
}
