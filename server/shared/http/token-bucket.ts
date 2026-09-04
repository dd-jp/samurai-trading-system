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
 *
 * #1083: throttling was completely silent — a caller parked here for eight
 * seconds and one served instantly produced the same (nonexistent) trace, so
 * a starved fetch could be neither confirmed nor ruled out as an explanation
 * for a session's timeouts. `TokenBucketTelemetry` closes that gap with an
 * OPTIONAL wait-observed log line; see `take()` and
 * `TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS` for what gets logged and when. It does
 * not change what `acquire()`/`acquireBackground()` resolve on or when —
 * observation only, never a second control on pacing.
 */

import type { Logger } from '../types/primitives.js';
import { delay } from './delay.js';

export interface TokenBucketConfig {
  /** Burst size: how many calls may go out back-to-back from a full bucket. */
  capacity: number;
  /** Steady-state rate the bucket sustains once the burst is spent. */
  refillPerSecond: number;
  /**
   * Tokens `acquireBackground()` may not spend, reserved for `acquire()`
   * (#391).
   *
   * Exists because ONE bucket now paces two consumers with very different
   * urgency against a single per-account budget: order placement and market
   * data. Splitting them into two buckets cannot be safe — the limit belongs
   * to the account, so two independent buckets re-create exactly the
   * over-subscription this closes. But a shared bucket with no reserve lets a
   * six-instrument bar sweep drain it and park an order behind the refill,
   * and a delayed protective leg is the failure mode this whole module
   * exists to avoid.
   *
   * Defaults to 0, which is exactly today's behaviour for every venue with a
   * single consumer (ccxt, ibkr) — the reserve is inert unless configured.
   */
  reserveForPriority?: number;
}

/** Which of the two lanes `take()` was called through — see `acquire()` vs `acquireBackground()`. */
type TokenBucketLane = 'priority' | 'background';

/**
 * Optional wait-observed telemetry (#1083). A bucket built without this
 * argument behaves exactly as before — no import, no log line, nothing to
 * wire — which is why every pre-#1083 call site still compiles unchanged.
 */
export interface TokenBucketTelemetry {
  logger: Logger;
  /**
   * Which bucket this is, e.g. `'alpaca'` — the venue/consumer label a reader
   * would use to tell two buckets' waits apart, not the class name (every
   * bucket is a `TokenBucket`, so that would tell them nothing).
   */
  name: string;
}

/**
 * A wait shorter than this is ordinary contention among concurrent callers on
 * a shared bucket — e.g. two callers racing an almost-full bucket, the loser
 * waiting out a single token's refill — and logging every one of those would
 * make a healthy run noisy rather than legible. Above it, on the fastest
 * bucket wired in production today (Alpaca, 2 tok/s — half a second per
 * token), the caller has waited longer than two tokens'-worth of refill,
 * which one concurrent rival no longer explains: it is either a real burst
 * queue or the priority reserve holding a background caller back (#391) —
 * exactly the case #1083 needs made visible. Named rather than inlined so a
 * reader can find the number without re-deriving it, and so a future,
 * slower-refilling venue does not have to reason about a magic `1_000`.
 */
export const TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS = 1_000;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly now: () => number = Date.now,
    private readonly telemetry?: TokenBucketTelemetry,
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
   *
   * `signal` (#702) is for a caller that may be ABANDONED rather than waited
   * out — a shutdown draining `GdeltIngestAgent`, specifically. A parked
   * `acquire()` has done no work and ordered nothing yet, unlike a request
   * already in flight, so aborting it costs nothing and is the whole point:
   * see `GdeltGkgClient` for why the signal stops HERE and is not threaded
   * into the request that follows.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    await this.take(0, 'priority', signal);
  }

  /**
   * Like `acquire()`, but leaves `reserveForPriority` tokens untouched (#391).
   *
   * For the consumer that can afford to wait — market data — so that a burst
   * of bar fetches cannot park an order behind the refill. A background caller
   * on a drained bucket waits for the reserve to be re-minted ON TOP of its
   * own token, which is the intended cost: data is late, orders are not.
   *
   * No `signal` parameter: nothing today abandons a background market-data
   * fetch on shutdown, so it would be plumbing nothing calls.
   */
  async acquireBackground(): Promise<void> {
    await this.take(this.config.reserveForPriority ?? 0, 'background');
  }

  private async take(reserve: number, lane: TokenBucketLane, signal?: AbortSignal): Promise<void> {
    const needed = 1 + reserve;
    // Wall-clock start, not a flag: most calls never park at all, and reading
    // `this.now()` once up front costs nothing on that (overwhelmingly common)
    // path. Uses the SAME injected clock as `refill()` deliberately — a
    // second, unrelated clock here could disagree with it under a faked timer
    // and turn an instant grant into a phantom logged wait.
    const startedAt = this.now();
    while (true) {
      signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= needed) {
        this.tokens -= 1;
        this.logIfMaterialWait(lane, this.now() - startedAt);
        return;
      }
      // Time until the deficit is minted. `refillPerSecond` is trusted to be
      // positive; a non-positive rate is a misconfiguration that would park
      // every call forever rather than pace it.
      const waitMs = ((needed - this.tokens) / this.config.refillPerSecond) * 1000;
      await this.waitOrAbort(Math.max(waitMs, 0), signal);
    }
  }

  /**
   * #1083. `undefined` telemetry (every call site that hasn't wired it) and a
   * wait under the threshold are both silent by design — see
   * `TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS` for why the second one is a floor
   * and not a lower one.
   *
   * The event name is `token_bucket_wait`, chosen to survive a grep that a
   * bare `token` or a bare `429` cannot: an LLM `input_tokens` field
   * substring-matches the former, and a digit run substring-matches the
   * latter — both were false positives that made a real session's throttling
   * unanswerable (#1083's own motivating search).
   *
   * `waitedMs` is a `this.now()` delta, the same injected clock `refill()`
   * uses (deliberately, per `take()`'s comment) rather than a monotonic
   * `performance.now()` — so under the real `Date.now` default, a backward
   * wall-clock step mid-wait could in principle produce a negative delta.
   * Clamped to 0 so a log consumer never has to reason about a negative
   * `wait_ms`; the field is diagnostic (surfacing that SOME wait happened),
   * not load-bearing, so a clamped-away step still leaves the strictly more
   * useful outcome of #1083 — a visible line where today there is silence.
   */
  private logIfMaterialWait(lane: TokenBucketLane, waitedMs: number): void {
    if (this.telemetry === undefined) return;
    if (waitedMs < TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS) return;
    const roundedWaitMs = Math.round(Math.max(waitedMs, 0));
    this.telemetry.logger.log({
      trace_id: 'token-bucket',
      stage: 'rate_limit',
      level: 'warn',
      message:
        `token_bucket_wait: the '${this.telemetry.name}' bucket paced a ${lane} caller for ` +
        `${roundedWaitMs}ms before granting a token.`,
      payload: {
        event: 'token_bucket_wait',
        bucket: this.telemetry.name,
        lane,
        wait_ms: roundedWaitMs,
      },
    });
  }

  /**
   * `delay`, but abandoned the instant `signal` fires instead of ridden out
   * (#702).
   *
   * Deliberately local rather than a change to `delay` itself: every OTHER
   * caller of `delay` in this codebase is a backoff or pacing wait with no
   * signal to plumb, and `delay`'s own doc comment records that as
   * intentional. Re-checked with `signal.aborted` before racing the timer,
   * because a signal already aborted before this call will never fire another
   * `'abort'` event to listen for.
   */
  private waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return delay(ms);
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
