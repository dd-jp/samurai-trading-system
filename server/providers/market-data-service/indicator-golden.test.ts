/**
 * B1 (#703) — characterisation goldens for `computeIndicator`.
 *
 * ## What was missing
 *
 * Every numeric assertion in `indicator.test.ts` is `Number.isFinite`, a
 * relative comparison, or — at `technical-analyst.test.ts:172-192` — a value
 * recomputed by calling `computeIndicator` itself. That last one is the
 * problem: the suite compares the implementation against itself, so a
 * mis-seeded Wilder RSI or an off-by-one ATR is green everywhere. The
 * technical analyst is `mandatory` and is the entire market read the debate
 * ever sees, and `atrIndicatorSpec` prices every stop the Trader places, so
 * "the arithmetic is what it claims to be" is load-bearing rather than tidy.
 *
 * ## Where the expected values come from
 *
 * `__fixtures__/generate-indicator-golden.py` — an independent stdlib-only
 * reference written from Wilder's published definitions. The plan named
 * `pandas-ta`; it is not installed and every checked-in research script in
 * this repo is stdlib-only, so the reference is hand-written instead. The
 * independence that substitution costs is bought back STRUCTURALLY: the
 * reference computes a full series by explicit per-bar recurrence and takes
 * the last element, where `indicators.ts` seeds over `slice(0, period)` and
 * folds `slice(period)` to a scalar. The two shapes are not transcriptions of
 * one another.
 *
 * **A disagreement here is a finding about the live signal, not a reason to
 * edit either side.** Nothing in this file may be "fixed" by regenerating the
 * fixture against `indicators.ts`; that would restore the circularity the file
 * exists to break.
 *
 * ## What it pins beyond the four values
 *
 * - The seeding convention: simple mean of the first `period` observations,
 *   then Wilder smoothing. Most JS TA libraries EWM from the first value.
 * - The boundary at exactly `minimumBarsFor`. `atr` divides its seed by
 *   `seedRanges.length` while `rsi` divides by `period` — an asymmetry that is
 *   harmless ONLY because `computeIndicator` throws below `period + 1`, so
 *   `seedRanges.length === period` always. Remove the guard and the two kinds
 *   diverge; these cases are what would catch it.
 * - That `lookback` is a real input to the recursive kinds and is not one to
 *   `sma` — the fact that makes `lookback` part of the cache key.
 * - Two conventions that read as bugs and are not: a strictly rising window
 *   returns RSI **100** (a dead-flat window instead returns the neutral
 *   midpoint **50**, #725 — see "the flat-tape fix" below), and `atr` over a
 *   flat window returns exactly **0**.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computeIndicator, InsufficientBarsError, minimumBarsFor } from './indicators.js';
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

interface GoldenCase {
  name: string;
  /**
   * Narrowed at the boundary by the `INDICATOR_KINDS` membership loop below
   * rather than declared and trusted.
   * The fixture is JSON produced by a Python script, so this field is the one
   * place a kind can arrive that the registry has never heard of — and the
   * failure to catch it would be a golden case that silently stops running.
   */
  indicator: IndicatorKind;
  /** Scalar-period cases (the original four kinds). Mutually exclusive with `params`. */
  period?: number;
  /**
   * Named-parameter cases (#744's additions, and #744's own single-period
   * new kinds too) — see `generate-indicator-golden.py`'s `case_params`.
   * Additive on the fixture schema: existing cases keep `period`, new ones
   * carry `params` instead, so a diff on the fixture shows only what #744
   * added.
   */
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

/**
 * The `as GoldenFixture` above is a claim about a file, and `indicator` is the
 * one field where a wrong claim is silent: an unknown kind would make
 * `definitionFor` throw with a message about the registry, from inside a case
 * whose name says it is testing something else. Checked once, here, so the
 * error names the fixture.
 */
for (const testCase of golden.cases) {
  if (!(INDICATOR_KINDS as readonly string[]).includes(testCase.indicator)) {
    throw new Error(
      `indicator-golden.json case "${testCase.name}" names an unknown kind ` +
        `"${testCase.indicator}". Known: ${INDICATOR_KINDS.join(', ')}. ` +
        'Regenerate with generate-indicator-golden.py rather than editing by hand.',
    );
  }
}

