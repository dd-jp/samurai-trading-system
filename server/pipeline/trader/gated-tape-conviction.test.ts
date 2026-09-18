import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  type Bar,
  type BarWindow,
  collectMarks,
  type IndicatorSpec,
  type IndicatorValue,
  type Mark,
  type MarketDataService,
  type MarkRead,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type {
  Clock,
  InstrumentSubclass,
  SetupNeighbor,
  SetupStore,
  SetupVector,
} from '../../shared/index.js';
import { type AxisAssessment, assessAxes } from '../analysts/technical-analyst.js';
import { NO_DATA_MARKER } from '../analysts/types.js';
import { computeConvictionScore } from '../debate-engine/conviction-score.js';
import type { AnalystView, DebateResult, Direction } from '../debate-engine/index.js';
import { decide, decideWithReason } from './decide.js';
import {
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
} from './subclass-bracket.js';
import { DEFAULT_TRADER_CONFIG, type TraderConfig, type TraderInput } from './types.js';

const FLOOR = DEFAULT_TRADER_CONFIG.conviction_floor;

const INDEX_ETP = '3USL';
const SINGLE_STOCK_ETP = '3LTS';
const DECISION_BAR = new Date('2026-07-15T10:00:00Z');
const ENTRY_PRICE = 40;
const EQUITY = 100_000;
const LIVE_BOOK = 1_000;

const SUBCLASS_OF: Readonly<Record<string, InstrumentSubclass>> = {
  [INDEX_ETP]: 'index_etp_3x',
  [SINGLE_STOCK_ETP]: 'single_stock_etp_3x',
};

function gatedAssessment(): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 60, atrPct: 1 },
    { adx: 10, donchian: 0.9, macd: undefined, participation: 0.9, squeeze: undefined },
  );
}

function ungatedAssessment(): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 60, atrPct: 1 },
    { adx: 30, donchian: 0.9, macd: undefined, participation: 0.9, squeeze: undefined },
  );
}

const TECHNICAL_FIXED_KEY_POINTS = 5;

function view(
  analyst_id: string,
  direction: Direction,
  confidence: number,
  keyPoints: string[],
): AnalystView {
  return {
    trace_id: 'gated-tape',
    analyst_id,
    analyst_type: analyst_id,
    direction,
    confidence,
    key_points: keyPoints,
    timestamp: DECISION_BAR,
  };
}

