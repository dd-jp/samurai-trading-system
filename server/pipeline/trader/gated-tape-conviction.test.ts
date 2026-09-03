/**
 * What the volatility gate's `LOW_CONVICTION_CAP` ACTUALLY does to a trade
 * (#870), asserted end to end over the real `assessAxes`, the real
 * `computeConvictionScore` and the real `decide`.
 *
 * ## The claim this file replaces
 *
 * #745 shipped the cap with a docstring stating that 0.40 "sits below the 0.55
 * conviction floor ... a non-trending or coiled tape should not be able to
 * carry an entry on technicals alone". **That was an unchecked arithmetic
 * claim and it is false.** The cap binds on the ANALYST's confidence;
 * `computeConvictionScore` then combines that confidence with the mediator's
 * stance and the evidence average, and on the all-absent desk with an agreeing
 * mediator a capped 0.40 lifts back to `0.6(0.5) + 0.4((1 + 0.4)/2) = 0.58`,
 * over the floor. #756's measurement (`measure-conviction-ceiling.ts`) found
 * this and pinned the 0.58; it deliberately did not resolve it.
 *
 * ## Why the resolution is to correct the claim rather than the mechanism
 *
 * Recorded here because the reasoning is the deliverable, and because the two
 * alternatives fail on arithmetic this file can state:
 *
 * - **Capping the CONVICTION instead** would over-fire. The intent is about a
 *   gated tape entering *on technicals alone*; a hydrated-aligned desk is not
 *   technicals alone, and a conviction-level cap would bar it too.
 * - **Re-deriving the cap VALUE is a product decision, not a defect fix.** On
 *   the all-absent desk conviction is exactly `0.5 + 0.2c` in the capped
 *   confidence `c`, so the intent needs the CAP under 0.25 — which works: a
 *   0.24 cap yields 0.548 and `decide` refuses the entry. The cost is that it
 *   binds on every non-zero point of the four-axis lattice ({0.25, 1/3, 0.5,
 *   2/3, 0.75, 1}) and collapses every non-zero read to one constant,
 *   discarding directional strength; 0.40 already does that to 4 of the 6. It
 *   would also sit a hundredth under a `conviction_floor` that #756 item 1
 *   still has open and blocked on soak data. That trade is David's to make.
 *
 * So the cap is a **damper, not a veto**, and these tests pin the damping: the
 * conviction it yields, the mediator stances it survives, and — the half no
 * test anywhere covered — the position size it produces at the composition
 * root. That size is **at most** ~6.7% of ADR-0018 D5's deployment envelope:
 * the cap only binds from raw confidence 0.40 up, so gated deployment spans
 * 0 (at `raw = 0.25`, where conviction is exactly the floor and `decide` skips
 * `below_min_notional`) through ~6.7%.
 *
 * ## Two conditions these numbers hold under
 *
 * Carried from `measure-conviction-ceiling.ts`, which measured them:
 * `routeDecision` skips at `neutral_direction_while_flat` BEFORE the floor is
 * consulted — 265 of 268 recorded skips in #625's data — so clearing the floor
 * is necessary, not sufficient, and `debateAt` below hardcodes
 * `direction: 'bullish'` and so runs past that gate rather than exercising it.
 * And `applyAnalystWeights` rescales the gated conviction by a factor that is
 * exactly 1 only while every `analyst_weights` row still sits at 1.0 (no closed
 * trades), which a feedback loop that has started moving weights would change.
 *
 * The assertion is on the resulting DEPLOYMENT (`size x entry`), never on a
 * config value, per ADR-0018's sizing amendment: both of its recorded silent
 * error modes produce a `risk_fraction` matching a number printed in the ADR.
 */
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
/**
 * ADR-0015's 2026-08-18 amendment: the book is GBP 1,000, all equity.
 * `LIVE_BOOK_GBP` (`../../apps/orchestrator/paper-profile.ts`) is the source of
 * truth; it is restated rather than imported so a Trader test does not depend
 * on the orchestrator app. Re-base it there and here together.
 */
const LIVE_BOOK = 1_000;

const SUBCLASS_OF: Readonly<Record<string, InstrumentSubclass>> = {
  [INDEX_ETP]: 'index_etp_3x',
  [SINGLE_STOCK_ETP]: 'single_stock_etp_3x',
};

/**
 * A gated tape read through the REAL `assessAxes`: every voting axis unanimous
 * (raw confidence 1.0 — RSI 60 rather than 75, since `rsiVote` deliberately
 * abstains on an overbought extreme), with ADX below `ADX_TREND_FLOOR` so the
 * volatility gate fires. This is the strongest possible gated read — the worst
 * case for the #745 claim, which is the case the claim has to survive.
 */
