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

      const reopened = new SqliteDailyEquityStore(openSharedStore(path));
      expect(reopened.all()).toHaveLength(1);
      expect(reopened.all()[0]?.equity).toBe(100_000);

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
      expect(() => store.append(DAY_1, Number.NaN, DAY_1, true)).toThrow(/must be finite/);
      expect(store.all()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
