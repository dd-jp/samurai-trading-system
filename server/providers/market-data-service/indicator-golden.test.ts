import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computeIndicator, InsufficientBarsError, minimumBarsFor } from './indicators.js';
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

interface GoldenCase {
  name: string;
  indicator: IndicatorKind;
  period?: number;
  params?: Record<string, number>;
  from: number;
  to: number;
  note: string;
  expected: number;
}

interface GoldenFixture {
  rounding_precision: number;
  bar_count: number;
  bars: {
    open_time: number;
    close_time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  cases: GoldenCase[];
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/indicator-golden.json', import.meta.url)), {
    encoding: 'utf8',
  }),
) as GoldenFixture;

for (const testCase of golden.cases) {
  if (!(INDICATOR_KINDS as readonly string[]).includes(testCase.indicator)) {
    throw new Error(
      `indicator-golden.json case "${testCase.name}" names an unknown kind ` +
        `"${testCase.indicator}". Known: ${INDICATOR_KINDS.join(', ')}. ` +
        'Regenerate with generate-indicator-golden.py rather than editing by hand.',
    );
  }
}

const BARS: Bar[] = golden.bars.map((raw) => ({
  instrument: 'GOLDEN',
  timeframe: '1h',
  open_time: new Date(raw.open_time),
  close_time: new Date(raw.close_time),
  open: raw.open,
  high: raw.high,
  low: raw.low,
  close: raw.close,
  volume: raw.volume,
  source: 'golden-fixture',
}));

const specFor = (kind: IndicatorKind, period: number, windowLength: number): IndicatorSpec => ({
  indicator: kind,
  params: { period },
  lookback: windowLength,
  timeframe: '1h',
});

const specForParams = (
  kind: IndicatorKind,
  params: Record<string, number>,
  windowLength: number,
): IndicatorSpec => ({
  indicator: kind,
  params,
  lookback: windowLength,
  timeframe: '1h',
});

const CANONICAL_PARAMS: Partial<Record<IndicatorKind, Record<string, number>>> = {
  macd_histogram: { fast: 12, slow: 26, signal: 9 },
  bb_kc_squeeze: { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 },
};

const windowFor = (testCase: GoldenCase): Bar[] => BARS.slice(testCase.from, testCase.to);

const specForCase = (testCase: GoldenCase, windowLength: number): IndicatorSpec =>
  testCase.params !== undefined
    ? specForParams(testCase.indicator, testCase.params, windowLength)
    : specFor(testCase.indicator, testCase.period as number, windowLength);

const valueFor = (testCase: GoldenCase): number =>
  computeIndicator(windowFor(testCase), specForCase(testCase, testCase.to - testCase.from));

const caseNamed = (name: string): GoldenCase => {
  const found = golden.cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`golden fixture has no case named ${name}`);
  return found;
};

describe('computeIndicator against an independent reference', () => {
  for (const testCase of golden.cases) {
    it(`${testCase.name} — ${testCase.note}`, () => {
      expect(valueFor(testCase)).toBeCloseTo(testCase.expected, golden.rounding_precision);
    });
  }

  it('covers every shipped kind, so a new kind cannot arrive unbaselined', () => {
    const covered = new Set(golden.cases.map((entry) => entry.indicator));
    expect([...covered].sort()).toEqual([...INDICATOR_KINDS].sort());
  });
});

const boundaryCaseName = (kind: IndicatorKind): string =>
  kind === 'macd_histogram'
    ? 'boundary_macd_histogram_12_26_9'
    : kind === 'bb_kc_squeeze'
      ? 'boundary_bb_kc_squeeze_20_20'
      : `boundary_${kind}_14`;

describe('the boundary the goldens sit on', () => {
  for (const kind of INDICATOR_KINDS) {
    const testCase = caseNamed(boundaryCaseName(kind));
    const params = CANONICAL_PARAMS[kind] ?? { period: 14 };

    it(`${kind}: the golden window is exactly minimumBarsFor, not one bar more`, () => {
      const length = testCase.to - testCase.from;
      expect(length).toBe(minimumBarsFor(specForParams(kind, params, length)));
    });

    it(`${kind}: one bar fewer throws rather than answering`, () => {
      const length = testCase.to - testCase.from - 1;
      const short = BARS.slice(testCase.from + 1, testCase.to);

      expect(() => computeIndicator(short, specForParams(kind, params, length))).toThrow(
        InsufficientBarsError,
      );
    });
  }
});

