import type { ArmedClosedTrade } from '../control-arm/index.js';
import {
  ARM_DIVERGENCE_RETURN_GAP_PCT,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  evaluateArmDivergence,
  MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
  runArmComparisonCycle,
} from './arm-comparison-cycle.js';
import { InMemoryArmComparisonSampleStore } from './fixture-stores.js';
import type {
  ArmComparisonSample,
  ArmComparisonSource,
  ArmDivergenceAlert,
  ArmDivergenceAlertChannel,
} from './types/arm-comparison.js';

const BASIS = 1_000;

function trade(overrides: {
  key: string;
  arm: 'live' | 'control';
  pnl: number;
  closed_at: Date;
}): ArmedClosedTrade {
  return {
    idempotency_key: overrides.key,
    debate_id: `debate-${overrides.key}`,
    instrument: '3LTS',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 95,
    filled_size: 1,
    realized_pnl_net: overrides.pnl,
    fees_total: 0,
    opened_at: new Date(overrides.closed_at.getTime() - 60_000),
    closed_at: overrides.closed_at,
    close_reason: 'target',
    arm: overrides.arm,
  };
}

class FakeSource implements ArmComparisonSource {
  readonly windows: { from: Date; to: Date }[] = [];

  constructor(private readonly trades: ArmedClosedTrade[]) {}

  getClosedTradesBetween(from: Date, to: Date): ArmedClosedTrade[] {
    this.windows.push({ from, to });
    return this.trades.filter((row) => row.closed_at > from && row.closed_at <= to);
  }
}

class RecordingAlerts implements ArmDivergenceAlertChannel {
  readonly posted: ArmDivergenceAlert[] = [];

  postArmDivergenceAlert(alert: ArmDivergenceAlert): void {
    this.posted.push(alert);
  }
}

/** `min_trades_per_arm` closes on each arm, so the trade-count guard is clear. */
function armTrades(arm: 'live' | 'control', pnls: readonly number[]): ArmedClosedTrade[] {
  return pnls.map((pnl, index) =>
    trade({
      key: `${arm}-${index}`,
      arm,
      pnl,
      closed_at: new Date(Date.UTC(2026, 8, 1, 10, index)),
    }),
  );
}

const NOW = new Date(Date.UTC(2026, 8, 1, 12));

