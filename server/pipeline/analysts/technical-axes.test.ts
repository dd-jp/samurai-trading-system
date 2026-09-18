import {
  AlwaysOpenCalendar,
  type Bar,
  FixtureDataSource,
  type IndicatorSpec,
  type IndicatorValue,
  InsufficientBarsError,
  type MarketDataService,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  ADX_SPEC,
  AXIS_WEIGHTS,
  assessAxes,
  DONCHIAN_SPEC,
  LOW_CONVICTION_CAP,
  MACD_SPEC,
  momentumVote,
  PARTICIPATION_LOOKBACK,
  SQUEEZE_SPEC,
  technicalAnalyst,
  VOTING_AXES,
} from './technical-analyst.js';
import {
  type AnalystInput,
  type AnalystTelemetry,
  type IndicatorUnavailableEvent,
  NOOP_ANALYST_TELEMETRY,
  type Signal,
} from './types.js';

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const SIGNAL: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}
  now(): Date {
    return this.time;
  }
}

function uptrend(count: number): Bar[] {
  const start = new Date('2026-07-14T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const closeTime = new Date(start + i * BAR_INTERVAL_MS);
    const close = 100 + i;
    return {
      instrument: INSTRUMENT,
      timeframe: TIMEFRAME,
      open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
      close_time: closeTime,
      open: close - 0.9,
      high: close + 0.2,
      low: close - 1,
      close,
      volume: 10 + i,
      source: 'fixture',
    } satisfies Bar;
  });
}

function recordingTelemetry(): AnalystTelemetry & { events: IndicatorUnavailableEvent[] } {
  const events: IndicatorUnavailableEvent[] = [];
  return {
    events,
    indicatorUnavailable(event) {
      events.push(event);
    },
  };
}

function buildInput(
  bars: Bar[],
  telemetry?: AnalystTelemetry,
  marketDataOverride?: (inner: MarketDataService) => MarketDataService,
): AnalystInput {
  const asOf = bars.at(-1)?.close_time as Date;
  const clock = new ManualClock(asOf);
  const inner = new MarketDataServiceImpl(
    new FixtureDataSource(
      bars,
      { price: 999, observed_at: asOf, source: 'fixture-live' },
      SIGNAL.asset_class,
    ),
    clock,
    'backtest',
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );
  return {
    trace_id: 'trace-745',
    signal: SIGNAL,
    clock,
    bar: asOf,
    market_intelligence: new MarketIntelligenceStore(clock),
    market_data: marketDataOverride === undefined ? inner : marketDataOverride(inner),
    calendar: new AlwaysOpenCalendar(),
    telemetry: telemetry ?? NOOP_ANALYST_TELEMETRY,
  };
}

const BULL_CORE = { lastClose: 110, sma: 100, rsi: 60, atrPct: 1 };

describe('one vote per axis (#745)', () => {
  it('gives two correlated momentum oscillators ONE vote, not two', () => {
    const withBoth = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(withBoth.readings.filter((reading) => reading.axis === 'momentum')).toHaveLength(1);
    expect(withBoth.net).toBe(4);
    expect(withBoth.availableAxes).toBe(4);
    expect(withBoth.confidence).toBe(1);
  });

  it('so adding the second oscillator cannot move net when the first already voted', () => {
    const rsiOnly = assessAxes(BULL_CORE, {
      macd: undefined,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });
    const both = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(both.net).toBe(rsiOnly.net);
  });

  it('neutralises DISAGREEING oscillators to a zero vote that stays in the denominator', () => {
    const split = assessAxes(BULL_CORE, {
      macd: -0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(momentumVote(60, -0.5)).toBe(0);
    expect(split.availableAxes).toBe(4);
    expect(split.net).toBe(3);
    expect(split.confidence).toBe(0.75);
  });

  it('never lets the volatility gate vote — availableAxes tops out at the four voting axes', () => {
    const assessment = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(VOTING_AXES).not.toContain('volatility');
    expect(assessment.readings.some((reading) => reading.axis === 'volatility')).toBe(false);
    expect(assessment.availableAxes).toBe(VOTING_AXES.length);
  });
});

describe('confidence = |net| / availableAxes (#745)', () => {
  it('SHRINKS the denominator for an unavailable axis rather than counting a zero vote', () => {
    const zeroVote = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.5,
      participation: 0.9,
    });
    const absent = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: undefined,
      participation: 0.9,
    });

    expect(zeroVote.net).toBe(3);
    expect(zeroVote.availableAxes).toBe(4);
    expect(zeroVote.confidence).toBe(0.75);

    expect(absent.net).toBe(3);
    expect(absent.availableAxes).toBe(3);
    expect(absent.confidence).toBe(1);
  });

  it('so a cold instrument reading only its core axes argues at full strength on what it has', () => {
    const coreOnly = assessAxes(BULL_CORE, {
      macd: undefined,
      adx: undefined,
      squeeze: undefined,
      donchian: undefined,
      participation: undefined,
    });

    expect(coreOnly.availableAxes).toBe(2);
    expect(coreOnly.net).toBe(2);
    expect(coreOnly.confidence).toBe(1);
    expect(coreOnly.direction).toBe('bullish');
  });

  it('caps confidence at 0.40 when ADX is below the trend floor', () => {
    const capped = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 12,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(capped.confidence).toBe(LOW_CONVICTION_CAP);
    expect(capped.capReasons.join(' ')).toContain('ADX');
    expect(capped.direction).toBe('bullish');
  });

  it('caps confidence at 0.40 when the squeeze is on', () => {
    const capped = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 0.8,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(capped.confidence).toBe(LOW_CONVICTION_CAP);
    expect(capped.capReasons.join(' ')).toContain('squeeze');
  });

  it('does not cap when the tape is trending and uncoiled', () => {
    const uncapped = assessAxes(BULL_CORE, {
      macd: 0.5,
      adx: 30,
      squeeze: 2,
      donchian: 0.9,
      participation: 0.9,
    });

    expect(uncapped.capReasons).toEqual([]);
    expect(uncapped.confidence).toBe(1);
  });

  it('caps rather than raises — a capped confidence is never above the uncapped one', () => {
    const weakAndCapped = assessAxes(
      { ...BULL_CORE, rsi: 50 },
      { macd: 0, adx: 12, squeeze: 2, donchian: 0.5, participation: 0.5 },
    );

    expect(weakAndCapped.net).toBe(1);
    expect(weakAndCapped.confidence).toBe(0.25);
  });
});

