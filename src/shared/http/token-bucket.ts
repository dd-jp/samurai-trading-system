/**
 * Client-side token bucket — the outbound half of rate-limit resilience
 * (CLAUDE.md "Key Constraints": rate-limit resilient). `withRetry` in
 * `./retry.ts` handles the 429 *after* the venue has already rejected us; this
 * exists so we stop issuing the call that earns the 429 in the first place.
 *
 * That distinction matters for a broker adapter specifically: a rate-limited
 * `createOrder` is not a free retry. A venue that throttles a protective-leg
 * placement leaves a filled lot unprotected for the length of the backoff, and
 * a venue that bans the key outright leaves it unprotected indefinitely.
 * Pacing ourselves is the only control we own on that failure mode.
 *
 * Deliberately dependency-free and clock-injectable: the same reason the rest
 * of this codebase takes a `Clock` — a bucket that reads wall-clock directly
 * cannot be tested without sleeping through real seconds.
 */

export interface TokenBucketConfig {
  /** Burst size: how many calls may go out back-to-back from a full bucket. */
  capacity: number;
  /** Steady-state rate the bucket sustains once the burst is spent. */
  refillPerSecond: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly now: () => number = Date.now,
  ) {
    // Starts full: the first calls after process start are a legitimate burst,
    // and starting empty would delay the first order for no protective gain.
    this.tokens = config.capacity;
    this.lastRefill = now();
  }

  /**
   * Resolves when this caller owns a token — immediately if one is available,
   * otherwise after enough time has passed to mint one.
   *
   * The re-check LOOP is the whole correctness argument, not a stylistic
   * choice. Adapters issue concurrent calls (`Promise.all` over two protective
   * legs, overlapping lifecycle polls), so several `acquire()`s can be parked
   * on an empty bucket at once. Computing a wait once and consuming on wake
   * would let every parked caller consume the SAME single refilled token and
   * fire together — precisely the burst the bucket exists to prevent. Waking,
   * re-refilling and re-testing means the loser of the race simply waits
   * again.
   */
  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Time until the deficit is minted. `refillPerSecond` is trusted to be
      // positive; a non-positive rate is a misconfiguration that would park
      // every call forever rather than pace it.
      const waitMs = ((1 - this.tokens) / this.config.refillPerSecond) * 1000;
      await delay(Math.max(waitMs, 0));
    }
  }

  /** Credits elapsed time as tokens, never above `capacity` (burst is bounded). */
  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(nowMs - this.lastRefill, 0);
    this.lastRefill = nowMs;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + (elapsedMs / 1000) * this.config.refillPerSecond,
    );
  }
}
