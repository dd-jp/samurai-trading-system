import type { ClosedTrade, TradingArm } from '../../shared/index.js';
import {
  type ArmPerformance,
  buildArmComparison,
  cumulativePnl,
  exitClassOf,
  noCostBasisDrops,
} from './arm-comparison.js';

const WINDOW_FROM = new Date('2026-09-01T08:00:00.000Z');
const WINDOW_TO = new Date('2026-09-01T16:00:00.000Z');

function trade(
  overrides: Partial<ClosedTrade> & { arm?: TradingArm } & { closed_at: Date },
): ClosedTrade & { arm?: TradingArm } {
  return {
    idempotency_key: `key-${overrides.closed_at.toISOString()}-${overrides.arm ?? 'live'}`,
    debate_id: 'debate-1',
    instrument: '3LUS',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 98,
    filled_size: 3,
    realized_pnl_net: 0,
    fees_total: 0.5,
    opened_at: WINDOW_FROM,
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

describe('buildArmComparison (#753 — the two-arm report)', () => {
  it('reports return AND drawdown for BOTH arms over one shared window', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [
        trade({ arm: 'live', closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: 40 }),
        trade({ arm: 'live', closed_at: new Date('2026-09-01T10:00:00Z'), realized_pnl_net: -10 }),
        trade({ arm: 'live', closed_at: new Date('2026-09-01T11:00:00Z'), realized_pnl_net: 20 }),
        trade({
          arm: 'control',
          closed_at: new Date('2026-09-01T09:30:00Z'),
          realized_pnl_net: -30,
        }),
        trade({
          arm: 'control',
          closed_at: new Date('2026-09-01T12:00:00Z'),
          realized_pnl_net: 90,
        }),
      ],
    });

    expect(comparison.live).toEqual<ArmPerformance>({
      arm: 'live',
      trade_count: 3,
      realized_pnl_net: 50,
      return_pct: 0.05,
      max_drawdown_pct: 0.01,
      refused_pass_count: 0,
      cost_basis_drops: noCostBasisDrops(),
    });
    expect(comparison.control).toEqual<ArmPerformance>({
      arm: 'control',
      trade_count: 2,
      realized_pnl_net: 60,
      return_pct: 0.06,
      max_drawdown_pct: 0.03,
      refused_pass_count: 0,
      cost_basis_drops: noCostBasisDrops(),
    });

    expect(comparison.from).toEqual(WINDOW_FROM);
    expect(comparison.to).toEqual(WINDOW_TO);
    expect(comparison.basis).toBe(1_000);
  });

  it('cannot express a per-arm result without a drawdown', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [],
    });

    for (const arm of [comparison.live, comparison.control]) {
      expect(Object.keys(arm).sort()).toEqual([
        'arm',
        'cost_basis_drops',
        'max_drawdown_pct',
        'realized_pnl_net',
        'refused_pass_count',
        'return_pct',
        'trade_count',
      ]);
      expect(typeof arm.max_drawdown_pct).toBe('number');
    }

    // @ts-expect-error — a return-only ArmPerformance must not type-check.
    const returnOnly: ArmPerformance = {
      arm: 'control',
      trade_count: 0,
      realized_pnl_net: 0,
      return_pct: 0,
    };
    expect(returnOnly.arm).toBe('control');
  });

  it('measures both arms over the identical window — a trade outside it counts for neither', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 500,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [
        trade({ arm: 'live', closed_at: WINDOW_FROM, realized_pnl_net: 999 }),
        trade({ arm: 'control', closed_at: WINDOW_TO, realized_pnl_net: 25 }),
        trade({
          arm: 'live',
          closed_at: new Date('2026-09-01T16:00:00.001Z'),
          realized_pnl_net: 999,
        }),
      ],
    });

    expect(comparison.live.trade_count).toBe(0);
    expect(comparison.live.realized_pnl_net).toBe(0);
    expect(comparison.control.trade_count).toBe(1);
    expect(comparison.control.return_pct).toBeCloseTo(0.05, 12);
  });

  it('reports refused passes per arm, so a refusal stretch is not silence', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 6 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [],
    });

    expect(comparison.control.trade_count).toBe(0);
    expect(comparison.control.refused_pass_count).toBe(6);
    expect(comparison.live.refused_pass_count).toBe(0);
  });

  it('leaves return and drawdown untouched by the refusal count', () => {
    const trades = [trade({ arm: 'control', closed_at: WINDOW_TO, realized_pnl_net: -50 })];
    const quiet = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades,
    });
    const refused = buildArmComparison({
      refused_passes: { live: 0, control: 12 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades,
    });

    expect(refused.control.return_pct).toBe(quiet.control.return_pct);
    expect(refused.control.max_drawdown_pct).toBe(quiet.control.max_drawdown_pct);
    expect(refused.control.trade_count).toBe(quiet.control.trade_count);
  });

  it('counts an arm-less row as live — every pre-#753 row was the live arm', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [trade({ closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: 10 })],
    });

    expect(comparison.live.trade_count).toBe(1);
    expect(comparison.control.trade_count).toBe(0);
  });

  it('measures drawdown from the starting capital, not from the first peak', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [
        trade({
          arm: 'control',
          closed_at: new Date('2026-09-01T09:00:00Z'),
          realized_pnl_net: -80,
        }),
        trade({
          arm: 'control',
          closed_at: new Date('2026-09-01T10:00:00Z'),
          realized_pnl_net: 20,
        }),
      ],
    });

    expect(comparison.control.return_pct).toBeCloseTo(-0.06, 12);
    expect(comparison.control.max_drawdown_pct).toBeCloseTo(0.08, 12);
  });

  it('is deterministic when two lots close in the same second', () => {
    const sameSecond = new Date('2026-09-01T09:00:00Z');
    const rows = [
      {
        ...trade({ arm: 'live', closed_at: sameSecond, realized_pnl_net: 30 }),
        idempotency_key: 'b',
      },
      {
        ...trade({ arm: 'live', closed_at: sameSecond, realized_pnl_net: -10 }),
        idempotency_key: 'a',
      },
    ];
    const forward = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: rows,
    });
    const reversed = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [...rows].reverse(),
    });

    expect(reversed.live).toEqual(forward.live);
    expect(forward.live.max_drawdown_pct).toBeCloseTo(0.01, 12);
  });

  it('refuses a basis that would make every percentage meaningless', () => {
    for (const basis of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildArmComparison({
          basis,
          refused_passes: { live: 0, control: 0 },
          cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
          from: WINDOW_FROM,
          to: WINDOW_TO,
          trades: [],
        }),
      ).toThrow(/basis must be a positive, finite number/);
    }
  });

  it('carries each arm its own cost-basis drop counts', () => {
    const comparison = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: {
        live: { protective: { kept: 4, dropped: 1 }, flatten: { kept: 2, dropped: 5 } },
        control: { protective: { kept: 6, dropped: 0 }, flatten: { kept: 3, dropped: 0 } },
      },
      basis: 1_000,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      trades: [],
    });

    expect(comparison.live.cost_basis_drops.flatten).toEqual({ kept: 2, dropped: 5 });
    expect(comparison.live.cost_basis_drops.protective).toEqual({ kept: 4, dropped: 1 });
    expect(comparison.control.cost_basis_drops.flatten).toEqual({ kept: 3, dropped: 0 });
  });
});

