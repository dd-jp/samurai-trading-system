import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTraceId } from '../trace-context.js';
import type { LogEntry, Logger } from '../types/primitives.js';
import {
  TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS,
  TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS,
  TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS,
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
  TokenBucket,
} from './token-bucket.js';
import { DEFAULT_VENUE_PACING } from './venue-pacing.js';

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately while the bucket has tokens', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    const acquired: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await bucket.acquire();
        acquired.push(i);
      }),
    );

    expect(acquired).toHaveLength(3);
  });

  it('blocks once capacity is exhausted, then admits on refill', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    let admitted = false;
    const pending = bucket.acquire().then(() => {
      admitted = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(admitted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(admitted).toBe(true);
  });

  it('serializes concurrent acquires on an exhausted bucket instead of releasing them together', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    const order: string[] = [];
    const pending = Promise.all([
      bucket.acquire().then(() => order.push('a')),
      bucket.acquire().then(() => order.push('b')),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(order).toHaveLength(2);
  });

  it('refills over time and never above capacity', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });
    await bucket.acquire();
    await bucket.acquire();

    await vi.advanceTimersByTimeAsync(10_000);
    await bucket.acquire();
    await bucket.acquire();

    let admitted = false;
    const pending = bucket.acquire().then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(admitted).toBe(true);
  });

  it('paces a sustained run at the configured rate', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 2 });
    await bucket.acquire();

    let done = 0;
    const pending = Promise.all([
      bucket.acquire().then(() => {
        done += 1;
      }),
      bucket.acquire().then(() => {
        done += 1;
      }),
    ]);

    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(done).toBe(2);
  });
});

describe('TokenBucket abort signal (#702)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a parked acquire the instant the signal aborts, without waiting for refill', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.0001 });
    await bucket.acquire();

    const controller = new AbortController();
    const pending = bucket.acquire(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it('rejects instantly for an already-aborted signal, and leaves the token for the next caller', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(bucket.acquire(controller.signal)).rejects.toThrow();
    await expect(bucket.acquire()).resolves.toBeUndefined();
  });

  it('still blocks and admits normally when no signal is passed', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    let admitted = false;
    const pending = bucket.acquire().then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(admitted).toBe(true);
  });
});

describe('TokenBucket priority reserve (#391)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets an order through immediately after market data has drained everything it may spend', async () => {
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerSecond: 1,
      reserveForPriority: 4,
    });

    for (let i = 0; i < 6; i++) {
      await bucket.acquireBackground();
    }

    let orderPlaced = false;
    const order = bucket.acquire().then(() => {
      orderPlaced = true;
    });

    await order;
    expect(orderPlaced).toBe(true);
  });

  it('parks the next background call on a drained-to-reserve bucket', async () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1, reserveForPriority: 4 });
    for (let i = 0; i < 6; i++) {
      await bucket.acquireBackground();
    }

    let extra = false;
    const pending = bucket.acquireBackground().then(() => {
      extra = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(extra).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(extra).toBe(true);
  });

  it('is inert without a reserve — the single-consumer venues are unchanged', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });

    await bucket.acquireBackground();
    await bucket.acquireBackground();

    let third = false;
    const pending = bucket.acquireBackground().then(() => {
      third = true;
    });
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(third).toBe(true);
  });
});