describe('what the warm-up buys, and where it buys nothing', () => {
  const spread = (kind: string, lengths: readonly number[]) =>
    lengths.map((length) => caseNamed(`warmup_sensitivity_${kind}_14_${length}`).expected);

  it('sma reads the trailing period only, so the window length is irrelevant to it', () => {
    const [atBoundary, atSixty, atFull] = spread('sma', [14, 60, 400]);

    expect(atBoundary).toBe(atSixty);
    expect(atSixty).toBe(atFull);
  });

  for (const [kind, lengths] of [
    ['ema', [14, 60, 400]],
    ['rsi', [15, 60, 400]],
    ['atr', [15, 60, 400]],
  ] as const) {
    it(`${kind} depends on the whole window, which is why lookback is in the cache key`, () => {
      const [atBoundary, atSixty, atFull] = spread(kind, lengths);

      expect(atBoundary).not.toBe(atSixty);
      expect(atSixty).not.toBe(atFull);
    });
  }

  it('prices the warm-up sensitivity of RSI(14) rather than leaving it unstated', () => {
    const short = caseNamed('warmup_sensitivity_rsi_14_15').expected;
    const long = caseNamed('warmup_sensitivity_rsi_14_400').expected;

    expect(Math.abs(short - long)).toBeGreaterThan(9);
    expect(Math.abs(short - 50) / 50).toBeGreaterThan(4 * (Math.abs(long - 50) / 50));
  });
});

describe('conventions that read as bugs and are not', () => {
  it('answers RSI 100 on a strictly rising window', () => {
    expect(valueFor(caseNamed('rising_run_rsi_14'))).toBe(100);
  });

  it('answers RSI 0 on a strictly falling window, which is a different branch', () => {
    expect(valueFor(caseNamed('falling_run_rsi_14'))).toBe(0);
  });

  it('answers ATR exactly 0 on a zero-range window', () => {
    expect(valueFor(caseNamed('flat_dojis_atr_14'))).toBe(0);
  });

  it('computes the true range from the prior close, not just the bar it is on', () => {
    const gapping = caseNamed('gapping_atr_14');
    const perBarRange =
      BARS.slice(gapping.from, gapping.to).reduce((sum, bar) => sum + (bar.high - bar.low), 0) /
      (gapping.to - gapping.from);

    expect(valueFor(gapping)).toBeGreaterThan(perBarRange);
  });
});

describe('the flat-tape fix (#725)', () => {
  it('answers the neutral midpoint 50 on a dead-flat window, not 100', () => {
    expect(valueFor(caseNamed('flat_dojis_rsi_14'))).toBe(50);
  });

  it('answers 50 regardless of which period asked — the 0/0 shape does not depend on width', () => {
    expect(valueFor(caseNamed('flat_dojis_rsi_5'))).toBe(50);
  });
});

describe('the fixture itself', () => {
  it('holds the declared 400 bars in ascending close_time', () => {
    expect(BARS).toHaveLength(golden.bar_count);
    expect(golden.bar_count).toBe(400);

    for (let i = 1; i < BARS.length; i++) {
      const previous = BARS[i - 1] as Bar;
      const current = BARS[i] as Bar;
      expect(current.close_time.getTime()).toBeGreaterThan(previous.close_time.getTime());
    }
  });

  it('varies volume, which the fixture it replaces did not', () => {
    const distinct = new Set(BARS.map((bar) => bar.volume));

    expect(distinct.size).toBeGreaterThan(100);
    expect(BARS.some((bar) => bar.volume === 0)).toBe(true);
  });

  it('keeps the degenerate segments a random walk would never produce', () => {
    expect(BARS.some((bar) => bar.high === bar.low)).toBe(true);
    expect(BARS.filter((bar) => bar.high === bar.low).length).toBeGreaterThanOrEqual(20);

    const gapping = BARS.slice(260).some(
      (bar, index) => index > 0 && Math.abs(bar.open - (BARS[259 + index] as Bar).close) > 0.5,
    );
    expect(gapping).toBe(true);
  });

  it('keeps every bar internally consistent — high is the high, low is the low', () => {
    for (const bar of BARS) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
    }
  });
});