function filler(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} key point ${index + 1}`);
}

function absent(analyst_id: string): AnalystView {
  return view(analyst_id, 'neutral', 0.05, [
    `${NO_DATA_MARKER}: the market-intelligence store returned nothing for this window.`,
    `${analyst_id} secondary line`,
  ]);
}

function absentDesk(assessment: AxisAssessment): AnalystView[] {
  return [
    view(
      'technical',
      assessment.direction,
      assessment.confidence,
      filler(assessment.readings.length + TECHNICAL_FIXED_KEY_POINTS, 'technical'),
    ),
    absent('sentiment'),
    absent('fundamental'),
  ];
}

function alignedDesk(assessment: AxisAssessment): AnalystView[] {
  const [technical] = absentDesk(assessment);
  if (technical === undefined) throw new Error('absentDesk must yield a technical view');
  return [
    technical,
    view('sentiment', assessment.direction, 0.95, filler(2, 'sent')),
    view('fundamental', assessment.direction, 0.95, filler(2, 'fund')),
  ];
}

function convictionOf(views: AnalystView[], mediator: Direction): number {
  return computeConvictionScore(views, [], mediator);
}

describe('#870 — the gated tape is DAMPED, not barred, and the damping is shape-conditional', () => {
  it('damps the identical axis votes that an ungated tape carries in full', () => {
    const gated = gatedAssessment();
    const ungated = ungatedAssessment();

    expect(gated.capReasons.length).toBeGreaterThan(0);
    expect(ungated.capReasons).toEqual([]);
    expect(gated.direction).toBe(ungated.direction);
    expect(gated.confidence).toBeLessThan(ungated.confidence);
    expect(gated.confidence).toBeLessThan(FLOOR);
  });

  it('but the CONVICTION it feeds clears the floor once the mediator agrees', () => {
    const conviction = convictionOf(absentDesk(gatedAssessment()), 'bullish');

    expect(conviction).toBeCloseTo(0.58, 10);
    expect(conviction).toBeGreaterThan(FLOOR);
  });

  it('and does NOT clear on that desk against a neutral or opposing mediator', () => {
    const desk = absentDesk(gatedAssessment());

    expect(convictionOf(desk, 'neutral')).toBeCloseTo(0.43, 10);
    expect(convictionOf(desk, 'bearish')).toBeCloseTo(0.28, 10);
    expect(convictionOf(desk, 'neutral')).toBeLessThan(FLOOR);
    expect(convictionOf(desk, 'bearish')).toBeLessThan(FLOOR);
  });

  it('clears on a hydrated-aligned desk at EVERY mediator stance, cap included', () => {
    const desk = alignedDesk(gatedAssessment());

    expect(convictionOf(desk, 'bullish')).toBeCloseTo(0.9533, 4);
    expect(convictionOf(desk, 'neutral')).toBeCloseTo(0.8033, 4);
    expect(convictionOf(desk, 'bearish')).toBeCloseTo(0.6533, 4);
    for (const mediator of ['bullish', 'neutral', 'bearish'] as const) {
      expect(convictionOf(desk, mediator)).toBeGreaterThan(FLOOR);
    }
  });
});

function bars(instrument: string, count: number, trueRange: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close_time = new Date(DECISION_BAR.getTime() - (count - 1 - i) * 60 * 60 * 1000);
    return {
      instrument,
      timeframe: '1h',
      open_time: new Date(close_time.getTime() - 60 * 60 * 1000),
      close_time,
      open: ENTRY_PRICE,
      high: ENTRY_PRICE + trueRange / 2,
      low: ENTRY_PRICE - trueRange / 2,
      close: ENTRY_PRICE,
      volume: 1,
      source: 'fixture',
    };
  });
}

class FixtureMarketData implements MarketDataService {
  async getBars(instrument: string, _window: BarWindow, _asOf: Date): Promise<Bar[]> {
    return bars(instrument, 15, 2);
  }

  async getMark(_instrument: string, _asOf: Date): Promise<Mark> {
    return {
      price: ENTRY_PRICE,
      observed_at: DECISION_BAR,
      source: 'fixture',
      asset_class: 'stocks',
    };
  }

  async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  async getIndicator(
    _instrument: string,
    _spec: IndicatorSpec,
    _asOf: Date,
  ): Promise<IndicatorValue> {
    throw new Error('FixtureMarketData.getIndicator: not part of the entry path');
  }

  async getSpreadEstimate(): Promise<number | null> {
    throw new Error('FixtureMarketData.getSpreadEstimate: not part of the Trader path');
  }

  async getQuote(): Promise<null> {
    throw new Error('FixtureMarketData.getQuote: not part of the Trader path');
  }

  async getADV(): Promise<number> {
    throw new Error('FixtureMarketData.getADV: not part of the Trader path');
  }
}

class SelfPrecedentStore implements SetupStore {
  findNeighbors(vector: SetupVector, asOf: Date): SetupNeighbor[] {
    return [{ vector, r_multiple: 0, closed_at: new Date(asOf.getTime() - 60_000) }];
  }

  writeSetup(): void {}

  labelSetup(): void {}
}

const CLOCK: Clock = { now: () => DECISION_BAR };

function debateAt(confidence: number): DebateResult {
  return {
    synthesis: 'Gated tape, mediator agrees.',
    position: 'Enter long.',
    confidence,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 9_000,
    direction: 'bullish',
    debate_id: 'debate-870',
    bar_timestamp: DECISION_BAR,
    read: true,
  };
}

function traderInput(confidence: number, equity = EQUITY, instrument = INDEX_ETP): TraderInput {
  const config: TraderConfig = { ...DEFAULT_TRADER_CONFIG, subclass_of: SUBCLASS_OF };
  return {
    trace_id: 'trace-870',
    instrument,
    debate: debateAt(confidence),
    clock: CLOCK,
    marketData: new FixtureMarketData(),
    equity: async () => equity,
    config,
    positionState: async () => [],
    exitFillSizes: async () => new Map<string, number>(),
    unresolvedFlattens: async () => [],
    setupStore: new SelfPrecedentStore(),
    sessionCalendars: {
      crypto: new AlwaysOpenCalendar(),
      stocks: new UsEquityRegularHoursCalendar(),
    },
  };
}

async function deploymentAt(
  confidence: number,
  equity = EQUITY,
  instrument = INDEX_ETP,
): Promise<number> {
  const intent = await decide(traderInput(confidence, equity, instrument));
  if (intent === null) throw new Error(`expected an entry intent at conviction ${confidence}`);
  return intent.size * intent.entry;
}

function gatedAssessmentAt(raw: 0.3333 | 0.25): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 45, atrPct: 1 },
    {
      adx: 10,
      donchian: 0.9,
      macd: undefined,
      participation: raw === 0.25 ? 0.5 : undefined,
      squeeze: undefined,
    },
  );
}

describe('#870 — what the damping is worth at the composition root', () => {
  it('caps a gated tape at ~6.7% of ADR-0018 D5s deployment envelope — a ceiling, not a value', async () => {
    const conviction = convictionOf(absentDesk(gatedAssessment()), 'bullish');
    const expectedMultiplier = (conviction - FLOOR) / (1 - FLOOR);

    const deployed = await deploymentAt(conviction);

    expect(expectedMultiplier).toBeCloseTo(0.0667, 4);
    expect(deployed).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION *
        (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION) *
        EQUITY *
        expectedMultiplier,
      6,
    );
    expect(deployed).toBeCloseTo(2_100.0, 2);
  });

  it('and 6.7% really is a CEILING — a weaker gated read deploys less, and the weakest deploys nothing', async () => {
    const middling = gatedAssessmentAt(0.3333);
    const weakest = gatedAssessmentAt(0.25);

    expect(middling.capReasons.length).toBeGreaterThan(0);
    expect(weakest.capReasons.length).toBeGreaterThan(0);
    expect(middling.confidence).toBe(0.3333);
    expect(weakest.confidence).toBe(0.25);

    const middlingConviction = convictionOf(absentDesk(middling), 'bullish');
    expect(middlingConviction).toBeCloseTo(0.5667, 4);
    expect(await deploymentAt(middlingConviction, LIVE_BOOK)).toBeCloseTo(11.66, 2);

    const weakestConviction = convictionOf(absentDesk(weakest), 'bullish');
    expect(weakestConviction).toBeCloseTo(FLOOR, 10);

    const outcome = await decideWithReason(traderInput(weakestConviction, LIVE_BOOK));
    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('below_min_notional');
  });

  it('sizes an ungated unanimous tape 5x larger from the same axis votes', async () => {
    const gated = convictionOf(absentDesk(gatedAssessment()), 'bullish');
    const ungated = convictionOf(absentDesk(ungatedAssessment()), 'bullish');

    const ungatedDeployment = await deploymentAt(ungated);
    const gatedDeployment = await deploymentAt(gated);

    expect(ungated).toBeCloseTo(0.7, 10);
    expect(ungatedDeployment / gatedDeployment).toBeCloseTo(5, 10);
  });

  it('does not clear the minimum viable notional by accident — the floor does not enforce #745', async () => {
    const conviction = convictionOf(absentDesk(gatedAssessment()), 'bullish');
    const multiplier = (conviction - FLOOR) / (1 - FLOOR);
    const reserved = 1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION;

    const onIndex = await deploymentAt(conviction, LIVE_BOOK, INDEX_ETP);
    const onSingleStock = await deploymentAt(conviction, LIVE_BOOK, SINGLE_STOCK_ETP);

    expect(onIndex).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION * reserved * LIVE_BOOK * multiplier,
      6,
    );
    expect(onIndex).toBeCloseTo(21.0, 2);
    expect(onSingleStock).toBeCloseTo(
      D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * reserved * LIVE_BOOK * multiplier,
      6,
    );
    expect(onSingleStock).toBeCloseTo(15.0, 2);

    expect(onIndex).toBeGreaterThan(DEFAULT_TRADER_CONFIG.min_viable_notional);
    expect(onSingleStock).toBeGreaterThan(DEFAULT_TRADER_CONFIG.min_viable_notional);
  });
});
