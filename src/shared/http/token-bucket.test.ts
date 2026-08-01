import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimited } from './rate-limited-client.js';
import { TokenBucket, UNLIMITED } from './token-bucket.js';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a non-positive capacity or refill rate', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow('capacity >= 1');
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow('capacity >= 1');
  });

  it('grants burst capacity without waiting', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, () => Date.now());

    let granted = 0;
    await Promise.all(
      [1, 2, 3].map(async () => {
        await bucket.acquire();
        granted += 1;
      }),
    );

    expect(granted).toBe(3);
  });

  it('makes a caller past the burst wait for the refill', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, () => Date.now());
    await bucket.acquire();

    let granted = false;
    const second = bucket.acquire().then(() => {
      granted = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await second;
    expect(granted).toBe(true);
  });

  it('refills up to capacity, never beyond', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, () => Date.now());
    await bucket.acquire();
    await bucket.acquire();

    // Ten seconds refills far more than 2 tokens' worth — the cap holds it at 2.
    await vi.advanceTimersByTimeAsync(10_000);
    await bucket.acquire();
    await bucket.acquire();

    let granted = false;
    const third = bucket.acquire().then(() => {
      granted = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(granted).toBe(true);
  });
});

describe('rateLimited', () => {
  it('takes a token before every method call', async () => {
    const acquisitions: number[] = [];
    let counter = 0;
    const limiter = {
      acquire: async () => {
        counter += 1;
        acquisitions.push(counter);
      },
    };
    const client = {
      async ping(value: string): Promise<string> {
        return `pong:${value}`;
      },
    };

    const paced = rateLimited(client, limiter);

    await expect(paced.ping('a')).resolves.toBe('pong:a');
    await expect(paced.ping('b')).resolves.toBe('pong:b');
    expect(acquisitions).toEqual([1, 2]);
  });

  it('passes non-function properties through untouched', () => {
    const client = { name: 'kraken', async call(): Promise<void> {} };
    expect(rateLimited(client, UNLIMITED).name).toBe('kraken');
  });
});
