import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../shared/clock.js';
import type { CiiScoreProvider } from './cii-consumer.js';
import { type CiiSnapshotRow, type CiiSnapshotStore, captureCiiSnapshot } from './cii-snapshot.js';

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

function stubProvider(scores: Record<string, number | null>): CiiScoreProvider {
  return {
    getCii: vi.fn(async (country: string) => scores[country] ?? null),
  };
}

class RecordingStore implements CiiSnapshotStore {
  readonly rows: CiiSnapshotRow[] = [];
  record(row: CiiSnapshotRow): void {
    this.rows.push(row);
  }
}

const NOW = new Date('2026-07-27T00:00:00Z');

describe('captureCiiSnapshot', () => {
  it('records one row per requested country at the clock time', async () => {
    const store = new RecordingStore();

    await captureCiiSnapshot(
      ['RU', 'SA'],
      stubProvider({ RU: 72, SA: 30 }),
      store,
      new FixedClock(NOW),
    );

    expect(store.rows).toEqual([
      { country_code: 'RU', score: 72, captured_at: NOW },
      { country_code: 'SA', score: 30, captured_at: NOW },
    ]);
  });

  it('skips a country the provider has no score for, rather than recording null', async () => {
    const store = new RecordingStore();

    await captureCiiSnapshot(['RU', 'ZZ'], stubProvider({ RU: 72 }), store, new FixedClock(NOW));

    expect(store.rows).toEqual([{ country_code: 'RU', score: 72, captured_at: NOW }]);
  });

  it("logs and skips a country whose provider call rejects, without dropping the others'", async () => {
    const provider: CiiScoreProvider = {
      getCii: vi.fn(async (country: string) => {
        if (country === 'RU') {
          throw new Error('WorldMonitor timeout');
        }
        return 30;
      }),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new RecordingStore();

    await captureCiiSnapshot(['RU', 'SA'], provider, store, new FixedClock(NOW));

    expect(store.rows).toEqual([{ country_code: 'SA', score: 30, captured_at: NOW }]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs and skips a country whose store.record throws, without dropping the others'", async () => {
    const recorded: CiiSnapshotRow[] = [];
    const store: CiiSnapshotStore = {
      record: (row: CiiSnapshotRow) => {
        if (row.country_code === 'RU') {
          throw new Error('score out of range');
        }
        recorded.push(row);
      },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await captureCiiSnapshot(
      ['RU', 'SA'],
      stubProvider({ RU: 101, SA: 30 }),
      store,
      new FixedClock(NOW),
    );

    expect(recorded).toEqual([{ country_code: 'SA', score: 30, captured_at: NOW }]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('is a no-op on an empty country list', async () => {
    const store = new RecordingStore();

    await captureCiiSnapshot([], stubProvider({}), store, new FixedClock(NOW));

    expect(store.rows).toEqual([]);
  });
});
