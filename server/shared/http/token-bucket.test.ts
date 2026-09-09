import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTraceId } from '../trace-context.js';
import type { LogEntry, Logger } from '../types/primitives.js';
import {
  TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS,
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
  TokenBucket,
} from './token-bucket.js';

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

// Vitest's fake timers stub `Date.now` alongside `setTimeout`, so the bucket's
// default clock advances in lockstep with `advanceTimersByTimeAsync` — same
// convention as retry.test.ts, and the reason no hand-rolled clock is injected
// here (one that drifted from the timers would hang the refill loop instead of
// failing).
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

    // No timer had to fire: the burst is what `capacity` buys.
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
    // The failure this guards: computing a wait once and consuming on wake
    // lets both parked callers take the same refilled token and fire in the
    // same instant — the burst the bucket exists to prevent. Adapters do issue
    // concurrent calls (Promise.all over two protective legs).
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

    // Ten seconds of idle credits far more than two tokens; the cap must hold,
    // so exactly two acquires are free and the third waits a full second.
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

    // 2/second → one token every 500ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(done).toBe(2);
  });
});

/**
 * #702: a caller parked on `acquire()` has done no work yet, so a shutdown
 * abandoning it should not wait out any part of the refill. No timers are
 * ever advanced in these tests — the whole point is that the rejection does
 * not depend on time passing.
 */
describe('TokenBucket abort signal (#702)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a parked acquire the instant the signal aborts, without waiting for refill', async () => {
    // A near-zero refill rate: if this ever actually waited it out, the test
    // would hang (or blow vitest's default timeout) rather than pass.
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
    // The aborted call never took the token — an unsignalled caller still
    // acquires immediately.
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

/**
 * #391's acceptance criterion: "order placement cannot be starved behind a
 * market-data burst". One bucket paces both consumers because Alpaca's limit
 * is per account, so the reserve is what keeps the shared budget safe for the
 * consumer that cannot wait.
 */
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

    // Background callers may spend down to the reserve and no further: 6 of 10.
    for (let i = 0; i < 6; i++) {
      await bucket.acquireBackground();
    }

    let orderPlaced = false;
    const order = bucket.acquire().then(() => {
      orderPlaced = true;
    });

    // No timer advance: the reserve is still there, so the order does not wait
    // for a refill even though market data just took every token it could.
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

    // A background caller needs 1 + reserve = 5 tokens present, and 4 remain,
    // so it waits a full second for the fifth to be minted.
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

/**
 * #1083: a caller that waits for a token was completely silent — a starved
 * fetch and an instant one produced the same (nonexistent) trace. These pin
 * the telemetry that closes that gap, WITHOUT changing when a token is
 * granted — every assertion above this block still passes unmodified with
 * telemetry wired in, which is the proof pacing itself did not move.
 */
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
    // 10 tok/s: the second acquire waits 100ms, well under the threshold.
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
    // 1 tok/s: the second acquire waits exactly the threshold.
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
    // #1383: pacing under a working bucket is normal operation, not a fault —
    // `warn` here just added to the soak's warn-share without signaling anything
    // actionable (pre-#1435 raw count: 414/2102 lines, 19.7% of one soak, none
    // of it starvation; #1435 adds the per-lane repeat window that bounds this).
    expect(entry.level).toBe('info');
    // Grep-distinguishable: neither an LLM token-count field (`input_tokens`)
    // nor a bare digit run (`429`) can match this event name.
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

  /**
   * Bot review on PR #1091: `take()` decrements `this.tokens` BEFORE logging
   * the wait, so a throwing `Logger.log` — a buggy or custom sink — must not
   * be able to reject `acquire()`/`acquireBackground()` for a caller pacing
   * already granted. On the production broker path that would convert a
   * logging fault into a spurious order-submit failure. Observation must
   * never be able to break the control path.
   */
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

  /** The lane must not narrow the trace — see shared/trace-context.ts. */
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

/**
 * #1435: severity alone (#1383) does not move `token_bucket_wait`'s raw line
 * count — a per-lane repeat window does. These pin that a burst of
 * threshold-crossing waits on one lane collapses to one line per window, and
 * that the suppressed occurrences ride in the next announcement rather than
 * vanishing.
 */
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

    // Same lane, still well inside the repeat window: suppressed, not a
    // second line, but tracked so the next announcement can report it.
    const second = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await second;
    expect(entries).toHaveLength(1);

    // Let the bucket sit idle past the repeat window (tokens simply refill to
    // capacity and cap there), then force one more threshold-crossing wait.
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_REPEAT_WINDOW_MS);
    await bucket.acquire(); // instant: the idle capacity-1 bucket refilled.
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

    // A priority wait immediately after, well inside the background lane's
    // repeat window, must still announce — it is a different lane's first
    // crossing, not a repeat of the background one.
    const priorityWait = bucket.acquire();
    await vi.advanceTimersByTimeAsync(TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS);
    await priorityWait;

    expect(entries).toHaveLength(2);
    expect(entries[1]?.payload).toMatchObject({ lane: 'priority', suppressed_since_last: 0 });
  });
});
