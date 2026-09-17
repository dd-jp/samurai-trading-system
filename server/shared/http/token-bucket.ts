/**
 * Client-side token bucket — the outbound half of rate-limit resilience.
 * `withRetry` handles the 429 after the venue has already rejected us;
 * this exists so we stop issuing the call that earns the 429 in the first
 * place — a rate-limited `createOrder` can leave a filled lot unprotected
 * for the backoff, or indefinitely if the key gets banned.
 *
 * Dependency-free and clock-injectable, like the rest of this codebase's
 * `Clock` usage — a bucket reading wall-clock directly can't be tested
 * without sleeping through real seconds.
 *
 * `TokenBucketTelemetry` is an OPTIONAL wait-observed log line (see
 * `take()` and the `TOKEN_BUCKET_WAIT_LOG_*` constants) so a starved fetch
 * can be confirmed or ruled out as an explanation for a session's
 * timeouts. Observation only — it never changes what `acquire()`/
 * `acquireBackground()` resolve on or when.
 */

import { safeLog } from '../safe-log.js';
import { currentTraceId } from '../trace-context.js';
import type { Logger } from '../types/primitives.js';
import { delay } from './delay.js';

export interface TokenBucketConfig {
  /** Burst size: how many calls may go out back-to-back from a full bucket */
  capacity: number;
  /** Steady-state rate the bucket sustains once the burst is spent */
  refillPerSecond: number;
  /**
   * Tokens `acquireBackground()` may not spend, reserved for `acquire()`.
   * One bucket paces two consumers of very different urgency (order
   * placement and market data) against a single per-account budget —
   * splitting into two buckets would re-create the over-subscription this
   * closes, but a shared bucket with no reserve lets a bar sweep drain it
   * and park an order behind the refill. Defaults to 0, today's behaviour
   * for every venue with a single consumer.
   */
  reserveForPriority?: number;
}

/** Which of the two lanes `take()` was called through — see `acquire()` vs `acquireBackground()` */
type TokenBucketLane = 'priority' | 'background';

/**
 * Optional wait-observed telemetry. A bucket built without this argument
 * behaves exactly as before — no import, no log line — so every
 * pre-existing call site still compiles unchanged.
 */
export interface TokenBucketTelemetry {
  logger: Logger;
  /**
   * Which bucket this is, e.g. `'alpaca'` — the venue/consumer label a
   * reader would use to tell two buckets' waits apart, not the class name.
   */
  name: string;
}

/**
 * A wait shorter than this is ordinary contention among concurrent callers
 * on a shared bucket, and logging every one would make a healthy run
 * noisy. Above it, on the fastest bucket wired in production (Alpaca, 2
 * tok/s), the caller has waited longer than two tokens' refill, which one
 * concurrent rival no longer explains — a real burst queue or the
 * priority reserve holding a background caller back.
 */
export const TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS = 1_000;

/**
 * A cardinality lever, not a severity change: at most one announcement per
 * lane per window, with crossings inside the window folded into the next
 * announcement (`suppressed_since_last`/`max_suppressed_wait_ms` in
 * `logIfMaterialWait`) rather than dropped silently.
 *
 * Sized to hold a 5% share of a 20h soak's structured log lines — see
 * `token-bucket.test.ts`'s "414/2102" comment for the reference counts
 * and the full worst-case derivation. Windowed PER LANE, not per bucket,
 * so a burst on one lane can't swallow the other's first announcement.
 *
 * Assumes ONE telemetry-wired bucket per process — true today because
 * `SAMURAI_BROKER` selects exactly one adapter, so the Alpaca and Saxo
 * buckets are never both wired at once. A process holding two at once
 * would double this budget and needs re-deriving.
 */
export const TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS = 45 * 60_000;

/**
 * Independent of the repeat window: a wait this long IS the module
 * header's motivating failure (unprotected filled lot), not ordinary
 * contention, so it is ALWAYS announced, never folded — losing it would
 * defeat the reason this telemetry exists.
 *
 * Per-lane rather than shared: a single bound was unreachable for
 * `priority` on the live Alpaca config and wrong-headed for `background`.
 * Chosen to equal the module header's own "eight seconds" example, so a
 * priority wait that trips this is, by that framing, the failure this
 * telemetry exists to surface.
 */
export const TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS =
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS * 8;

/**
 * `background`'s by-design worst case is far higher than `priority`'s (it
 * is the lane allowed to wait so `priority` does not), so this bound sits
 * well above ordinary contention — a soak crossing it is genuinely
 * exceptional. `background` waits carry no protective urgency (a late bar
 * fetch costs nothing an order fill would), so a suppressed-then-lost
 * crossing under this bound is accepted, unlike `priority`'s never-fold
 * guarantee.
 */
export const TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS =
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS * 30;