describe('TokenBucket wait telemetry (#1083)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs nothing for an instant grant, even with telemetry configured', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });

    await bucket.acquire();
    await bucket.acquireBackground();

    expect(entries).toHaveLength(0);
  });

  it('logs nothing for a wait under the threshold', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 10 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const pending = bucket.acquire();
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(entries).toHaveLength(0);
  });

  it('logs a wait at or beyond the threshold, naming the bucket and the priority lane', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const pending = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await pending;

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.level).toBe('info');
    expect(entry.message).toContain('token_bucket_wait');
    expect(entry.event).toBe('token_bucket_wait');
    expect(entry.payload).toMatchObject({
      bucket: 'alpaca',
      lane: 'priority',
      wait_ms: expect.any(Number),
    });
    expect((entry.payload as { wait_ms: number }).wait_ms).toBeGreaterThanOrEqual(
      TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
    );
  });

  it('labels a background wait distinctly from a priority wait, since only background is subject to the reserve', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(
      { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
      undefined,
      { logger, name: 'alpaca' },
    );
    await bucket.acquireBackground();

    const pending = bucket.acquireBackground();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await pending;

    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ lane: 'background' });
  });

  it('produces no telemetry at all when none is configured — pacing is unaffected either way', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    let admitted = false;
    const pending = bucket.acquire().then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(admitted).toBe(true);
  });

  it('does not reject the caller, and still grants the token, when the logger throws', async () => {
    const throwingLogger: Logger = {
      log: () => {
        throw new Error('sink is down');
      },
    };
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger: throwingLogger,
      name: 'alpaca',
    });
    await bucket.acquire();

    let admitted = false;
    let rejected: unknown;
    const pending = bucket
      .acquire()
      .then(() => {
        admitted = true;
      })
      .catch((error: unknown) => {
        rejected = error;
      });
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await pending;

    expect(admitted).toBe(true);
    expect(rejected).toBeUndefined();
  });

  it('labels the wait with the enclosing tick, so a pacing wait can be joined to the stage that waited', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });

    await runWithTraceId('tick-abc', async () => {
      await bucket.acquire();
      const pending = bucket.acquire();
      await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
      await pending;
    });

    expect(entries[0]?.trace_id).toBe('tick-abc');
  });

  it('labels a background wait with the tick too', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(
      { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
      undefined,
      { logger, name: 'alpaca' },
    );

    await runWithTraceId('tick-xyz', async () => {
      await bucket.acquireBackground();
      const pending = bucket.acquireBackground();
      await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
      await pending;
    });

    expect(entries[0]).toMatchObject({ trace_id: 'tick-xyz', payload: { lane: 'background' } });
  });

  it("falls back to 'token-bucket' outside a tick, where there is no trace to name", async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const pending = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await pending;

    expect(entries[0]?.trace_id).toBe('token-bucket');
  });
});

