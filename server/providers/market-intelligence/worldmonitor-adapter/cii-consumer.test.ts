import type { Clock } from '../../../shared/index.js';
import { CiiConsumer, type CiiScoreProvider } from './cii-consumer.js';

class MutableClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advanceTo(at: Date): void {
    this.at = at;
  }
}

function stubProvider(scores: Record<string, number | null>): CiiScoreProvider {
  return {
    getCii: vi.fn(async (country: string) => scores[country] ?? null),
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CiiConsumer', () => {
  it('has no score for a country before any poll has completed', () => {
    const consumer = new CiiConsumer(
      stubProvider({ RU: 72 }),
      new MutableClock(new Date('2026-07-26T00:00:00Z')),
      { pollIntervalMs: 600_000 },
    );

    expect(consumer.getScores(['RU'])).toEqual({});
  });

  it('serves the cached score after a background refresh resolves', async () => {
    const provider = stubProvider({ RU: 72 });
    const consumer = new CiiConsumer(provider, new MutableClock(new Date('2026-07-26T00:00:00Z')), {
      pollIntervalMs: 600_000,
    });

    consumer.getScores(['RU']);
    await flushMicrotasks();

    expect(consumer.getScores(['RU'])).toEqual({ RU: 72 });
    expect(provider.getCii).toHaveBeenCalledTimes(1);
  });

  it('omits a country WorldMonitor has never returned a score for, rather than defaulting to 0', async () => {
    const consumer = new CiiConsumer(
      stubProvider({}),
      new MutableClock(new Date('2026-07-26T00:00:00Z')),
      { pollIntervalMs: 600_000 },
    );

    consumer.getScores(['ZZ']);
    await flushMicrotasks();

    expect(consumer.getScores(['ZZ'])).toEqual({});
  });

  it('serves stale cache without re-polling until pollIntervalMs elapses', async () => {
    const clock = new MutableClock(new Date('2026-07-26T00:00:00Z'));
    const provider = stubProvider({ RU: 72 });
    const consumer = new CiiConsumer(provider, clock, { pollIntervalMs: 600_000 });

    consumer.getScores(['RU']);
    await flushMicrotasks();
    expect(provider.getCii).toHaveBeenCalledTimes(1);

    clock.advanceTo(new Date('2026-07-26T00:05:00Z'));
    consumer.getScores(['RU']);
    await flushMicrotasks();
    expect(provider.getCii).toHaveBeenCalledTimes(1);

    clock.advanceTo(new Date('2026-07-26T00:10:01Z'));
    consumer.getScores(['RU']);
    await flushMicrotasks();
    expect(provider.getCii).toHaveBeenCalledTimes(2);
  });

  it('logs and keeps serving the prior cached value when a refresh rejects', async () => {
    const clock = new MutableClock(new Date('2026-07-26T00:00:00Z'));
    const provider: CiiScoreProvider = {
      getCii: vi
        .fn()
        .mockResolvedValueOnce(72)
        .mockRejectedValueOnce(new Error('WorldMonitor timeout')),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consumer = new CiiConsumer(provider, clock, { pollIntervalMs: 600_000 });

    consumer.getScores(['RU']);
    await flushMicrotasks();
    expect(consumer.getScores(['RU'])).toEqual({ RU: 72 });

    clock.advanceTo(new Date('2026-07-26T00:10:01Z'));
    consumer.getScores(['RU']);
    await flushMicrotasks();

    expect(consumer.getScores(['RU'])).toEqual({ RU: 72 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
