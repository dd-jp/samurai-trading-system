/**
 * Provider-agnostic exponential-backoff retry wrapper (issue #271, generalized from the
 * LLM-specific `withRetry` that shipped in
 * `server/pipeline/debate-engine/llm/retry.ts` for ticket #31). <!-- cite-exempt: historical — records where the retry algorithm lived when this module was carved out; the generalization has since landed and the cited path is gone -->
 * Every real HTTP client the transport-layer-spec.md "Shared Transport Conventions"
 * module introduces (Alpaca, Polygon, Telegram) — plus the pre-existing
 * `AnthropicLlmClient` — shares this loop; each call site supplies its own
 * `RetryConfig` sizing and its own `isRetryable` predicate over its own error
 * hierarchy, since what counts as transient differs per provider.
 */

import { delay } from './delay.js';

/**
 * One failed attempt that is ABOUT TO BE RETRIED, handed to `withRetry`'s
 * observer (#1080).
 *
 * The observer exists because this loop was silent. A first attempt that timed
 * out and was retried left no trace anywhere: `AnthropicLlmClient` starts its
 * `latency_ms` clock inside the attempt and meters only the attempt that
 * RETURNS, so the failed one is absent from `llm_spend`, and nothing logged it.
 * A debate whose 60s latency budget was half-consumed by an invisible 30s
 * attempt therefore looked, in the log and in the spend table, exactly like a
 * debate that was merely slow — which is how #1080's hidden retries had to be
 * inferred from gaps between timestamps rather than read off a line.
 *
 * `elapsed_ms` is THIS attempt's own duration, measured around `fn()` by the
 * loop, not the cumulative time across attempts: the cumulative figure is
 * recoverable by summing, and the per-attempt one is not recoverable from it.
 */
export interface RetryAttemptReport {
  /** 1-based index of the attempt that just failed */
  attempt: number;
  /** `RetryConfig.maxAttempts`, so a reader need not look up the config to see how many are left */
  maxAttempts: number;
  /** How long the failed attempt itself ran, in milliseconds */
  elapsed_ms: number;
  /** The backoff about to be slept before the next attempt */
  delay_ms: number;
  /** The error that made the attempt retryable */
  error: unknown;
}

/** Observes each retried attempt. Must not throw — see `withRetry`. */
export type RetryObserver = (report: RetryAttemptReport) => void;

export interface RetryConfig {
  /** Total attempts including the first, e.g. 3 = up to 2 retries. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Backoff is capped here so a long-running provider outage doesn't blow the caller's latency budget */
  maxDelayMs: number;
}

/**
 * Bounded exponential backoff with FULL jitter: a uniform draw from
 * `[0, min(base * 2^(attempt-1), maxDelayMs)]`, not the ceiling itself.
 *
 * The jitter is the point, not a refinement. Every client sharing this loop
 * retries on the same deterministic schedule, so a provider outage that fails
 * N callers at once has them all wake at exactly base, then 2*base, then
 * 4*base — a synchronized thundering herd that keeps the provider saturated
 * and re-triggers the same failure. Spreading each caller's wake time across
 * the window de-correlates them at no cost to the cap.
 *
 * Randomizing DOWNWARD only: the cap still bounds the caller's latency budget.
 */
function backoffDelayMs(attempt: number, config: RetryConfig): number {
  const raw = config.baseDelayMs * 2 ** (attempt - 1);
  return Math.random() * Math.min(raw, config.maxDelayMs);
}

/**
 * Upper bound on how long one call through `withRetry` can take: every
 * attempt runs the full `timeoutMs` before failing, and `backoffDelayMs`'s
 * jitter is a draw from `[0, cap]`, so its own cap is the worst case (#1542).
 *
 * `withRetry`'s loop sleeps between attempts only, not after the last one:
 * `config.maxAttempts` timeouts plus `config.maxAttempts - 1` backoff caps.
 * Colocated with `backoffDelayMs` rather than living with a caller, since it
 * restates that same cap formula and would drift from it silently otherwise.
 */
export function worstCaseFetchMs(timeoutMs: number, config: RetryConfig): number {
  let backoffCapMs = 0;
  for (let attempt = 1; attempt < config.maxAttempts; attempt++) {
    backoffCapMs += Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
  }
  return timeoutMs * config.maxAttempts + backoffCapMs;
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
 * A throwing `onRetry` is contained rather than allowed to replace `error`:
 * this loop is on the path of every LLM and HTTP call in the system, and a
 * telemetry sink that fails must not convert a recoverable timeout into an
 * unclassified crash (`withRetry`'s doc comment). It is silently swallowed
 * here because the only sink is a logger, and a logger that cannot log has
 * nowhere left to report to.
 */
async function retryOrRethrow(
  error: unknown,
  attempt: number,
  startedAt: number,
  config: RetryConfig,
  isRetryable: (error: unknown) => boolean,
  onRetry: RetryObserver | undefined,
): Promise<void> {
  if (!isRetryable(error) || attempt === config.maxAttempts) {
    throw error;
  }
  const delay_ms = retryAfterHintMs(error, config) ?? backoffDelayMs(attempt, config);
  if (onRetry !== undefined) {
    try {
      onRetry({
        attempt,
        maxAttempts: config.maxAttempts,
        elapsed_ms: Date.now() - startedAt,
        delay_ms,
        error,
      });
    } catch {
      // See this function's doc comment: telemetry must not mask the provider error
    }
  }
  await delay(delay_ms);
}

/**
 * Runs `fn`, retrying up to `config.maxAttempts` total attempts on an error
 * `isRetryable` accepts, with jittered exponential backoff between attempts
 * (unless the error carries a `retryAfterMs` hint, which takes precedence for
 * that attempt's delay and is used as-is — an explicit provider instruction is
 * not ours to randomize). The last error is rethrown once attempts are exhausted
 * or `isRetryable` rejects it.
 *
 * `onRetry` (#1080) is called once per attempt that is actually retried —
 * after `isRetryable` accepts the error and while attempts remain, before the
 * backoff is slept. It is NOT called for the final failing attempt, whose
 * error the caller sees and can log itself. Optional, so every existing call
 * site is unchanged and simply reports nothing.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  isRetryable: (error: unknown) => boolean,
  onRetry?: RetryObserver,
): Promise<T> {
  if (config.maxAttempts < 1) {
    throw new Error(`RetryConfig.maxAttempts must be >= 1, got ${config.maxAttempts}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Real elapsed time, not the injected `Clock`: the backtest harness steps
    // that clock by hand and would report every attempt as instantaneous,
    // which is the exact figure this observer exists to produce
    const startedAt = Date.now();
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await retryOrRethrow(error, attempt, startedAt, config, isRetryable, onRetry);
    }
  }

  // Unreachable: the loop always either returns or throws
  throw lastError;
}
