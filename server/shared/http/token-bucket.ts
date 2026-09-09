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
 * OPTIONAL wait-observed log line; see `take()`, `TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS`
 * and `TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS` for what gets logged, when, and
 * how often. It does not change what `acquire()`/`acquireBackground()` resolve
 * on or when — observation only, never a second control on pacing.
 */

import { safeLog } from '../safe-log.js';
import { currentTraceId } from '../trace-context.js';
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

/**
 * #1435: severity alone (#1383, `token_bucket_wait` moved to `info`) does not
 * move the event's raw line count — only the threshold does, and raising it
 * is out of scope for the reason #1383 didn't touch it either (it would hide
 * genuine starvation, the whole point of #1083). This is the cardinality
 * lever instead: at most one announcement per lane per window; crossings
 * inside the window are counted and folded into the next announcement
 * (`suppressed_since_last`/`max_suppressed_wait_ms` in `logIfMaterialWait`)
 * rather than dropped silently.
 *
 * Sized off #1383's own reference 20h soak (2102 structured lines, of which
 * `token_bucket_wait` was 414 — token-bucket.test.ts's "414/2102" comment).
 * Held to a self-consistent 5% AC (#1383's own, unmet for this event and
 * deferred here): with the 414 raw lines replaced by `x` announcements, the
 * total line count becomes `1090 + x` (1504 projected post-#1383 total minus
 * the 414 this change replaces), so clearing 5% requires `x <= 0.05*(1090+x)`,
 * i.e. `x <= ~57`. Windowed PER LANE (not per bucket — a burst on one lane
 * must not swallow the other's first announcement, see `logIfMaterialWait`),
 * so the worst case is two lines per window: `2 * (20h / W) <= 57` needs
 * `W >= ~42min`. 45 minutes clears that with margin (~53 lines worst case,
 * fewer if only one lane is actually active in a given soak). This is a
 * projection, not a re-measurement: no raw soak log survives to replay the
 * real clustering of waits, only the aggregate counts above.
 */
export const TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS = 45 * 60_000;

interface LaneWaitAnnounce {
  lastAnnouncedAtMs: number;
  suppressedCount: number;
  maxSuppressedWaitMs: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly waitAnnounce = new Map<TokenBucketLane, LaneWaitAnnounce>();

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
   * #1083. `undefined` telemetry (every call site that hasn't wired it), a
   * wait under the threshold, and — #1435 — a threshold-crossing wait inside
   * the announcing lane's repeat window are all silent by design; see
   * `TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS` for why the second is a floor and
   * not a lower one, and `TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS` for the
   * third. The third case is not lost, only folded into the next
   * announcement for that lane (`suppressed_since_last`/`max_suppressed_wait_ms`
   * below) — cardinality reduction, not information destruction.
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
   * wall-clock step mid-wait can make a genuine wait compute small or
   * negative. The threshold check right below is what that actually hits:
   * a negative or shrunk `waitedMs` fails `>= TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS`
   * the same as a short real wait would, so the line is silently dropped
   * rather than logged with a nonsense value. Accepted: an NTP step is rare
   * enough, and losing one line to it is a smaller cost than a `wait_ms`
   * field a reader has to distrust on every line. The same backward-step
   * case can also delay the window's own re-announcement by making `nowMs`
   * read earlier than it should — same acceptance, same rarity.
   *
   * Runs AFTER `take()` has already decremented `this.tokens` (the caller has
   * been granted its token by the time this is called) and `take()` is
   * `async`, so a synchronous throw from `this.telemetry.logger.log` here
   * would otherwise become a REJECTED `acquire()`/`acquireBackground()` for a
   * caller pacing already granted — an observation-only mechanism turning
   * into a spurious order-submit failure on the production broker path if a
   * custom or buggy `Logger` throws. `safeLog` (shared/safe-log.ts, #573) is
   * exactly this guarantee already extracted once for the identical reason at
   * three other call sites — reused rather than a fourth local try/catch.
   */
  private logIfMaterialWait(lane: TokenBucketLane, waitedMs: number): void {
    if (this.telemetry === undefined) return;
    if (waitedMs < TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS) return;
    const roundedWaitMs = Math.round(waitedMs);
    const nowMs = this.now();
    const prior = this.waitAnnounce.get(lane);
    if (
      prior !== undefined &&
      nowMs - prior.lastAnnouncedAtMs < TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS
    ) {
      prior.suppressedCount += 1;
      prior.maxSuppressedWaitMs = Math.max(prior.maxSuppressedWaitMs, roundedWaitMs);
      return;
    }
    const suppressedSinceLast = prior?.suppressedCount ?? 0;
    const maxSuppressedWaitMs = prior?.maxSuppressedWaitMs ?? 0;
    this.waitAnnounce.set(lane, {
      lastAnnouncedAtMs: nowMs,
      suppressedCount: 0,
      maxSuppressedWaitMs: 0,
    });
    safeLog(this.telemetry.logger, {
      // The enclosing tick when there is one, so a pacing wait joins to the
      // stage that waited; `'token-bucket'` only outside one. Deliberately
      // not derived from `lane` — see shared/trace-context.ts.
      trace_id: currentTraceId() ?? 'token-bucket',
      stage: 'rate_limit',
      event: 'token_bucket_wait',
      // #1383: pacing under a working bucket is expected behaviour, not a
      // fault to page on — `TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS` above is what
      // still keeps genuine starvation visible.
      level: 'info',
      message:
        `token_bucket_wait: the '${this.telemetry.name}' bucket paced a ${lane} caller for ` +
        `${roundedWaitMs}ms before granting a token.`,
      payload: {
        bucket: this.telemetry.name,
        lane,
        wait_ms: roundedWaitMs,
        suppressed_since_last: suppressedSinceLast,
        max_suppressed_wait_ms: maxSuppressedWaitMs,
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