/**
 * `instrument`/`timeframe`/`source` are audit fields no indicator reads, so
 * the fixture does not carry 400 copies of them.
 */
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

/**
 * `lookback` is the window length, matching how every real caller builds a
 * spec: `params.period` selects the indicator's own window inside the pinned
 * warm-up.
 */
const specFor = (kind: IndicatorKind, period: number, windowLength: number): IndicatorSpec => ({
  indicator: kind,
  params: { period },
  lookback: windowLength,
  timeframe: '1h',
});

/** The `params`-shaped analogue of `specFor`, for #744's named-parameter cases. */
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

/**
 * Canonical params per kind (#744) — must match `generate-indicator-golden
 * .py`'s own canonical sets exactly, since these drive the `boundary_*` and
 * `full_window_*` case name lookups below.
 */
const CANONICAL_PARAMS: Partial<Record<IndicatorKind, Record<string, number>>> = {
  macd_histogram: { fast: 12, slow: 26, signal: 9 },
  bb_kc_squeeze: { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 },
};

const windowFor = (testCase: GoldenCase): Bar[] => BARS.slice(testCase.from, testCase.to);

/**
 * Builds the spec a golden case implies, dispatching on which of
 * `period`/`params` the case carries — the same additive schema
 * `generate-indicator-golden.py`'s `main()` dispatches on.
 */
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
  // Tolerance is half a unit in `ROUNDING_PRECISION`'s last place rather than
  // exact equality. The reference accumulates in a different order by
  // construction, so a last-bit difference is expected; a difference above the
  // precision the module claims to round to is the finding.
  for (const testCase of golden.cases) {
    it(`${testCase.name} — ${testCase.note}`, () => {
      expect(valueFor(testCase)).toBeCloseTo(testCase.expected, golden.rounding_precision);
    });
  }

  it('covers every shipped kind, so a new kind cannot arrive unbaselined', () => {
    // The plan's ordering rule made executable: assert the existing four
    // before adding any new kind. If a future step adds a kind and this list
    // is not extended with it, this fails. #744 grew this from four kinds to
    // nine (`atr_pct`, `macd_histogram`, `adx`, `donchian_pos`,
    // `bb_kc_squeeze`).
    const covered = new Set(golden.cases.map((entry) => entry.indicator));
    // Compared against the REGISTRY, not a literal (#703 B2). As a literal this
    // guard had the defect it exists to prevent: adding a kind to `INDICATORS`
    // left it passing, because it only ever asserted the four names written
    // here. Now a kind without a golden case fails this line by name.
    expect([...covered].sort()).toEqual([...INDICATOR_KINDS].sort());
  });
});

/**
 * `boundary_<kind>_14` for the seven single-period kinds; the two
 * multi-parameter kinds carry their canonical parameter set in the name
 * instead (matching `generate-indicator-golden.py`'s `case_params` calls),
 * since "14" cannot name a `fast`/`slow`/`signal` or
 * `bb_period`/`kc_period` combination.
 */
const boundaryCaseName = (kind: IndicatorKind): string =>
  kind === 'macd_histogram'
    ? 'boundary_macd_histogram_12_26_9'
    : kind === 'bb_kc_squeeze'
      ? 'boundary_bb_kc_squeeze_20_20'
      : `boundary_${kind}_14`;