function gatedAssessment(): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 60, atrPct: 1 },
    { adx: 10, donchian: 0.9, macd: undefined, participation: 0.9, squeeze: undefined },
  );
}

/**
 * The same tape with the ADX above `ADX_TREND_FLOOR` and nothing else changed:
 * the discriminator every cap assertion here is stated against, so that a cap
 * that stopped binding collapses the difference rather than moving both sides.
 */
function ungatedAssessment(): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 60, atrPct: 1 },
    { adx: 30, donchian: 0.9, macd: undefined, participation: 0.9, squeeze: undefined },
  );
}

/**
 * How many `key_points` the technical analyst renders beyond one line per axis
 * reading: the gate line, the axis-vote summary, the session-VWAP line, the 1h
 * context line and the MI-context line. Only the FLOOR matters —
 * `KEY_POINTS_SATURATION` is 3 and every shape here clears it — so an
 * approximate count cannot flatter the result.
 */
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

/** The #436 empty-store branch: an analyst that never looked. */
function absent(analyst_id: string): AnalystView {
  return view(analyst_id, 'neutral', 0.05, [
    `${NO_DATA_MARKER}: the market-intelligence store returned nothing for this window.`,
    `${analyst_id} secondary line`,
  ]);
}

/** The desk every debate in the recorded soak ran on: technical only, MI mute. */
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

/** Both MI analysts hydrated and reading the technical direction at 0.95. */
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
  // `roundStances` empty is what the production adapter supplies: it echoes
  // each view's own direction, and `finalPositionFor` falls back to
  // `view.direction`, so the two inputs are the same score.
  return computeConvictionScore(views, [], mediator);
}

describe('#870 — the gated tape is DAMPED, not barred, and the damping is shape-conditional', () => {
  it('damps the identical axis votes that an ungated tape carries in full', () => {
    // Asserted as a COMPARISON, not as `confidence === LOW_CONVICTION_CAP`:
    // that identity is the code's output against the code's own constant, it
    // survives any change to the cap's value, and `technical-axes.test.ts`
    // (:253, :269) already pins it. The only difference between these two
    // reads is the ADX, so if the cap stops binding they become equal.
    const gated = gatedAssessment();
    const ungated = ungatedAssessment();

    expect(gated.capReasons.length).toBeGreaterThan(0);
    expect(ungated.capReasons).toEqual([]);
    expect(gated.direction).toBe(ungated.direction);
    expect(gated.confidence).toBeLessThan(ungated.confidence);
    expect(gated.confidence).toBeLessThan(FLOOR);
  });

  it('but the CONVICTION it feeds clears the floor once the mediator agrees', () => {
    // The defect #870 reports, re-derived from the analyst rather than from the
    // literal 0.4: `0.6(0.5) + 0.4((1 + 0.4)/2) = 0.58`.
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
    // The correction that the obvious rewording of #745's docstring would get
    // wrong. "Nothing clears from the capped state without an agreeing
    // mediator" is true on the absent desk and FALSE here: two agreeing MI
    // analysts at 0.95 carry the evidence average on their own, so an opposing
    // mediator still lands at 0.6533.
    const desk = alignedDesk(gatedAssessment());

    expect(convictionOf(desk, 'bullish')).toBeCloseTo(0.9533, 4);
    expect(convictionOf(desk, 'neutral')).toBeCloseTo(0.8033, 4);
    expect(convictionOf(desk, 'bearish')).toBeCloseTo(0.6533, 4);
    for (const mediator of ['bullish', 'neutral', 'bearish'] as const) {
      expect(convictionOf(desk, mediator)).toBeGreaterThan(FLOOR);
    }
  });
});

/** Flat closes, so ATR is exactly `trueRange` and any ATR leak into sizing shows. */
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

/**
 * Returns the target setup as its own neighbor at `r_multiple: 0`, so the
 * cosine stage multiplies by exactly 1.0. The default empty store would take
 * the 0.75x no-precedent haircut, and a deployment assertion run through it
 * would have to divide the haircut back out — i.e. restate the formula under
 * test.
 */
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

/**
 * Two weaker gated reads on the same gate, so the SPAN is executed rather than
 * asserted in prose: the cap binds only from raw 0.40 up, and below it the axes
 * carry the conviction down on their own. Both are real `assessAxes` outputs —
 * ADX still under `ADX_TREND_FLOOR`, so the gate fires on both.
 */
function gatedAssessmentAt(raw: 0.3333 | 0.25): AxisAssessment {
  return assessAxes(
    { lastClose: 101, sma: 100, rsi: 45, atrPct: 1 },
    {
      adx: 10,
      donchian: 0.9,
      macd: undefined,
      // The participation axis: absent leaves 3 voting axes (net 1 → 1/3),
      // present-and-neutral makes it 4 (net 1 → 0.25).
      participation: raw === 0.25 ? 0.5 : undefined,
      squeeze: undefined,
    },
  );
}

