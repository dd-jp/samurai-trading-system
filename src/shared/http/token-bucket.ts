/**
 * Token-bucket rate limiter (execution-spec.md story 16: "per-adapter
 * token-bucket throttle ... sized to venue limits"). Pre-emptive rate
 * control, complementing `withRetry`'s after-the-fact backoff: a broker ban
 * during an open position means no stops, no cancels, no flatten — so calls
 * are paced before they leave the process, not just retried after a 429.
 *
 * `acquire()` resolves immediately while burst capacity remains and
 * otherwise waits for the refill — callers just `await` it in front of every
 * client call. FIFO: waiters resolve in arrival order.
 */

export interface RateLimiter {
  acquire(): Promise<void>;
}

export interface TokenBucketConfig {
  /** Burst size — how many calls may go out back-to-back. */
  capacity: number;
  /** Sustained rate the bucket refills at. */
  refillPerSecond: number;
}

/** A limiter that never waits — for tests and for backtest wiring. */
export const UNLIMITED: RateLimiter = { acquire: () => Promise.resolve() };

export class TokenBucket implements RateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  /** Serializes waiters so refilled tokens are granted in arrival order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (config.capacity < 1 || config.refillPerSecond <= 0) {
      throw new Error(
        `TokenBucket needs capacity >= 1 and refillPerSecond > 0, got ` +
          `capacity=${config.capacity} refillPerSecond=${config.refillPerSecond}`,
      );
    }
    this.tokens = config.capacity;
    this.lastRefillMs = this.nowMs();
  }

  async acquire(): Promise<void> {
    const turn = this.tail.then(() => this.take());
    // Later acquirers queue behind this one even if it has to sleep.
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficitMs = ((1 - this.tokens) / this.config.refillPerSecond) * 1000;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(deficitMs)));
    this.refill();
    // The wait was sized to bring the balance to exactly one token; clamp
    // guards timer earliness.
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = this.nowMs();
    const elapsedSeconds = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsedSeconds * this.config.refillPerSecond,
    );
    this.lastRefillMs = now;
  }
}
