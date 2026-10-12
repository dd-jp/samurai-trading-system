import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { checkOf, openEpisode, type SplitCheck, SqliteSplitChecks } from './split-checks.js';

const AGREE = {
  kind: 'agree',
  reading: { ratio: 1.5, steps: [], rejected: [] },
  unconfirmed: [],
} as const;
const BLOCK = { kind: 'block', reason: 'sources_disagree', detail: 'x' } as const;

function check(
  tradingDate: string,
  verdict: 'agree' | 'block',
  overrides: Partial<SplitCheck> = {},
): SplitCheck {
  return {
    tradingDate,
    instrument: 'AAPL',
    exchange: 'US',
    window: { after: '2026-10-01', through: tradingDate },
    verdict,
    reason: verdict === 'block' ? 'sources_disagree' : 'agree',
    ratio: 1,
    ...overrides,
  };
}

function ledger(start = new Date('2026-10-05T07:00:00.000Z')) {
  const clock = new SimulatedClock(start);
  return { clock, checks: new SqliteSplitChecks(migratedMemoryStore(), clock) };
}

describe('checkOf', () => {
  const base = {
    tradingDate: '2026-10-05',
    instrument: 'AAPL',
    exchange: 'US' as const,
    window: { after: '2026-10-01', through: '2026-10-02' },
  };

  it('keeps the agreed ratio and blocks at ratio 1', () => {
    expect(checkOf(base, AGREE)).toEqual({
      ...base,
      verdict: 'agree',
      reason: 'agree',
      ratio: 1.5,
    });
    expect(checkOf(base, BLOCK)).toEqual({
      ...base,
      verdict: 'block',
      reason: 'sources_disagree',
      ratio: 1,
    });
  });
});

describe('openEpisode', () => {
  const row = (trading_date: string, verdict: 'agree' | 'block', after_date = 'a') => ({
    trading_date,
    after_date,
    verdict,
    reason: verdict,
    recorded_at: `${trading_date}T07:00:00.000Z`,
  });

  it('runs from the first blocking day to the last, and ends on a day every check agrees', () => {
    expect(openEpisode([])).toBeUndefined();
    expect(openEpisode([row('d1', 'agree')])).toBeUndefined();
    expect(
      openEpisode([row('d1', 'block', 'a1'), row('d2', 'agree'), row('d2', 'block', 'a2')]),
    ).toEqual({ start: row('d1', 'block', 'a1'), last: row('d2', 'block', 'a2') });
    expect(openEpisode([row('d1', 'block'), row('d2', 'agree')])).toBeUndefined();
    expect(
      openEpisode([row('d1', 'block', 'a1'), row('d2', 'agree'), row('d3', 'block', 'a3')]),
    ).toEqual({
      start: row('d3', 'block', 'a3'),
      last: row('d3', 'block', 'a3'),
    });
  });
});

