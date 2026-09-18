import { delay } from './delay.js';

export interface RetryAttemptReport {
  attempt: number;
  maxAttempts: number;
  elapsed_ms: number;
  delay_ms: number;
  error: unknown;
}

export type RetryObserver = (report: RetryAttemptReport) => void;

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function backoffDelayMs(attempt: number, config: RetryConfig): number {
  const raw = config.baseDelayMs * 2 ** (attempt - 1);
  return Math.random() * Math.min(raw, config.maxDelayMs);
}

export function worstCaseFetchMs(timeoutMs: number, config: RetryConfig): number {
  let backoffCapMs = 0;
  for (let attempt = 1; attempt < config.maxAttempts; attempt++) {
    backoffCapMs += Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
  }
  return timeoutMs * config.maxAttempts + backoffCapMs;
}

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
    } catch {}
  }
  await delay(delay_ms);
}

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
    const startedAt = Date.now();
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await retryOrRethrow(error, attempt, startedAt, config, isRetryable, onRetry);
    }
  }

  throw lastError;
}
