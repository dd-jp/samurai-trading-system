import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';

const DAY_1 = new Date('2026-08-01T00:00:00.000Z');
const DAY_2 = new Date('2026-08-02T00:00:00.000Z');

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-daily-equity-'));
  return {
    path: join(dir, 'test.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SqliteDailyEquityStore', () => {
  it('appends one observation per session, oldest first', () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new SqliteDailyEquityStore(openSharedStore(path));
      // Written out of order on purpose: the reader differences adjacent rows,
      // so it must sort rather than trust insertion order.
      store.append(DAY_2, 101_000, new Date('2026-08-02T00:01:00.000Z'), true);
      store.append(DAY_1, 100_000, new Date('2026-08-01T09:30:00.000Z'), false);

      expect(store.all()).toEqual([
        {
          session_start: DAY_1,
          equity: 100_000,
          recorded_at: new Date('2026-08-01T09:30:00.000Z'),
          observed_at_boundary: false,
        },
        {
          session_start: DAY_2,
          equity: 101_000,
          recorded_at: new Date('2026-08-02T00:01:00.000Z'),
          observed_at_boundary: true,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it('keeps the FIRST observation of a session — a later tick must not overwrite the open', () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new SqliteDailyEquityStore(openSharedStore(path));
      store.append(DAY_1, 100_000, new Date('2026-08-01T00:01:00.000Z'), true);
      // Same session, hours later, after the account moved. Overwriting here
      // would turn the daily OPEN into a rolling intraday sample and the series
      // would stop being a daily series at all.
      store.append(DAY_1, 88_000, new Date('2026-08-01T15:00:00.000Z'), true);

      expect(store.all()).toHaveLength(1);
      expect(store.all()[0]?.equity).toBe(100_000);
    } finally {
      cleanup();
    }
  });

  it('survives a restart — the series is durable, not per-process', () => {
    const { path, cleanup } = tempPath();
    try {
      new SqliteDailyEquityStore(openSharedStore(path)).append(DAY_1, 100_000, DAY_1, true);

      // A brand-new handle onto the same file, as a restarted process gets.
      // A return series cannot be backfilled: if a restart lost the history,
      // every soak would begin again from zero observations and the kill-lines
      // could never accumulate a usable sample.
      const reopened = new SqliteDailyEquityStore(openSharedStore(path));
      expect(reopened.all()).toHaveLength(1);
      expect(reopened.all()[0]?.equity).toBe(100_000);

      // And the restarted process must not clobber the genuine open it finds.
      reopened.append(DAY_1, 71_000, new Date('2026-08-01T18:00:00.000Z'), false);
      expect(reopened.all()[0]?.equity).toBe(100_000);
      expect(reopened.all()[0]?.observed_at_boundary).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-finite observation rather than poisoning the series', () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new SqliteDailyEquityStore(openSharedStore(path));
      // NaN propagates through the mean and stdev into every ratio, and then
      // compares false against every kill threshold — the lines would stop
      // firing silently rather than fail.
      expect(() => store.append(DAY_1, Number.NaN, DAY_1, true)).toThrow(/must be finite/);
      expect(store.all()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
