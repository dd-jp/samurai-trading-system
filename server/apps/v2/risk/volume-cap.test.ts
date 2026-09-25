import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import { averageDailyNotional, volumeCapShares } from './volume-cap.js';

function bar(date: string, close: number, volume: number): V2Bar {
  return { date, open: close, high: close, low: close, close, volume, rawClose: close * 4 };
}

describe('averageDailyNotional', () => {
  const window = [bar('2026-09-22', 10, 100), bar('2026-09-23', 20, 50), bar('2026-09-24', 5, 0)];

  it('averages adjusted close times volume over the last window bars', () => {
    expect(averageDailyNotional([bar('2026-09-01', 1, 1e9), ...window], 3, '2026-09-25')).toBe(
      (1_000 + 1_000 + 0) / 3,
    );
  });

  it('refuses a short, stale or gapped window', () => {
    expect(averageDailyNotional(window.slice(1), 3, '2026-09-25')).toBeUndefined();
    expect(averageDailyNotional(window, 3, '2026-09-30')).toBeUndefined();
    expect(averageDailyNotional(window, 3, '2026-09-29')).toBe(2_000 / 3);
    const gapped = [bar('2026-09-05', 10, 100), ...window.slice(1)];
    expect(averageDailyNotional(gapped, 3, '2026-09-25')).toBeUndefined();
    const edge = [bar('2026-09-14', 10, 100), ...window.slice(1)];
    expect(averageDailyNotional(edge, 3, '2026-09-25')).toBe(2_000 / 3);
  });
});

describe('volumeCapShares', () => {
  it('floors the declared share of notional at the entry price and never goes negative or infinite', () => {
    expect(volumeCapShares(10_000, 0.01, 30)).toBe(3);
    expect(volumeCapShares(10_000, 0.01, 0)).toBe(0);
    expect(volumeCapShares(-10_000, 0.01, 30)).toBe(0);
  });
});
