import { describe, expect, it } from 'vitest';
import type { MarketData, SleeveDecision, V2Bar } from '../../../../contracts/index.js';
import type { BarSeries } from '../../../shared/index.js';
import { type BarsSource, realisedVolatility } from '../data/index.js';
import {
  createVolTargetIndexBenchmarkSleeve,
  createVolTargetIndexSleeve,
  VOL_TARGET_INDEX_BENCHMARK_ID,
  VOL_TARGET_INDEX_CANDIDATE_ID,
  VOL_TARGET_INDEX_CEILINGS,
  VOL_TARGET_INDEX_FROM,
  VOL_TARGET_INDEX_TIDMS,
  VOL_TARGET_INDEX_TO,
  VOL_TARGET_INDEX_VOL_WINDOW,
  volTargetIndexSleeveId,
} from './vol-target-index.js';

const CONTEXT = { tradingDate: '2025-01-01', macroDay: false, dryRun: true };
const LOOKBACK_BARS = 40;

function weekdaysEndingBefore(tradingDate: string, count: number): readonly string[] {
  const dates: string[] = [];
  const cursor = new Date(`${tradingDate}T00:00:00.000Z`);
  while (dates.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

const SESSIONS = weekdaysEndingBefore(CONTEXT.tradingDate, LOOKBACK_BARS + 20);

function calendarSource(sessions: readonly string[] = SESSIONS): BarsSource {
  const reference: BarSeries = {
    symbol: 'ISF',
    bars: sessions.map((date) => ({
      date,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rawClose: 1,
    })),
  };
  return { load: (symbol) => (symbol === 'ISF' ? reference : undefined) };
}

const CALENDAR = calendarSource();

function rangedBar(date: string, close: number, halfRange = 1): V2Bar {
  return {
    date,
    open: close,
    high: close + halfRange,
    low: close - halfRange,
    close,
    volume: 1_000,
    rawClose: close,
  };
}

function datedBars(closes: readonly number[], halfRange = 1): V2Bar[] {
  const dates = SESSIONS.slice(-closes.length);
  return closes.map((close, index) => rangedBar(dates[index] as string, close, halfRange));
}

function marketOf(bars: readonly V2Bar[]): MarketData {
  return { lastBarBefore: () => undefined, barsBefore: () => bars, gbpUsdAtYearStart: () => 1 };
}

function flatCloses(length = LOOKBACK_BARS, close = 100): number[] {
  return Array.from({ length }, () => close);
}

// Alternating ±step closes give ten up and ten down log returns over the 20-day window, so the
// mean is exactly zero and the volatility has a closed form
function alternatingCloses(step: number, length = LOOKBACK_BARS): number[] {
  return Array.from({ length }, (_, index) => (index % 2 === 0 ? 100 : 100 + step));
}

async function decide(
  bars: readonly V2Bar[],
  ceiling = 0.2,
  calendar: BarsSource = CALENDAR,
): Promise<readonly SleeveDecision[]> {
  const sleeve = createVolTargetIndexSleeve(calendar, ceiling)(marketOf(bars));
  return (await sleeve.decide(CONTEXT, VOL_TARGET_INDEX_TIDMS)).decisions;
}

async function decideBenchmark(
  bars: readonly V2Bar[],
  calendar: BarsSource = CALENDAR,
): Promise<readonly SleeveDecision[]> {
  const sleeve = createVolTargetIndexBenchmarkSleeve(calendar)(marketOf(bars));
  return (await sleeve.decide(CONTEXT, VOL_TARGET_INDEX_TIDMS)).decisions;
}

function first(decisions: readonly SleeveDecision[]): SleeveDecision {
  return decisions[0] as SleeveDecision;
}

describe('the pre-declared candidate 3 design', () => {
  it('declares the nine equity-index lines, the window, the grid and the ids', () => {
    expect(VOL_TARGET_INDEX_TIDMS).toEqual([
      'ISF',
      'VMID',
      'IUSA',
      'IEUX',
      'IJPN',
      'IEEM',
      'CUKS',
      'CUS1',
      'CPJ1',
    ]);
    expect(VOL_TARGET_INDEX_FROM).toBe('2006-01-03');
    expect(VOL_TARGET_INDEX_TO).toBe('2025-09-24');
    expect(VOL_TARGET_INDEX_CEILINGS).toEqual([0.2, 0.25]);
    expect(VOL_TARGET_INDEX_VOL_WINDOW).toBe(20);
    expect(VOL_TARGET_INDEX_CANDIDATE_ID).toBe('vol-target-index');
    expect(VOL_TARGET_INDEX_BENCHMARK_ID).toBe('vol-target-index-benchmark');
    expect(VOL_TARGET_INDEX_CEILINGS.map(volTargetIndexSleeveId)).toEqual([
      'vol-target-index-v20',
      'vol-target-index-v25',
    ]);
  });

  it('gives both arms one spec: risk 0.25%, 5 x ATR stop, no target or time stop, 1% ADV cap', () => {
    const market = marketOf([]);
    const strategy = createVolTargetIndexSleeve(CALENDAR, 0.2)(market);
    const benchmark = createVolTargetIndexBenchmarkSleeve(CALENDAR)(market);
    expect(strategy.id).toBe('vol-target-index-v20');
    expect(benchmark.id).toBe(VOL_TARGET_INDEX_BENCHMARK_ID);
    expect(strategy.spec).toEqual({
      capitalShare: 0.7,
      minimumCapitalGbp: 0,
      capacityGbp: Number.POSITIVE_INFINITY,
      validation: 'backtest',
      macroGate: false,
      sizing: {
        riskFraction: 0.0025,
        stopAtrMultiple: 5,
        targetAtrMultiple: 1_000_000,
        timeStopTradingDays: 1_000_000,
        advShare: 0.01,
        advWindowBars: 20,
      },
      books: [{ variant: 'primary', instantiated: true }],
    });
    expect(benchmark.spec).toEqual(strategy.spec);
    expect(strategy.universe(CONTEXT)).toEqual({
      instruments: VOL_TARGET_INDEX_TIDMS,
      refusals: [],
    });
    expect(benchmark.universe(CONTEXT)).toEqual({
      instruments: VOL_TARGET_INDEX_TIDMS,
      refusals: [],
    });
  });
});

describe('createVolTargetIndexSleeve', () => {
  it('decides every declared line in order with no refusals', async () => {
    const sleeve = createVolTargetIndexSleeve(CALENDAR, 0.2)(marketOf(datedBars(flatCloses())));
    const output = await sleeve.decide(CONTEXT, VOL_TARGET_INDEX_TIDMS);
    expect(output.refusals).toEqual([]);
    const decisions = output.decisions;
    expect(decisions.map((row) => row.instrument)).toEqual(VOL_TARGET_INDEX_TIDMS);
    expect(new Set(decisions.map((row) => row.sleeve_id))).toEqual(
      new Set(['vol-target-index-v20']),
    );
  });

  it('enters at the last raw close with a 5 x ATR resting stop while vol is within the ceiling', async () => {
    const decision = first(await decide(datedBars(flatCloses())));
    expect(decision).toEqual({
      sleeve_id: 'vol-target-index-v20',
      instrument: 'ISF',
      venue: 'saxo',
      direction: 'bullish',
      confidence: 1,
      action: 'enter_long',
      reason: 'vol rule holds',
      price: 100,
      atr: 2,
      stop_price: 90,
      inputs_hash: `ISF-${CONTEXT.tradingDate}`,
      debate_id: undefined,
      payload: { realised_vol: 0 },
    });
  });

  it('exits when vol is above the ceiling', async () => {
    const bars = datedBars(alternatingCloses(5));
    const vol = realisedVolatility(bars, 20) as number;
    expect(vol).toBeGreaterThan(0.25);
    const decision = first(await decide(bars, 0.25));
    expect(decision).toMatchObject({
      action: 'exit',
      direction: 'neutral',
      confidence: 1,
      reason: 'realised vol above ceiling',
      stop_price: undefined,
      inputs_hash: `ISF-${CONTEXT.tradingDate}`,
      payload: { realised_vol: vol },
    });
  });

  it('holds at exactly the ceiling and exits just above it', async () => {
    const bars = datedBars(alternatingCloses(1));
    const vol = realisedVolatility(bars, 20) as number;
    expect(first(await decide(bars, vol)).action).toBe('enter_long');
    expect(first(await decide(bars, vol - 1e-12)).action).toBe('exit');
  });

  it('measures vol on the adjusted closes but prices and stops in raw terms', async () => {
    const bars = datedBars(flatCloses()).map((bar) => ({ ...bar, rawClose: 2 * bar.close }));
    expect(first(await decide(bars))).toMatchObject({
      action: 'enter_long',
      price: 200,
      atr: 4,
      stop_price: 180,
      payload: { realised_vol: 0 },
    });
  });

  it('skips a non-positive stop rather than entering', async () => {
    const decision = first(await decide(datedBars(flatCloses(LOOKBACK_BARS, 10), 9)));
    expect(decision).toMatchObject({
      action: 'skip',
      reason: 'non_positive_stop',
      direction: 'neutral',
      confidence: 0,
      stop_price: undefined,
      inputs_hash: '',
      price: 10,
    });
  });

  it('skips a stop of exactly zero', async () => {
    const decision = first(await decide(datedBars(flatCloses(LOOKBACK_BARS, 10), 1)));
    expect(decision).toMatchObject({ atr: 2, reason: 'non_positive_stop' });
  });

  it('skips as insufficient_history when a non-positive close leaves vol undefined', async () => {
    const bars = datedBars(flatCloses());
    bars[30] = { ...(bars[30] as V2Bar), open: 0, high: 0, low: 0, close: 0, rawClose: 0 };
    expect(first(await decide(bars))).toMatchObject({
      action: 'skip',
      reason: 'insufficient_history',
      payload: { realised_vol: undefined },
    });
    expect(first(await decide(bars)).atr).toBeGreaterThan(0);
  });

  it('still exits on high vol when the stop would be non-positive', async () => {
    const decision = first(await decide(datedBars(alternatingCloses(50), 60)));
    expect(decision.action).toBe('exit');
  });

  it('skips a line with no bars as bad_last_bar', async () => {
    expect(first(await decide([]))).toMatchObject({
      action: 'skip',
      reason: 'bad_last_bar',
      price: 0,
      atr: undefined,
      payload: { realised_vol: undefined },
    });
  });

  it('skips a shape-invalid last bar as bad_last_bar', async () => {
    const bars = datedBars(flatCloses());
    bars[bars.length - 1] = { ...(bars.at(-1) as V2Bar), open: 500 };
    expect(first(await decide(bars)).reason).toBe('bad_last_bar');
  });

  it('skips a window with too few bars or a stale calendar as window_coverage', async () => {
    expect(first(await decide(datedBars(flatCloses(LOOKBACK_BARS - 1)))).reason).toBe(
      'window_coverage',
    );
    const stale = calendarSource(SESSIONS.slice(0, -10));
    expect(first(await decide(datedBars(flatCloses()), 0.2, stale)).reason).toBe('window_coverage');
  });

  it('skips a gappy window as window_coverage', async () => {
    const dates = SESSIONS.slice(-(LOOKBACK_BARS + 3));
    const kept = dates.filter((_, index) => index < 10 || index >= 13);
    const bars = kept.map((date) => rangedBar(date, 100));
    expect(bars).toHaveLength(LOOKBACK_BARS);
    expect(first(await decide(bars)).reason).toBe('window_coverage');
  });

  it('skips as insufficient_history when shape filtering leaves fewer than 21 bars', async () => {
    const bars = datedBars(flatCloses()).map((bar, index) =>
      index > 0 && index <= 20 ? { ...bar, open: 500 } : bar,
    );
    expect(first(await decide(bars))).toMatchObject({
      action: 'skip',
      reason: 'insufficient_history',
      price: 100,
    });
  });
});

describe('createVolTargetIndexBenchmarkSleeve', () => {
  it('enters on high vol where the strategy exits', async () => {
    const bars = datedBars(alternatingCloses(5));
    expect(first(await decide(bars, 0.2)).action).toBe('exit');
    expect(first(await decideBenchmark(bars))).toMatchObject({
      sleeve_id: VOL_TARGET_INDEX_BENCHMARK_ID,
      action: 'enter_long',
      reason: 'vol rule holds',
    });
  });

  it('shares the strategy warm-up and coverage skips', async () => {
    expect(first(await decideBenchmark(datedBars(flatCloses(LOOKBACK_BARS - 1)))).reason).toBe(
      'window_coverage',
    );
    expect(first(await decideBenchmark(datedBars(flatCloses(LOOKBACK_BARS, 10), 9))).reason).toBe(
      'non_positive_stop',
    );
  });
});