/**
 * In-memory, per lane, per bucket instance — not restart-clean. A
 * crossing suppressed here and never followed by a later same-lane
 * crossing before process exit is never announced.
 */
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
    // and starting empty would delay the first order for no protective gain
    this.tokens = config.capacity;
    this.lastRefill = now();
  }

  /**
   * Resolves when this caller owns a token — immediately if one is
   * available, otherwise after enough time has passed to mint one.
   *
   * The re-check LOOP is the whole correctness argument: several
   * `acquire()`s can park on an empty bucket at once, and computing a
   * wait once and consuming on wake would let every parked caller consume
   * the SAME refilled token and fire together — the exact burst this
   * bucket exists to prevent.
   *
   * `signal` is for a caller that may be ABANDONED rather than waited out
   * (a shutdown draining an ingest agent) — a parked `acquire()` has done
   * no work yet, so aborting it costs nothing.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    await this.take(0, 'priority', signal);
  }

  /**
   * Like `acquire()`, but leaves `reserveForPriority` tokens untouched.
   * For the consumer that can afford to wait (market data), so a burst of
   * bar fetches cannot park an order behind the refill — a background
   * caller on a drained bucket waits for the reserve to be re-minted ON
   * TOP of its own token, which is the intended cost.
   *
   * No `signal` parameter: nothing today abandons a background
   * market-data fetch on shutdown.
   */
  async acquireBackground(): Promise<void> {
    await this.take(this.config.reserveForPriority ?? 0, 'background');
  }

  private async take(reserve: number, lane: TokenBucketLane, signal?: AbortSignal): Promise<void> {
    const needed = 1 + reserve;
    // Wall-clock start, not a flag: most calls never park, so reading
    // `this.now()` once costs nothing on that common path. Uses the SAME
    // injected clock as `refill()` — a second clock here could disagree
    // under a faked timer and turn an instant grant into a phantom wait
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
      // every call forever rather than pace it
      const waitMs = ((needed - this.tokens) / this.config.refillPerSecond) * 1000;
      await this.waitOrAbort(Math.max(waitMs, 0), signal);
    }
  }

  /**
   * Silent by design: `undefined` telemetry, a wait under the threshold,
   * or a threshold-crossing wait under the lane's own catastrophic bound
   * inside its repeat window (folded into the next announcement instead
   * of lost — see `suppressed_since_last`/`max_suppressed_wait_ms`
   * below). A catastrophic wait is NEVER folded, window or not.
   *
   * Folding attributes a suppressed wait's magnitude to the announcing
   * call's `trace_id`/tick, not the tick it actually happened on — there
   * is no per-suppressed-event timestamp to attribute with; the
   * alternative is a timestamped line per occurrence, the exact
   * cardinality this window exists to bound.
   *
   * Event name `token_bucket_wait`, chosen to survive a grep a bare
   * `token` or `429` cannot (an LLM `input_tokens` field and any digit
   * run both false-positive on those).
   *
   * `waitedMs` uses the same injected clock as `refill()`, so a backward
   * wall-clock step mid-wait can compute a small or negative wait — which
   * then fails the threshold check and is silently dropped rather than
   * logged with a nonsense value. Accepted: rare, and cheaper than a
   * `wait_ms` field readers have to distrust.
   *
   * Runs AFTER `take()` has already granted the token, so a synchronous
   * throw from a custom `Logger` must not become a rejected
   * `acquire()`/`acquireBackground()` for a caller already paced —
   * `safeLog` is this same guarantee reused, not a fourth local
   * try/catch.
   */
  private logIfMaterialWait(lane: TokenBucketLane, waitedMs: number): void {
    if (this.telemetry === undefined) return;
    if (waitedMs < TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS) return;
    const roundedWaitMs = Math.round(waitedMs);
    const nowMs = this.now();
    const prior = this.waitAnnounce.get(lane);
    const catastrophicMs =
      lane === 'priority'
        ? TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS
        : TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS;
    if (
      prior !== undefined &&
      nowMs - prior.lastAnnouncedAtMs < TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS &&
      roundedWaitMs < catastrophicMs
    ) {
      prior.suppressedCount += 1;
      prior.maxSuppressedWaitMs = Math.max(prior.maxSuppressedWaitMs, roundedWaitMs);
      return;
    }
    // A bypass (a catastrophic wait announced while still inside the
    // window) still resets the window rather than adding a second line
    const catastrophicBypass =
      prior !== undefined &&
      nowMs - prior.lastAnnouncedAtMs < TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS;
    const suppressedSinceLast = prior?.suppressedCount ?? 0;
    const maxSuppressedWaitMs = prior?.maxSuppressedWaitMs ?? 0;
    this.waitAnnounce.set(lane, {
      lastAnnouncedAtMs: nowMs,
      suppressedCount: 0,
      maxSuppressedWaitMs: 0,
    });
    safeLog(this.telemetry.logger, {
      // The enclosing tick when there is one, so a pacing wait joins the
      // stage that waited; this is the ANNOUNCING call's tick, not
      // necessarily the folded waits' (see doc above)
      trace_id: currentTraceId() ?? 'token-bucket',
      stage: 'rate_limit',
      event: 'token_bucket_wait',
      // Pacing under a working bucket is expected behaviour, not a fault
      // to page on
      level: 'info',
      message:
        `token_bucket_wait: the '${this.telemetry.name}' bucket paced a ${lane} caller for ` +
        `${roundedWaitMs}ms before granting a token.` +
        (suppressedSinceLast > 0
          ? ` ${suppressedSinceLast} more threshold-crossing wait(s) on this lane were folded ` +
            `into this line since the last announcement, the longest ${maxSuppressedWaitMs}ms.`
          : ''),
      payload: {
        bucket: this.telemetry.name,
        lane,
        wait_ms: roundedWaitMs,
        catastrophic_bypass: catastrophicBypass,
        suppressed_since_last: suppressedSinceLast,
        max_suppressed_wait_ms: maxSuppressedWaitMs,
      },
    });
  }

  /**
   * `delay`, but abandoned the instant `signal` fires instead of ridden
   * out. Deliberately local rather than a change to `delay` itself: every
   * other caller of `delay` here is a backoff/pacing wait with no signal
   * to plumb. Re-checked with `signal.aborted` before racing the timer,
   * because an already-aborted signal never fires another `'abort'` event.
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

  /** Credits elapsed time as tokens, never above `capacity` (burst is bounded) */
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
