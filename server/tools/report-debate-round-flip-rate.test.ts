import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DebateRoundLogEntry } from '../shared/index.js';
import {
  assertDbPathExists,
  computeFlipRate,
  DEFAULT_WINDOW_DAYS,
  formatFlipRateReport,
  parseWindowDays,
} from './report-debate-round-flip-rate.js';

function row(overrides: Partial<DebateRoundLogEntry> = {}): DebateRoundLogEntry {
  return {
    debate_id: 'debate-1',
    round: 1,
    direction: 'bullish',
    confidence: 0.5,
    created_at: new Date('2026-07-14T09:00:08Z'),
    ...overrides,
  };
}

describe('computeFlipRate (#1517)', () => {
  it('reports zero-sample honestly when no round-log rows exist at all', () => {
    expect(computeFlipRate([])).toEqual({
      total_debates: 0,
      multi_round_debates: 0,
      flips: 0,
      flip_rate: null,
    });
  });

  it('excludes single-round debates from the flip-rate denominator — they cannot flip by construction', () => {
    const rows = [row({ debate_id: 'd1', round: 1, direction: 'bullish' })];
    expect(computeFlipRate(rows)).toEqual({
      total_debates: 1,
      multi_round_debates: 0,
      flips: 0,
      flip_rate: null,
    });
  });

  it('counts a flip when round 1 and the final round disagree', () => {
    const rows = [
      row({ debate_id: 'd1', round: 1, direction: 'bearish' }),
      row({ debate_id: 'd1', round: 2, direction: 'bullish' }),
    ];
    expect(computeFlipRate(rows)).toEqual({
      total_debates: 1,
      multi_round_debates: 1,
      flips: 1,
      flip_rate: 1,
    });
  });

  it('does not count a re-confirmation as a flip, even across three rounds', () => {
    const rows = [
      row({ debate_id: 'd1', round: 1, direction: 'bullish' }),
      row({ debate_id: 'd1', round: 2, direction: 'bullish' }),
      row({ debate_id: 'd1', round: 3, direction: 'bullish' }),
    ];
    expect(computeFlipRate(rows)).toEqual({
      total_debates: 1,
      multi_round_debates: 1,
      flips: 0,
      flip_rate: 0,
    });
  });

  it('compares round 1 against the FINAL round, ignoring any intermediate reversal', () => {
    // Flips bearish -> bullish -> bearish: round 1 and the final round agree,
    // so this is NOT counted as a flip even though the direction moved mid-debate
    const rows = [
      row({ debate_id: 'd1', round: 1, direction: 'bearish' }),
      row({ debate_id: 'd1', round: 2, direction: 'bullish' }),
      row({ debate_id: 'd1', round: 3, direction: 'bearish' }),
    ];
    expect(computeFlipRate(rows)).toEqual({
      total_debates: 1,
      multi_round_debates: 1,
      flips: 0,
      flip_rate: 0,
    });
  });

  it('is order-independent — rows may arrive out of round order', () => {
    const rows = [
      row({ debate_id: 'd1', round: 2, direction: 'bullish' }),
      row({ debate_id: 'd1', round: 1, direction: 'bearish' }),
    ];
    expect(computeFlipRate(rows).flips).toBe(1);
  });

  it('aggregates across multiple debates independently', () => {
    const rows = [
      row({ debate_id: 'd1', round: 1, direction: 'bearish' }),
      row({ debate_id: 'd1', round: 2, direction: 'bullish' }), // flip
      row({ debate_id: 'd2', round: 1, direction: 'bullish' }),
      row({ debate_id: 'd2', round: 2, direction: 'bullish' }), // no flip
      row({ debate_id: 'd3', round: 1, direction: 'neutral' }), // single round, excluded
    ];
    expect(computeFlipRate(rows)).toEqual({
      total_debates: 3,
      multi_round_debates: 2,
      flips: 1,
      flip_rate: 0.5,
    });
  });
});

describe('formatFlipRateReport', () => {
  it('states the flip rate as measured, not padded, on a genuine zero-flip sample', () => {
    const text = formatFlipRateReport(
      computeFlipRate([
        row({ debate_id: 'd1', round: 1, direction: 'bullish' }),
        row({ debate_id: 'd1', round: 2, direction: 'bullish' }),
      ]),
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(text).toContain('0 / 1');
    expect(text).toContain('0.00%');
  });

  it('names the zero-sample case explicitly rather than printing a misleading 0%', () => {
    const text = formatFlipRateReport(
      computeFlipRate([]),
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(text).toContain('no multi-round debates in this window');
    expect(text).not.toContain('0.00%');
  });
});

describe('parseWindowDays', () => {
  it('defaults when no window is given', () => {
    expect(parseWindowDays([])).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('reads an explicit window', () => {
    expect(parseWindowDays(['--days', '7'])).toBe(7);
  });

  it('refuses a non-positive window', () => {
    expect(() => parseWindowDays(['--days', '0'])).toThrow();
  });
});

describe('assertDbPathExists (#1558 review round 2, finding 5) — mirrors classify-debate-termination.ts', () => {
  it('throws for a path that does not exist', () => {
    const missingPath = join(
      mkdtempSync(join(tmpdir(), 'report-debate-round-flip-rate-')),
      'nope.sqlite',
    );

    expect(() => assertDbPathExists(missingPath)).toThrow(missingPath);
    expect(() => assertDbPathExists(missingPath)).toThrow('does not exist');
  });

  it('does not throw for a path that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-debate-round-flip-rate-'));
    const existingPath = join(dir, 'real.sqlite');
    writeFileSync(existingPath, '');

    expect(() => assertDbPathExists(existingPath)).not.toThrow();
  });
});
