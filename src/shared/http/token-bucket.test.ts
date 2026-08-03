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