describe('SqliteSplitChecks', () => {
  it('blocks from the first blocking day until a day the sources agree', () => {
    const { checks } = ledger();
    expect(checks.block('AAPL', 'US', '2026-10-05')).toBeUndefined();
    checks.record(
      check('2026-10-05', 'block', { window: { after: '2026-10-01', through: '2026-10-02' } }),
    );
    checks.record(
      check('2026-10-06', 'block', {
        reason: 'eodhd_uncovered',
        window: { after: '2026-10-03', through: '2026-10-05' },
      }),
    );
    expect(checks.block('AAPL', 'US', '2026-10-04')).toBeUndefined();
    expect(checks.block('AAPL', 'US', '2026-10-06')).toEqual({
      after: '2026-10-03',
      reason: 'eodhd_uncovered',
      since: '2026-10-05',
    });
    expect(checks.block('AAPL', 'LSE', '2026-10-06')).toBeUndefined();
    expect(checks.block('MSFT', 'US', '2026-10-06')).toBeUndefined();
    checks.record(check('2026-10-07', 'agree'));
    expect(checks.block('AAPL', 'US', '2026-10-07')).toBeUndefined();
    expect(checks.block('AAPL', 'US', '2026-10-06')).toBeDefined();
  });

  it('a clear lifts the open episode only, and a later block blocks again', () => {
    const { clock, checks } = ledger(new Date('2026-10-05T06:59:59.999Z'));
    checks.clear('AAPL', 'US', 'stale');
    clock.advanceTo(new Date('2026-10-05T07:00:00.000Z'));
    checks.record(check('2026-10-05', 'block'));
    expect(checks.block('AAPL', 'US', '2026-10-05')).toBeDefined();
    checks.clear('AAPL', 'LSE', 'other exchange');
    checks.clear('MSFT', 'US', 'other line');
    expect(checks.block('AAPL', 'US', '2026-10-05')).toBeDefined();
    checks.clear('AAPL', 'US', 'David checked');
    expect(checks.block('AAPL', 'US', '2026-10-05')).toBeUndefined();
    clock.advanceTo(new Date('2026-10-06T07:00:00.000Z'));
    checks.record(check('2026-10-06', 'block'));
    expect(checks.block('AAPL', 'US', '2026-10-06')).toBeUndefined();
    checks.record(check('2026-10-07', 'agree'));
    clock.advanceTo(new Date('2026-10-08T07:00:00.000Z'));
    checks.record(check('2026-10-08', 'block'));
    expect(checks.block('AAPL', 'US', '2026-10-08')).toMatchObject({ since: '2026-10-08' });
  });

  it('reads a clear only up to the run start it is given, inclusive', () => {
    const { clock, checks } = ledger();
    checks.record(check('2026-10-05', 'block'));
    clock.advanceTo(new Date('2026-10-05T12:00:00.000Z'));
    checks.clear('AAPL', 'US', 'David checked');
    expect(checks.block('AAPL', 'US', '2026-10-05', '2026-10-05T11:59:59.999Z')).toMatchObject({
      since: '2026-10-05',
    });
    expect(checks.block('AAPL', 'US', '2026-10-05', '2026-10-05T12:00:00.000Z')).toBeUndefined();
    expect(checks.block('AAPL', 'US', '2026-10-05')).toBeUndefined();
  });

  it('finds a blocking check of the line from a date up to, not including, another', () => {
    const { checks } = ledger();
    checks.record(check('2026-10-06', 'block'));
    checks.record(check('2026-10-07', 'agree'));
    checks.record(check('2026-10-06', 'block', { instrument: 'MSFT' }));
    checks.record(check('2026-10-06', 'block', { exchange: 'LSE' }));
    expect(checks.blockedBetween('AAPL', 'US', '2026-10-06', '2026-10-07')).toBe(true);
    expect(checks.blockedBetween('AAPL', 'US', '2026-10-05', '2026-10-06')).toBe(false);
    expect(checks.blockedBetween('AAPL', 'US', '2026-10-07', '2026-10-09')).toBe(false);
    expect(checks.blockedBetween('MSFT', 'US', '2026-10-07', '2026-10-09')).toBe(false);
    expect(checks.blockedBetween('BP', 'LSE', '2026-10-01', '2026-10-09')).toBe(false);
  });

  it('carries every line whose episode was open yesterday, from its last window start', () => {
    const { checks } = ledger();
    checks.record(
      check('2026-10-05', 'block', { window: { after: '2026-09-30', through: '2026-10-02' } }),
    );
    checks.record(
      check('2026-10-06', 'block', { window: { after: '2026-10-01', through: '2026-10-05' } }),
    );
    checks.record(check('2026-10-05', 'block', { instrument: 'MSFT' }));
    checks.record(check('2026-10-06', 'agree', { instrument: 'MSFT' }));
    checks.record(check('2026-10-07', 'block', { instrument: 'BP', exchange: 'LSE' }));
    expect(checks.carried('2026-10-05')).toEqual([]);
    expect(checks.carried('2026-10-07')).toEqual([
      { instrument: 'AAPL', exchange: 'US', after: '2026-10-01' },
    ]);
    expect(checks.carried('2026-10-08')).toEqual([
      { instrument: 'AAPL', exchange: 'US', after: '2026-10-01' },
      { instrument: 'BP', exchange: 'LSE', after: '2026-10-01' },
    ]);
    checks.record(check('2026-10-08', 'agree'));
    expect(checks.carried('2026-10-08')).toContainEqual({
      instrument: 'AAPL',
      exchange: 'US',
      after: '2026-10-01',
    });
  });
});
