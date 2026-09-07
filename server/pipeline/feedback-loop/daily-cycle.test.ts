import type { Clock, ClosedTrade, DebateLog } from '../../shared/index.js';
import type { AnalystContribution } from '../debate-engine/index.js';
import { InMemoryDebateLogStore } from '../debate-engine/index.js';
import { runDailyCycle } from './daily-cycle.js';
import type { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
import {
  openAdjustmentLog,
  openClosedTradeStore,
  openTuningStore,
} from './sqlite-store-harness.js';
import type { SqliteTuningStore } from './sqlite-tuning-store.js';
import type {
  DailyCycleInput,
  FeedbackConfig,
  LoosenAppliedNotice,
  LoosenNotificationChannel,
  TunableDial,
} from './types.js';

const NOW = new Date('2026-07-19T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeClock(at: Date = NOW): Clock {
  return { now: () => at };
}

class RecordingLoosenNotices implements LoosenNotificationChannel {
  readonly notices: LoosenAppliedNotice[] = [];

  notifyLoosenApplied(notice: LoosenAppliedNotice): void {
    this.notices.push(notice);
  }
}

function makeDial(overrides: Partial<TunableDial> = {}): TunableDial {
  return { max_step: 0.05, floor: 0.1, ceiling: 0.9, tighten_is: 'decrease', ...overrides };
}

function makeConfig(overrides: Partial<FeedbackConfig> = {}): FeedbackConfig {
  return {
    attribution_window_ms: DAY_MS,
    weights: makeDial(),
    strategy_params: {},
    risk_thresholds: {},
    kill_thresholds: {
      max_pbo: 0.05,
      min_oos_sharpe: 0.5,
      min_deflated_sharpe: 0.95,
      max_live_backtest_divergence: 0.5,
    },
    ...overrides,
  };
}

function makeContribution(overrides: Partial<AnalystContribution> = {}): AnalystContribution {
  return {
    analyst_id: 'bull',
    analyst_type: 'technical',
    stance_during_debate: ['bullish'],
    final_position: 'bullish',
    rationale: 'trend intact',
    influence_score: 0.9,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-18T10:00:00Z'),
    closed_at: new Date('2026-07-18T20:00:00Z'),
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

function makeLog(debate_id: string, contributions: AnalystContribution[]): DebateLog {
  return {
    debate_id,
    instrument: 'AAPL',
    bar_timestamp: new Date('2026-07-18T09:00:00Z'),
    contributions,
    direction: 'bullish',
    rounds: 2,
    created_at: new Date('2026-07-18T09:00:00Z'),
  };
}

interface Harness {
  input: DailyCycleInput;
  tuning: SqliteTuningStore;
  adjustments: SqliteAdjustmentLog;
  notices: RecordingLoosenNotices;
}

function makeHarness(overrides: Partial<DailyCycleInput> = {}): Harness {
  const debate_log = new InMemoryDebateLogStore();
  debate_log.writeLog(makeLog('debate-1', [makeContribution()]));

  const input: DailyCycleInput = {
    clock: makeClock(),
    trades: openClosedTradeStore([makeTrade()]),
    debate_log,
    tuning: openTuningStore({ weights: { bull: 0.5 } }),
    adjustments: openAdjustmentLog(),
    config: makeConfig(),
    loosen_notices: new RecordingLoosenNotices(),
    proposals: [],
    ...overrides,
  };

  // Read the handles back off `input` so an override is what the assertions
  // inspect — returning the defaults here would silently assert on stores the
  // cycle never touched.
  return {
    input,
    tuning: input.tuning as SqliteTuningStore,
    adjustments: input.adjustments as SqliteAdjustmentLog,
    notices: input.loosen_notices as RecordingLoosenNotices,
  };
}

describe('runDailyCycle — attribution into weights', () => {
  it('raises the weight of a winning trade’s driver and writes it to the store', () => {
    const { input, tuning } = makeHarness();

    const result = runDailyCycle(input);

    expect(result.weight_updates.bull.from).toBe(0.5);
    expect(result.weight_updates.bull.to).toBeGreaterThan(0.5);
    expect(tuning.getAnalystWeights().bull).toBe(result.weight_updates.bull.to);
    expect(result.applied).toBe(true);
  });

  it('lowers the weight of a losing trade’s driver', () => {
    const { input, tuning } = makeHarness({
      trades: openClosedTradeStore([makeTrade({ realized_pnl_net: -100 })]),
    });

    const result = runDailyCycle(input);

    expect(result.weight_updates.bull.to).toBeLessThan(0.5);
    expect(tuning.getAnalystWeights().bull).toBeLessThan(0.5);
  });

  it('logs every applied weight move with its from/to — the reversibility record', () => {
    const { input, adjustments } = makeHarness();

    runDailyCycle(input);

    expect(adjustments.getEntries()).toHaveLength(1);
    expect(adjustments.getEntries()[0]).toMatchObject({
      dial: 'analyst_weight',
      name: 'bull',
      from: 0.5,
      applied_at: NOW,
      reason: 'attribution',
    });
  });

  it('leaves an analyst with no closed trades in the window untouched', () => {
    const { input, tuning } = makeHarness({
      trades: openClosedTradeStore([]),
    });

    const result = runDailyCycle(input);

    expect(result.weight_updates).toEqual({});
    expect(tuning.getAnalystWeights().bull).toBe(0.5);
    expect(result.applied).toBe(false);
  });

  it('ignores trades that closed before the attribution window — point-in-time', () => {
    const stale = makeTrade({ closed_at: new Date(NOW.getTime() - 5 * DAY_MS) });
    const { input, tuning } = makeHarness({ trades: openClosedTradeStore([stale]) });

    runDailyCycle(input);

    expect(tuning.getAnalystWeights().bull).toBe(0.5);
  });

  it('ignores trades that close after T — no lookahead in weights', () => {
    const future = makeTrade({ closed_at: new Date(NOW.getTime() + DAY_MS) });
    const { input, tuning } = makeHarness({ trades: openClosedTradeStore([future]) });

    runDailyCycle(input);

    expect(tuning.getAnalystWeights().bull).toBe(0.5);
  });

  it('skips an analyst with a debate record but no weight row — nothing to step from', () => {
    const { input } = makeHarness({ tuning: openTuningStore({ weights: {} }) });

    expect(runDailyCycle(input).weight_updates).toEqual({});
  });

  it('is deterministic — the same clock-scoped inputs produce the same result', () => {
    expect(runDailyCycle(makeHarness().input)).toEqual(runDailyCycle(makeHarness().input));
  });
});

describe('runDailyCycle — bounded steps (acceptance criterion #4)', () => {
  it('cannot swing a weight past its bounded step on a single catastrophic trade', () => {
    const { input, tuning } = makeHarness({
      trades: openClosedTradeStore([
        // R = -50: a wipeout far worse than anything the band contemplates.
        makeTrade({ realized_pnl_net: -5000 }),
      ]),
      config: makeConfig({ weights: makeDial({ max_step: 0.05 }) }),
    });

    const result = runDailyCycle(input);

    expect(result.weight_updates.bull.to).toBeCloseTo(0.45, 10);
    expect(tuning.getAnalystWeights().bull).toBeCloseTo(0.45, 10);
  });

  it('cannot swing a weight past its bounded step on a single spectacular trade', () => {
    const { input } = makeHarness({
      trades: openClosedTradeStore([makeTrade({ realized_pnl_net: 5000 })]),
      config: makeConfig({ weights: makeDial({ max_step: 0.05 }) }),
    });

    expect(runDailyCycle(input).weight_updates.bull.to).toBeCloseTo(0.55, 10);
  });

  it('never drives a weight below its floor, however bad the record', () => {
    const { input, tuning } = makeHarness({
      tuning: openTuningStore({ weights: { bull: 0.12 } }),
      trades: openClosedTradeStore([makeTrade({ realized_pnl_net: -5000 })]),
      config: makeConfig({ weights: makeDial({ floor: 0.1, max_step: 0.05 }) }),
    });

    runDailyCycle(input);

    expect(tuning.getAnalystWeights().bull).toBe(0.1);
  });

  it('never lets a weight dominate past its ceiling', () => {
    const { input, tuning } = makeHarness({
      tuning: openTuningStore({ weights: { bull: 0.88 } }),
      trades: openClosedTradeStore([makeTrade({ realized_pnl_net: 5000 })]),
      config: makeConfig({ weights: makeDial({ ceiling: 0.9, max_step: 0.05 }) }),
    });

    runDailyCycle(input);

    expect(tuning.getAnalystWeights().bull).toBe(0.9);
  });

  it('takes many cycles of consistent evidence to traverse the band', () => {
    const harness = makeHarness({
      trades: openClosedTradeStore([makeTrade({ realized_pnl_net: 5000 })]),
      config: makeConfig({ weights: makeDial({ max_step: 0.05, ceiling: 0.9 }) }),
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      runDailyCycle(harness.input);
    }

    // 0.5 -> 0.55 -> 0.60 -> 0.65: bounded every cycle, no shortcut.
    expect(harness.tuning.getAnalystWeights().bull).toBeCloseTo(0.65, 10);
  });
});

describe('runDailyCycle — asymmetric risk-threshold guardrails', () => {
  const thresholdConfig = makeConfig({
    risk_thresholds: {
      max_position_size: makeDial({
        max_step: 100,
        floor: 100,
        ceiling: 5000,
        tighten_is: 'decrease',
      }),
    },
  });

  function thresholdHarness(target: number): Harness {
    return makeHarness({
      tuning: openTuningStore({ weights: {}, thresholds: { max_position_size: 1000 } }),
      trades: openClosedTradeStore([]),
      config: thresholdConfig,
      proposals: [{ kind: 'risk_threshold', name: 'max_position_size', target }],
    });
  }

  it('applies a tightening without asking anyone, and announces nothing', () => {
    const { input, tuning, notices } = thresholdHarness(500);

    const result = runDailyCycle(input);

    expect(result.param_updates.max_position_size).toEqual({
      from: 1000,
      to: 900,
      direction: 'tighten',
    });
    expect(tuning.getRiskThresholds().max_position_size).toBe(900);
    // A tightening narrows what the system may lose; it is not news.
    expect(notices.notices).toEqual([]);
  });

  /**
   * THE assertion of #736. Before it, this exact input wrote nothing in live
   * and paper and queued a request no transport could answer, so the dial
   * ratcheted one way for a whole soak. ADR-0013 Decision 2: "Every dial
   * change — tighten or loosen — is applied, logged and reversible."
   *
   * There is no `mode` parameter to sweep any more — the gate was the only
   * thing that read it — so this one path IS live, paper and backtest.
   */
  it('APPLIES a loosening, logs it, and announces it', () => {
    const { input, tuning, notices, adjustments } = thresholdHarness(2000);

    const result = runDailyCycle(input);

    // Bounded to one max_step, not the 2000 asked for.
    expect(result.param_updates.max_position_size).toEqual({
      from: 1000,
      to: 1100,
      direction: 'loosen',
    });
    expect(tuning.getRiskThresholds().max_position_size).toBe(1100);
    expect(result.applied).toBe(true);
    // Reversible: the `from` is what an operator rolls back to.
    expect(adjustments.getEntries()).toMatchObject([
      {
        dial: 'risk_threshold',
        name: 'max_position_size',
        from: 1000,
        to: 1100,
        direction: 'loosen',
        reason: 'proposal',
      },
    ]);
    // A dial that moves itself has to say so — past tense, after the write.
    expect(notices.notices).toEqual([
      { name: 'max_position_size', from: 1000, to: 1100, applied_at: NOW },
    ]);
  });

  it('honours tighten_is increase — a decrease is then the loosening', () => {
    const { input, tuning, notices } = makeHarness({
      tuning: openTuningStore({ weights: {}, thresholds: { min_viable_size: 100 } }),
      trades: openClosedTradeStore([]),
      config: makeConfig({
        risk_thresholds: {
          min_viable_size: makeDial({
            max_step: 10,
            floor: 10,
            ceiling: 500,
            tighten_is: 'increase',
          }),
        },
      }),
      proposals: [{ kind: 'risk_threshold', name: 'min_viable_size', target: 50 }],
    });

    const result = runDailyCycle(input);

    expect(result.param_updates.min_viable_size).toMatchObject({ direction: 'loosen' });
    expect(tuning.getRiskThresholds().min_viable_size).toBe(90);
    expect(notices.notices).toMatchObject([{ name: 'min_viable_size', from: 100, to: 90 }]);
  });

  it('does not announce a loosening the hard band flattens into a no-op', () => {
    // Already at the dial ceiling and asked for more: nothing moves, so there
    // is nothing to tell anyone. The `[floor, ceiling]` band is what ADR-0013
    // keeps — only the per-change human gate went.
    const { input, tuning, notices, adjustments } = thresholdHarness(9_000);
    tuning.setRiskThreshold('max_position_size', 5000);

    const result = runDailyCycle(input);

    expect(result.param_updates).toEqual({});
    expect(tuning.getRiskThresholds().max_position_size).toBe(5000);
    expect(adjustments.getEntries()).toEqual([]);
    expect(notices.notices).toEqual([]);
  });

  it('bounds a tightening by max_step just like a weight', () => {
    const { input, tuning } = thresholdHarness(0);

    runDailyCycle(input);

    expect(tuning.getRiskThresholds().max_position_size).toBe(900);
  });
});

/**
 * The other half of #736, and the half that stops the fix becoming a
 * regression. ADR-0013 Decision 2 removed the per-change human gate *within*
 * the hard bounds and kept the bounds: every change is "rejected in code if it
 * would cross a hard bound". #638 put that clamp on `setRiskThreshold`, so it
 * binds on the Feedback Loop's own write door — which is now the only thing
 * standing between an automatic loosening and an arbitrary risk limit.
 *
 * `max_drawdown_pct` is used deliberately: it is one of the names in
 * `GUARDED_THRESHOLD_BOUNDS` (max 0.45, re-sited 2026-08-31 by David's
 * approval of #925 — was 0.35). A test written against an unguarded name
 * like `max_position_size` would pass while proving nothing.
 */
describe('runDailyCycle — the #638 clamp still binds on an automatic loosening', () => {
  function drawdownHarness(ceiling: number, target: number): Harness {
    return makeHarness({
      tuning: openTuningStore({ weights: {}, thresholds: { max_drawdown_pct: 0.3 } }),
      trades: openClosedTradeStore([]),
      config: makeConfig({
        risk_thresholds: {
          // A dial whose own ceiling is deliberately mis-set ABOVE the in-code
          // clamp: the dial bounds are config and the clamp is not, which is
          // exactly the case the clamp exists for. max_step is 0.2 (not the
          // file's usual 0.1) so a single day's step from the 0.3 starting
          // value can still reach past the #925-widened 0.45 in-code ceiling.
          max_drawdown_pct: makeDial({
            max_step: 0.2,
            floor: 0.05,
            ceiling,
            tighten_is: 'decrease',
          }),
        },
      }),
      proposals: [{ kind: 'risk_threshold', name: 'max_drawdown_pct', target }],
    });
  }

  it('REFUSES a loosening past the in-code clamp, writing nothing and telling nobody', () => {
    const { input, tuning, adjustments, notices } = drawdownHarness(0.5, 0.5);

    // Refused, not coerced: a silently clamped value would read as accepted.
    expect(() => runDailyCycle(input)).toThrow(/max_drawdown_pct/);

    // The dial did not move, no reversibility record claims it did, and no
    // operator was told a limit widened that did not.
    expect(tuning.getRiskThresholds().max_drawdown_pct).toBe(0.3);
    expect(adjustments.getEntries()).toEqual([]);
    expect(notices.notices).toEqual([]);
  });

  it('allows a loosening that stays inside the clamp', () => {
    // 0.30 -> 0.34 is a real widening of the drawdown breaker, and it is under
    // the 0.45 line (#925), so nothing refuses it. This is the control for the
    // test above: it proves the refusal is the bound, not the direction.
    const { input, tuning, notices } = drawdownHarness(0.34, 0.34);

    runDailyCycle(input);

    expect(tuning.getRiskThresholds().max_drawdown_pct).toBeCloseTo(0.34, 10);
    expect(notices.notices).toMatchObject([{ name: 'max_drawdown_pct' }]);
  });
});

describe('runDailyCycle — strategy params', () => {
  const paramConfig = makeConfig({
    strategy_params: {
      conviction_multiplier: makeDial({
        max_step: 0.1,
        floor: 0.5,
        ceiling: 2,
        tighten_is: 'decrease',
      }),
    },
  });

  function paramHarness(target: number): Harness {
    return makeHarness({
      tuning: openTuningStore({ weights: {}, params: { conviction_multiplier: 1 } }),
      trades: openClosedTradeStore([]),
      config: paramConfig,
      proposals: [{ kind: 'strategy_param', name: 'conviction_multiplier', target }],
    });
  }

  it('tunes freely in BOTH directions — only risk thresholds are gated', () => {
    const { input, tuning, notices } = paramHarness(2);

    const result = runDailyCycle(input);

    expect(tuning.getStrategyParams().conviction_multiplier).toBeCloseTo(1.1, 10);
    // Only a risk threshold's loosening is announced — a strategy param
    // carries no safety semantics.
    expect(result.param_updates.conviction_multiplier).toMatchObject({ direction: 'loosen' });
    expect(notices.notices).toEqual([]);
  });

  it('stays inside its hard bounds', () => {
    const { input, tuning } = paramHarness(100);

    for (let cycle = 0; cycle < 50; cycle += 1) {
      runDailyCycle(input);
    }

    expect(tuning.getStrategyParams().conviction_multiplier).toBe(2);
  });

  it('logs the move against the strategy_param dial', () => {
    const { input, adjustments } = paramHarness(2);

    runDailyCycle(input);

    expect(adjustments.getEntries()[0]).toMatchObject({
      dial: 'strategy_param',
      name: 'conviction_multiplier',
      from: 1,
      reason: 'proposal',
    });
  });
});

describe('runDailyCycle — config integrity', () => {
  it('refuses to tune a dial with no declared bounds', () => {
    const { input } = makeHarness({
      trades: openClosedTradeStore([]),
      proposals: [{ kind: 'risk_threshold', name: 'undeclared', target: 1 }],
    });

    expect(() => runDailyCycle(input)).toThrow(/no risk_threshold dial declared/);
  });

  it('rejects a name declared as both a strategy param and a risk threshold', () => {
    const { input } = makeHarness({
      trades: openClosedTradeStore([]),
      config: makeConfig({
        strategy_params: { overlap: makeDial() },
        risk_thresholds: { overlap: makeDial() },
      }),
    });

    expect(() => runDailyCycle(input)).toThrow(/both a strategy_param and a risk_threshold/);
  });

  it('skips a proposal for a dial the store has no value for', () => {
    const { input } = makeHarness({
      trades: openClosedTradeStore([]),
      config: makeConfig({ strategy_params: { unset: makeDial() } }),
      proposals: [{ kind: 'strategy_param', name: 'unset', target: 0.5 }],
    });

    const result = runDailyCycle(input);

    expect(result.param_updates).toEqual({});
    expect(result.applied).toBe(false);
  });
});
