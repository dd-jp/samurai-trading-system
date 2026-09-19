import { safeLog } from '../safe-log.js';
import { currentTraceId } from '../trace-context.js';
import type { Logger } from '../types/primitives.js';
import { delay } from './delay.js';

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
  reserveForPriority?: number;
}

type TokenBucketLane = 'priority' | 'background';

export interface TokenBucketTelemetry {
  logger: Logger;
  name: string;
}

export const TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS = 1_000;

export const TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS = 45 * 60_000;

export const TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS =
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS * 8;

export const TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS =
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS * 30;

interface LaneWaitAnnounce {
  lastAnnouncedAtMs: number;
  suppressedCount: number;
  maxSuppressedWaitMs: number;
}

function catastrophicThresholdMs(lane: TokenBucketLane): number {
  return lane === 'priority'
    ? TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS
    : TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS;
}

function withinRepeatWindow(prior: LaneWaitAnnounce | undefined, nowMs: number): boolean {
  return (
    prior !== undefined && nowMs - prior.lastAnnouncedAtMs < TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS
  );
}

function waitAnnounceMessage(
  bucketName: string,
  lane: TokenBucketLane,
  roundedWaitMs: number,
  suppressedSinceLast: number,
  maxSuppressedWaitMs: number,
): string {
  return (
    `token_bucket_wait: the '${bucketName}' bucket paced a ${lane} caller for ` +
    `${roundedWaitMs}ms before granting a token.` +
    (suppressedSinceLast > 0
      ? ` ${suppressedSinceLast} more threshold-crossing wait(s) on this lane were folded ` +
        `into this line since the last announcement, the longest ${maxSuppressedWaitMs}ms.`
      : '')
  );
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
    this.tokens = config.capacity;
    this.lastRefill = now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    await this.take(0, 'priority', signal);
  }

  async acquireBackground(): Promise<void> {
    await this.take(this.config.reserveForPriority ?? 0, 'background');
  }

  private async take(reserve: number, lane: TokenBucketLane, signal?: AbortSignal): Promise<void> {
    const needed = 1 + reserve;
    const startedAt = this.now();
    while (true) {
      signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= needed) {
        this.tokens -= 1;
        this.logIfMaterialWait(lane, this.now() - startedAt);
        return;
      }
      const waitMs = ((needed - this.tokens) / this.config.refillPerSecond) * 1000;
      await this.waitOrAbort(Math.max(waitMs, 0), signal);
    }
  }

  private logIfMaterialWait(lane: TokenBucketLane, waitedMs: number): void {
    if (this.telemetry === undefined) return;
    if (waitedMs < TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS) return;
    const roundedWaitMs = Math.round(waitedMs);
    const nowMs = this.now();
    const prior = this.waitAnnounce.get(lane);
    const catastrophicMs = catastrophicThresholdMs(lane);
    const inRepeatWindow = withinRepeatWindow(prior, nowMs);
    if (prior !== undefined && inRepeatWindow && roundedWaitMs < catastrophicMs) {
      prior.suppressedCount += 1;
      prior.maxSuppressedWaitMs = Math.max(prior.maxSuppressedWaitMs, roundedWaitMs);
      return;
    }
    const catastrophicBypass = inRepeatWindow;
    const suppressedSinceLast = prior?.suppressedCount ?? 0;
    const maxSuppressedWaitMs = prior?.maxSuppressedWaitMs ?? 0;
    this.waitAnnounce.set(lane, {
      lastAnnouncedAtMs: nowMs,
      suppressedCount: 0,
      maxSuppressedWaitMs: 0,
    });
    safeLog(this.telemetry.logger, {
      trace_id: currentTraceId() ?? 'token-bucket',
      stage: 'rate_limit',
      event: 'token_bucket_wait',
      level: 'info',
      message: waitAnnounceMessage(
        this.telemetry.name,
        lane,
        roundedWaitMs,
        suppressedSinceLast,
        maxSuppressedWaitMs,
      ),
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