describe('#870 — what the damping is worth at the composition root', () => {
  it('caps a gated tape at ~6.7% of ADR-0018 D5s deployment envelope — a ceiling, not a value', async () => {
    // The half of the corrected claim that had no test anywhere. `decide.ts`
    // reads `conviction_floor` TWICE — once as the gate and once through
    // `convictionMultiplier`, which is a SIZING input — so the cap's real
    // effect is on notional, not on the trade/skip boundary.
    const conviction = convictionOf(absentDesk(gatedAssessment()), 'bullish');
    const expectedMultiplier = (conviction - FLOOR) / (1 - FLOOR);

    const deployed = await deploymentAt(conviction);

    expect(expectedMultiplier).toBeCloseTo(0.0667, 4);
    // `(1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION)` is #897's headroom reserve:
    // the first tranche is sized at 90% of the envelope so a scale-in remains
    // admissible. It scales the whole span this test measures; the ~6.7%
    // multiplier the test is actually about is untouched by it.
    expect(deployed).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION *
        (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION) *
        EQUITY *
        expectedMultiplier,
      6,
    );
    // Stated absolutely as well, because the line above is derived from the
    // same `conviction` the deployment is: if the cap stopped binding, both
    // sides would move together and only this number would notice. £2,333.33
    // until #897 reserved the headroom.
    expect(deployed).toBeCloseTo(2_100.0, 2);
  });

  it('and 6.7% really is a CEILING — a weaker gated read deploys less, and the weakest deploys nothing', async () => {
    // The span the ceiling implies, executed rather than asserted in prose:
    // the cap binds only from raw 0.40 up, so gated deployment runs 0 → 6.7%.
    const middling = gatedAssessmentAt(0.3333);
    const weakest = gatedAssessmentAt(0.25);

    expect(middling.capReasons.length).toBeGreaterThan(0);
    expect(weakest.capReasons.length).toBeGreaterThan(0);
    expect(middling.confidence).toBe(0.3333);
    expect(weakest.confidence).toBe(0.25);

    const middlingConviction = convictionOf(absentDesk(middling), 'bullish');
    expect(middlingConviction).toBeCloseTo(0.5667, 4);
    // £12.96 until #897 reserved 10% of the envelope as scale-in headroom.
    expect(await deploymentAt(middlingConviction, LIVE_BOOK)).toBeCloseTo(11.66, 2);

    // The bottom of the span, taken from the Trader's OWN skip reason rather
    // than derived from `decide.ts:426`'s `<`: this read lands exactly ON the
    // floor, which is the boundary #683 has open, so which of the two skips
    // fires is a fact to read off rather than to reason about.
    const weakestConviction = convictionOf(absentDesk(weakest), 'bullish');
    expect(weakestConviction).toBeCloseTo(FLOOR, 10);

    const outcome = await decideWithReason(traderInput(weakestConviction, LIVE_BOOK));
    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('below_min_notional');
  });

  it('sizes an ungated unanimous tape 5x larger from the same axis votes', async () => {
    // The discriminator against a test that would pass whether or not the cap
    // is wired: the ONLY difference between the two runs is the ADX read, and
    // it moves the deployed notional by a factor of 5.
    const gated = convictionOf(absentDesk(gatedAssessment()), 'bullish');
    const ungated = convictionOf(absentDesk(ungatedAssessment()), 'bullish');

    const ungatedDeployment = await deploymentAt(ungated);
    const gatedDeployment = await deploymentAt(gated);

    expect(ungated).toBeCloseTo(0.7, 10);
    expect(ungatedDeployment / gatedDeployment).toBeCloseTo(5, 10);
  });

  it('does not clear the minimum viable notional by accident — the floor does not enforce #745', async () => {
    // Reported as a NEGATIVE result rather than relied on, and run through
    // `decide` at the real book size rather than recomputed here: a test that
    // restated the sizing formula would survive `convictionMultiplier` being
    // deleted from `decide.ts` entirely.
    //
    // Both frozen ADR-0018 D5 brackets are checked, because the conclusion has
    // to hold on the whole live universe, not just the index row. Deployment is
    // `deployment_fraction x (1 - headroom_reserve_fraction) x equity x
    // multiplier` on both — the stop cancels out of `risk_fraction =
    // deployment_fraction x stop_pct x (1 - reserve)` — so the single-stock row
    // lands lower and still clears the minimum.
    //
    // #897 shrank both figures by the 10% headroom reserve (23.33 -> 21.00,
    // 16.67 -> 15.00). The NEGATIVE result this test reports is unchanged by
    // that: neither row is anywhere near the £10 floor, so the floor still does
    // not enforce #745.
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