describe('TokenBucket wait telemetry repeat window (#1435)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses a threshold-crossing wait inside the repeat window, then re-announces carrying what it suppressed', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const first = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await first;
    expect(entries).toHaveLength(1);

    const second = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await second;
    expect(entries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS);
    await bucket.acquire();
    const third = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await third;

    expect(entries).toHaveLength(2);
    expect(entries[1]?.payload).toMatchObject({
      lane: 'priority',
      suppressed_since_last: 1,
      max_suppressed_wait_ms: TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
    });
  });

  it("keeps each lane's repeat window independent, so a background announcement cannot mask a priority lane's first crossing", async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(
      { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
      undefined,
      { logger, name: 'alpaca' },
    );
    await bucket.acquireBackground();

    const bgWait = bucket.acquireBackground();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await bgWait;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ lane: 'background', suppressed_since_last: 0 });

    const priorityWait = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await priorityWait;

    expect(entries).toHaveLength(2);
    expect(entries[1]?.payload).toMatchObject({ lane: 'priority', suppressed_since_last: 0 });
  });

  it('folds two or more suppressed crossings into the next announcement, reporting the true count and the true max — not the announcing wait itself', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const order: number[] = [];
    const pending = Promise.all(
      [1, 2, 3].map(async (i) => {
        await bucket.acquire();
        order.push(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(order).toEqual([1, 2, 3]);
    expect(entries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS);
    await bucket.acquire();
    const fourth = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await fourth;

    expect(entries).toHaveLength(2);
    const [, announcement] = entries;
    expect(announcement?.payload).toMatchObject({
      suppressed_since_last: 2,
      max_suppressed_wait_ms: 3_000,
    });
    const payload = announcement?.payload as { wait_ms: number };
    expect(payload.wait_ms).toBeLessThan(3_000);
    expect(announcement?.message).toContain('2 more threshold-crossing wait');
    expect(announcement?.message).toContain('3000ms');
  });

  it('always announces a priority wait at or past its catastrophic bound, even inside an active repeat window, folding in whatever was suppressed first', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, undefined, {
      logger,
      name: 'alpaca',
    });
    await bucket.acquire();

    const raceCount =
      TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS / TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS;
    const order: number[] = [];
    const pending = Promise.all(
      Array.from({ length: raceCount }, (_, i) => i + 1).map(async (i) => {
        await bucket.acquire();
        order.push(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS);
    await pending;
    expect(order).toHaveLength(raceCount);

    expect(entries).toHaveLength(2);
    const [firstAnnouncement, catastrophicAnnouncement] = entries;
    expect(firstAnnouncement?.payload).toMatchObject({
      suppressed_since_last: 0,
      catastrophic_bypass: false,
    });
    expect(catastrophicAnnouncement?.payload).toMatchObject({
      wait_ms: TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS,
      catastrophic_bypass: true,
      suppressed_since_last: raceCount - 2,
      max_suppressed_wait_ms: (raceCount - 1) * TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
    });
  });

  it("never bypasses a background wait below its own (higher) catastrophic bound, even at the priority lane's bound", async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(
      { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
      undefined,
      { logger, name: 'alpaca' },
    );
    await bucket.acquireBackground();

    const raceCount =
      TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS / TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS;
    const order: number[] = [];
    const pending = Promise.all(
      Array.from({ length: raceCount }, (_, i) => i + 1).map(async (i) => {
        await bucket.acquireBackground();
        order.push(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS);
    await pending;
    expect(order).toHaveLength(raceCount);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ lane: 'background', catastrophic_bypass: false });

    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS);
    await bucket.acquireBackground();
    const trailing = bucket.acquireBackground();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await trailing;

    expect(entries).toHaveLength(2);
    expect(entries[1]?.payload).toMatchObject({
      lane: 'background',
      suppressed_since_last: raceCount - 1,
      catastrophic_bypass: false,
    });
  });

  it('reaches the priority catastrophic bound on the live Alpaca pacing config', async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(DEFAULT_VENUE_PACING.alpaca, undefined, {
      logger,
      name: 'alpaca',
    });

    for (let i = 0; i < DEFAULT_VENUE_PACING.alpaca.capacity; i++) {
      await bucket.acquire();
    }

    const opening = Promise.all([bucket.acquire(), bucket.acquire()]);
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ suppressed_since_last: 0 });

    const raceCount = 16;
    const order: number[] = [];
    const pending = Promise.all(
      Array.from({ length: raceCount }, (_, i) => i + 1).map(async (i) => {
        await bucket.acquire();
        order.push(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(raceCount * 500);
    await pending;
    expect(order).toHaveLength(raceCount);

    expect(entries).toHaveLength(2);
    const [, bypassAnnouncement] = entries;
    expect(bypassAnnouncement?.payload).toMatchObject({
      bucket: 'alpaca',
      lane: 'priority',
      wait_ms: TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_PRIORITY_MS,
      catastrophic_bypass: true,
      suppressed_since_last: 14,
      max_suppressed_wait_ms: 7_500,
    });
  });

  it("confirms background's by-design ~20.5s worst case on the live Alpaca config stays below its own catastrophic bound", async () => {
    const { logger, entries } = recordingLogger();
    const bucket = new TokenBucket(DEFAULT_VENUE_PACING.alpaca, undefined, {
      logger,
      name: 'alpaca',
    });
    for (let i = 0; i < DEFAULT_VENUE_PACING.alpaca.capacity; i++) {
      await bucket.acquire();
    }

    const raceCount = 20;
    const order: number[] = [];
    const pending = Promise.all(
      Array.from({ length: raceCount }, (_, i) => i + 1).map(async (i) => {
        await bucket.acquireBackground();
        order.push(i);
      }),
    );
    const expectedLastWaitMs = 11_000 + (raceCount - 1) * 500;
    expect(expectedLastWaitMs).toBeLessThan(TOKEN_BUCKET_WAIT_LOG_CATASTROPHIC_BACKGROUND_MS);
    await vi.advanceTimersByTimeAsync(expectedLastWaitMs);
    await pending;
    expect(order).toHaveLength(raceCount);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toMatchObject({ lane: 'background', catastrophic_bypass: false });
  });
});
