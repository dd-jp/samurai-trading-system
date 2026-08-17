import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from './token-bucket.js';

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