describe('axis weights are equal and unfitted (#745, ADR-0018 D4)', () => {
  it('starts every axis at the same weight', () => {
    const weights = Object.values(AXIS_WEIGHTS);

    expect(new Set(weights).size).toBe(1);
    expect(weights[0]).toBe(1);
  });

  it('so the weighted denominator reduces exactly to the axis COUNT', () => {
    const shapes = [
      {
        core: BULL_CORE,
        enrichment: { macd: 0.5, adx: 30, squeeze: 2, donchian: 0.9, participation: 0.5 },
      },
      {
        core: { ...BULL_CORE, rsi: 50 },
        enrichment: { macd: 0, adx: 30, squeeze: 2, donchian: undefined, participation: 0.9 },
      },
    ];

    for (const { core, enrichment } of shapes) {
      const assessment = assessAxes(core, enrichment);
      const votingReadings = assessment.readings.filter((reading) =>
        VOTING_AXES.includes(reading.axis),
      );

      expect(assessment.availableAxes).toBe(votingReadings.length);
      expect(assessment.confidence).toBe(
        Number((Math.abs(assessment.net) / votingReadings.length).toFixed(4)),
      );
    }
  });
});

describe('core vs enrichment — the availability trade-off (#745)', () => {
  it('produces a usable view on a cold start that satisfies only the core warm-ups', async () => {
    const telemetry = recordingTelemetry();
    const view = await technicalAnalyst.run(buildInput(uptrend(19), telemetry));

    expect(view.direction).toBe('bullish');
    expect(view.confidence).toBeGreaterThan(0);
    expect(view.key_points.some((line) => line.includes('over 2 available axes'))).toBe(true);
  });

  it('names what each unavailable kind needed and what it had, per axis', async () => {
    const telemetry = recordingTelemetry();
    const view = await technicalAnalyst.run(buildInput(uptrend(19), telemetry));

    expect(view.key_points.filter((line) => line.startsWith('Unavailable:')).sort()).toEqual([
      'Unavailable: adx (volatility axis) needed 28 bars, had 19',
      'Unavailable: bb_kc_squeeze (volatility axis) needed 21 bars, had 19',
      'Unavailable: donchian_pos (structure axis) needed 20 bars, had 19',
      'Unavailable: macd_histogram (momentum axis) needed 34 bars, had 19',
      'Unavailable: volume_participation (participation axis) needed 20 bars, had 19',
    ]);
  });

  it('but only participation and structure actually leave the denominator', async () => {
    const view = await technicalAnalyst.run(buildInput(uptrend(19)));

    expect(view.key_points.some((line) => line.startsWith('Momentum (5m):'))).toBe(true);
    expect(view.key_points.some((line) => line.includes('over 2 available axes'))).toBe(true);
  });

  it('emits technical_indicator_unavailable{kind} behind every one of them', async () => {
    const telemetry = recordingTelemetry();
    await technicalAnalyst.run(buildInput(uptrend(19), telemetry));

    expect(telemetry.events.map((event) => event.kind).sort()).toEqual([
      'adx',
      'bb_kc_squeeze',
      'donchian_pos',
      'macd_histogram',
      'volume_participation',
    ]);
    for (const event of telemetry.events) {
      expect(event.received).toBe(19);
      expect(event.required).toBeGreaterThan(19);
      expect(event.instrument).toBe(INSTRUMENT);
      expect(event.trace_id).toBe('trace-745');
    }
  });

  it('keeps momentum voting on RSI alone when only its MACD half is short of bars', async () => {
    const telemetry = recordingTelemetry();
    const view = await technicalAnalyst.run(buildInput(uptrend(30), telemetry));

    expect(telemetry.events.map((event) => event.kind)).toEqual(['macd_histogram']);
    expect(view.key_points.some((line) => line.includes('over 4 available axes'))).toBe(true);
    const momentum = view.key_points.find((line) => line.startsWith('Momentum (5m):'));
    expect(momentum).not.toContain('MACD');
  });

  it('still FAILS LOUD when a CORE kind is short of bars', async () => {
    await expect(technicalAnalyst.run(buildInput(uptrend(14)))).rejects.toThrow(
      InsufficientBarsError,
    );
  });

  it('lets the ascending-order assertion propagate FATALLY rather than absorbing it', async () => {
    const misordered = new Error(
      'computeIndicator: bars must be ascending by close_time — 2026-07-14T00:00:00.000Z ' +
        'follows 2026-07-14T00:05:00.000Z at index 1.',
    );
    const input = buildInput(uptrend(60), undefined, (inner) => ({
      getBars: inner.getBars.bind(inner),
      getMark: inner.getMark.bind(inner),
      getMarks: inner.getMarks.bind(inner),
      getADV: inner.getADV.bind(inner),
      getSpreadEstimate: inner.getSpreadEstimate.bind(inner),
      getQuote: inner.getQuote.bind(inner),
      async getIndicator(
        instrument: string,
        spec: IndicatorSpec,
        asOf: Date,
      ): Promise<IndicatorValue> {
        if (spec.indicator === ADX_SPEC.indicator) throw misordered;
        return inner.getIndicator(instrument, spec, asOf);
      },
    }));

    await expect(technicalAnalyst.run(input)).rejects.toThrow(misordered);
  });

  it('absorbs an InsufficientBarsError the pre-check could not see, and only that', async () => {
    const telemetry = recordingTelemetry();
    const input = buildInput(uptrend(60), telemetry, (inner) => ({
      getBars: inner.getBars.bind(inner),
      getMark: inner.getMark.bind(inner),
      getMarks: inner.getMarks.bind(inner),
      getADV: inner.getADV.bind(inner),
      getSpreadEstimate: inner.getSpreadEstimate.bind(inner),
      getQuote: inner.getQuote.bind(inner),
      async getIndicator(
        instrument: string,
        spec: IndicatorSpec,
        asOf: Date,
      ): Promise<IndicatorValue> {
        if (spec.indicator === ADX_SPEC.indicator) {
          throw new InsufficientBarsError({
            indicator: 'adx',
            period: 14,
            required: 28,
            received: 27,
          });
        }
        return inner.getIndicator(instrument, spec, asOf);
      },
    }));

    const view = await technicalAnalyst.run(input);

    expect(telemetry.events.map((event) => event.kind)).toEqual(['adx']);
    expect(view.key_points).toContain('Unavailable: adx (volatility axis) needed 28 bars, had 27');
  });

  it('pre-checks against the window it already fetched, so the ordinary cold case costs no throw', async () => {
    const marker = new Error('enrichment getIndicator must not be called below its arity');
    const input = buildInput(uptrend(19), recordingTelemetry(), (inner) => ({
      getBars: inner.getBars.bind(inner),
      getMark: inner.getMark.bind(inner),
      getMarks: inner.getMarks.bind(inner),
      getADV: inner.getADV.bind(inner),
      getSpreadEstimate: inner.getSpreadEstimate.bind(inner),
      getQuote: inner.getQuote.bind(inner),
      async getIndicator(
        instrument: string,
        spec: IndicatorSpec,
        asOf: Date,
      ): Promise<IndicatorValue> {
        const enrichment = [MACD_SPEC, ADX_SPEC, SQUEEZE_SPEC, DONCHIAN_SPEC];
        if (enrichment.some((candidate) => candidate.indicator === spec.indicator)) throw marker;
        return inner.getIndicator(instrument, spec, asOf);
      },
    }));

    await expect(technicalAnalyst.run(input)).resolves.toBeDefined();
  });

  it('reads participation over exactly PARTICIPATION_LOOKBACK bars, from the window already held', async () => {
    const view = await technicalAnalyst.run(buildInput(uptrend(60)));

    const participation = view.key_points.find((line) => line.startsWith('Participation (5m):'));
    expect(participation).toContain(`last ${PARTICIPATION_LOOKBACK} bars`);
  });
});

describe('the analyst holds no LLM seam of its own (#745)', () => {
  it('takes no LLM client on AnalystInput', () => {
    const input = buildInput(uptrend(60));

    for (const key of Object.keys(input)) {
      expect(key).not.toMatch(/llm|model|prompt|anthropic|openai|nous/i);
    }
  });
});