describe('exitClassOf', () => {
  it('puts venue-resting bracket legs in the protective class', () => {
    expect(exitClassOf('stop')).toBe('protective');
    expect(exitClassOf('target')).toBe('protective');
  });

  it('puts every in-process exit, including the legacy spelling, in the flatten class', () => {
    expect(exitClassOf('exit')).toBe('flatten');
    expect(exitClassOf('flatten')).toBe('flatten');
    expect(exitClassOf('signal_decay')).toBe('flatten');
    expect(exitClassOf('direction_flip')).toBe('flatten');
  });

  it('throws on a close_reason it cannot classify', () => {
    const unclassifiable = 'partial_liquidation' as ClosedTrade['close_reason'];
    expect(() => exitClassOf(unclassifiable)).toThrow(/unhandled close_reason/);
  });
});

describe('cumulativePnl', () => {
  it('sums realized PnL and finds the deepest peak-to-trough fall, as a fraction of basis', () => {
    const result = cumulativePnl(
      [
        trade({ closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: 40 }),
        trade({ closed_at: new Date('2026-09-01T10:00:00Z'), realized_pnl_net: -10 }),
        trade({ closed_at: new Date('2026-09-01T11:00:00Z'), realized_pnl_net: 20 }),
      ],
      1_000,
    );

    expect(result.net).toBe(50);
    expect(result.return_pct).toBeCloseTo(0.05);
    expect(result.max_drawdown_pct).toBeCloseTo(0.01);
  });

  it('reports a real drawdown from the very first trade — the high-water mark starts at 0, not at the first trade', () => {
    const result = cumulativePnl(
      [trade({ closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: -25 })],
      1_000,
    );

    expect(result.net).toBe(-25);
    expect(result.max_drawdown_pct).toBeCloseTo(0.025);
  });

  it('returns a zero drawdown, not an absent one, for an empty series', () => {
    const result = cumulativePnl([], 1_000);

    expect(result.net).toBe(0);
    expect(result.return_pct).toBe(0);
    expect(result.max_drawdown_pct).toBe(0);
  });

  it('sorts by closed_at before summing, so input order does not change the drawdown', () => {
    const early = trade({ closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: 40 });
    const late = trade({ closed_at: new Date('2026-09-01T11:00:00Z'), realized_pnl_net: -30 });

    const forward = cumulativePnl([early, late], 1_000);
    const reversed = cumulativePnl([late, early], 1_000);

    expect(reversed).toEqual(forward);
    expect(forward.max_drawdown_pct).toBeCloseTo(0.03);
  });
});