describe('the boundary the goldens sit on', () => {
  // The comfortable window is where every seeding convention agrees. The
  // boundary is where they diverge, and it is the assertion a self-referential
  // test can never make.
  // Driven off the registry rather than a hand-written list (#703 B2), so a
  // new kind fails HERE — at `caseNamed`, with "no golden case named
  // boundary_<kind>_14" — instead of shipping with no boundary baseline. A
  // literal list would have quietly kept passing for the four it names.
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
      // `buildIndicatorCacheKey` includes `lookback` precisely because the
      // same indicator at the same `asOf` seeded from a different history
      // length is a DIFFERENT value. If these ever collapse to one number the
      // key is carrying a field that no longer distinguishes anything, and
      // more importantly the seeding has stopped being recursive.
      const [atBoundary, atSixty, atFull] = spread(kind, lengths);

      expect(atBoundary).not.toBe(atSixty);
      expect(atSixty).not.toBe(atFull);
    });
  }

  it('prices the warm-up sensitivity of RSI(14) rather than leaving it unstated', () => {
    // Not decoration. `technical-analyst.ts` computes `confidence` as
    // `|rsi - 50| / 50`, so on this fixture's final bar a 15-bar warm-up
    // yields ~0.24 confidence and a 400-bar warm-up ~0.05 — a five-fold swing
    // in how loudly the technical analyst speaks into the debate, from the
    // lookback alone, with the same period on the same bar. #722 is the
    // decision this swing forced: `RSI_SPEC` left the 15-bar floor for the
    // converged 57. The two cases stay at 15 and 400 because what they price
    // is the SENSITIVITY, not the live spec — anyone changing
    // `INDICATOR_TIMEFRAME` or a spec's `lookback` is changing this, and it
    // should be a number they had to look at.
    const short = caseNamed('warmup_sensitivity_rsi_14_15').expected;
    const long = caseNamed('warmup_sensitivity_rsi_14_400').expected;

    expect(Math.abs(short - long)).toBeGreaterThan(9);
    expect(Math.abs(short - 50) / 50).toBeGreaterThan(4 * (Math.abs(long - 50) / 50));
  });
});

describe('conventions that read as bugs and are not', () => {
  it('answers RSI 100 on a strictly rising window', () => {
    // `avgGain > 0 && avgLoss === 0` — the standard Wilder reading for a
    // window with only up-moves.
    expect(valueFor(caseNamed('rising_run_rsi_14'))).toBe(100);
  });

  it('answers RSI 0 on a strictly falling window, which is a different branch', () => {
    // `avgGain === 0` is NOT special-cased: `rs` is 0 and the formula returns
    // 0 on its own. Asserting both ends means a future guard added to one
    // branch cannot silently change the other.
    expect(valueFor(caseNamed('falling_run_rsi_14'))).toBe(0);
  });

  it('answers ATR exactly 0 on a zero-range window', () => {
    // Every ATR-derived stop distance is `atr_k * ATR`, so a zero here is a
    // zero-width stop rather than a wide one. `atrFor` returns the value and
    // `buildBracket` consumes it; nothing between them treats 0 as absent.
    expect(valueFor(caseNamed('flat_dojis_atr_14'))).toBe(0);
  });

  it('computes the true range from the prior close, not just the bar it is on', () => {
    // The gapping segment opens away from the previous close, so the max is
    // `|high - prevClose|` or `|low - prevClose|`. A window of the same length
    // from the non-gapping walk has a comparable per-bar range but a smaller
    // true range; if `atr` ever dropped the two prev-close legs, this is the
    // case that separates the two.
    const gapping = caseNamed('gapping_atr_14');
    const perBarRange =
      BARS.slice(gapping.from, gapping.to).reduce((sum, bar) => sum + (bar.high - bar.low), 0) /
      (gapping.to - gapping.from);

    expect(valueFor(gapping)).toBeGreaterThan(perBarRange);
  });
});

describe('the flat-tape fix (#725)', () => {
  // `avgLoss === 0` used to return 100 without checking whether `avgGain`
  // was also 0. A dead-flat window — every close identical, every change
  // zero — hit that same branch and answered 100, the same value a
  // strictly rising window gets. On a halted or auction-flat instrument
  // (the live LSE leveraged-ETP universe, ADR-0016) that meant the
  // technical analyst reported `confidence: 0.95` — near-maximum strength
  // — on a tape that had not moved at all.
  // `docs/reviews/indicator-characterisation-2026-08-16.md` F3 pinned this
  // and deliberately did not fix it; these cases pin the fix instead.
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
    // `indicator.test.ts:53` pins `volume: 1` on every bar. No kind reads
    // volume today, but RVOL (step B8) is a ratio to a same-clock-time
    // baseline and would be untestable against a constant — and a zero bar is
    // a real halt-or-auction bar and the value that ratio must not divide by.
    const distinct = new Set(BARS.map((bar) => bar.volume));

    expect(distinct.size).toBeGreaterThan(100);
    expect(BARS.some((bar) => bar.volume === 0)).toBe(true);
  });

  it('keeps the degenerate segments a random walk would never produce', () => {
    // If a regeneration loses these, the conventions above stop being tested
    // while every other case still passes.
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