describe('evaluateArmDivergence', () => {
  const enoughTrades = MIN_TRADES_PER_ARM_FOR_DIVERGENCE;

  function comparisonOf(input: {
    liveReturn: number;
    liveDrawdown: number;
    controlReturn: number;
    controlDrawdown: number;
    trades?: number;
  }) {
    const count = input.trades ?? enoughTrades;
    return {
      from: new Date(NOW.getTime() - DEFAULT_ARM_COMPARISON_WINDOW_MS),
      to: NOW,
      basis: BASIS,
      live: {
        arm: 'live' as const,
        trade_count: count,
        realized_pnl_net: input.liveReturn * BASIS,
        return_pct: input.liveReturn,
        max_drawdown_pct: input.liveDrawdown,
      },
      control: {
        arm: 'control' as const,
        trade_count: count,
        realized_pnl_net: input.controlReturn * BASIS,
        return_pct: input.controlReturn,
        max_drawdown_pct: input.controlDrawdown,
      },
    };
  }

  it('fires when the control beats the live arm by more than the gap AND is no worse on drawdown', () => {
    const verdict = evaluateArmDivergence(
      comparisonOf({
        liveReturn: 0.001,
        liveDrawdown: 0.04,
        controlReturn: 0.001 + ARM_DIVERGENCE_RETURN_GAP_PCT + 0.0001,
        controlDrawdown: 0.03,
      }),
      DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    );

    expect(verdict.diverged).toBe(true);
    expect(verdict.reason).toContain('control');
  });

  /**
   * D4: the control leading on return alone is NOT the finding. A control that
   * bought its return with a deeper drawdown did not beat a risk-targeted
   * stream, and firing on the return column alone would be exactly the
   * return-only comparison `docs/research/12-edge-hypothesis-critique.md` D4
   * rules out.
   */
  it('does not fire when the control leads on return but took a deeper drawdown', () => {
    const verdict = evaluateArmDivergence(
      comparisonOf({
        liveReturn: 0.001,
        liveDrawdown: 0.02,
        controlReturn: 0.05,
        controlDrawdown: 0.2,
      }),
      DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    );

    expect(verdict.diverged).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it('does not fire on a return gap under the threshold', () => {
    const verdict = evaluateArmDivergence(
      comparisonOf({
        liveReturn: 0.001,
        liveDrawdown: 0.04,
        controlReturn: 0.001 + ARM_DIVERGENCE_RETURN_GAP_PCT / 2,
        controlDrawdown: 0.01,
      }),
      DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    );

    expect(verdict.diverged).toBe(false);
  });

  /** The falsifying direction only — the live arm winning is not an escalation. */
  it('never fires when the LIVE arm is ahead, however far ahead it is', () => {
    const verdict = evaluateArmDivergence(
      comparisonOf({
        liveReturn: 0.5,
        liveDrawdown: 0.01,
        controlReturn: -0.2,
        controlDrawdown: 0.3,
      }),
      DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    );

    expect(verdict.diverged).toBe(false);
  });

  it('refuses to fire below the minimum closed-trade count on either arm', () => {
    const verdict = evaluateArmDivergence(
      comparisonOf({
        liveReturn: 0,
        liveDrawdown: 0.1,
        controlReturn: 0.2,
        controlDrawdown: 0,
        trades: MIN_TRADES_PER_ARM_FOR_DIVERGENCE - 1,
      }),
      DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    );

    expect(verdict.diverged).toBe(false);
    expect(verdict.reason).toBeNull();
  });
});

describe('runArmComparisonCycle', () => {
  function cycleInput(trades: ArmedClosedTrade[]) {
    const source = new FakeSource(trades);
    const samples = new InMemoryArmComparisonSampleStore();
    const alerts = new RecordingAlerts();
    return {
      source,
      samples,
      alerts,
      input: {
        clock: { now: () => NOW },
        trades: source,
        samples,
        alerts,
        basis: BASIS,
        window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
        thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
      },
    };
  }

  it('reads ONE window for both arms and persists the sample', () => {
    const { source, samples, input } = cycleInput([
      ...armTrades('live', [10, 10, 10, 10, 10]),
      ...armTrades('control', [1, 1, 1, 1, 1]),
    ]);

    const sample: ArmComparisonSample = runArmComparisonCycle(input);

    expect(source.windows).toHaveLength(1);
    expect(source.windows[0]?.to).toEqual(NOW);
    expect(source.windows[0]?.from).toEqual(new Date(NOW.getTime() - input.window_ms));
    expect(sample.comparison.live.trade_count).toBe(5);
    expect(sample.comparison.control.trade_count).toBe(5);
    expect(samples.getRecent(10, NOW)).toHaveLength(1);
    expect(samples.getRecent(10, NOW)[0]?.computed_at).toEqual(NOW);
  });

  it('alerts on divergence, once, carrying both arms and the convergence caveat', () => {
    // Control +2% of the £1,000 basis, live flat-to-down, control drawdown 0.
    const { alerts, input } = cycleInput([
      ...armTrades('live', [-1, -1, -1, -1, -1]),
      ...armTrades('control', [4, 4, 4, 4, 4]),
    ]);

    const sample = runArmComparisonCycle(input);

    expect(sample.divergence.diverged).toBe(true);
    expect(alerts.posted).toHaveLength(1);
    const alert = alerts.posted[0];
    expect(alert?.comparison.live.max_drawdown_pct).toBeGreaterThanOrEqual(0);
    expect(alert?.comparison.control.return_pct).toBeGreaterThan(
      alert?.comparison.live.return_pct ?? 0,
    );
    expect(alert?.reported_at).toEqual(NOW);
  });

  it('does not alert when the arms have not diverged', () => {
    const { alerts, input } = cycleInput([
      ...armTrades('live', [10, 10, 10, 10, 10]),
      ...armTrades('control', [1, 1, 1, 1, 1]),
    ]);

    const sample = runArmComparisonCycle(input);

    expect(sample.divergence.diverged).toBe(false);
    expect(alerts.posted).toHaveLength(0);
  });

  /**
   * The zero-trade case is the one an empty soak produces, and it must persist
   * a sample rather than silently skipping: an absent row and a computed row
   * with no trades in it are different facts.
   */
  it('persists a sample with no trades, and never alerts on it', () => {
    const { alerts, samples, input } = cycleInput([]);

    const sample = runArmComparisonCycle(input);

    expect(sample.comparison.live.trade_count).toBe(0);
    expect(sample.comparison.control.trade_count).toBe(0);
    expect(samples.getRecent(10, NOW)).toHaveLength(1);
    expect(alerts.posted).toHaveLength(0);
  });
});
