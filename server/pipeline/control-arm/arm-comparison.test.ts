/**
 * #753 acceptance criteria 4 and 5, as tests:
 *
 * - both arms measured over the SAME window from the SAME read, with return AND
 *   drawdown reported together for each;
 * - a return-only comparison CANNOT be produced from the report.
 *
 * The second is a claim about a type, so the test that carries it is a
 * structural one (`Object.keys`) plus a `@ts-expect-error`: if
 * `max_drawdown_pct` were ever made optional, the compiler stops rejecting the
 * drawdown-less literal and this file fails to type-check.
 */
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
        // Live: +40, −10, +20 → ends +50, deepest fall from peak 40 is 10.
        trade({ arm: 'live', closed_at: new Date('2026-09-01T09:00:00Z'), realized_pnl_net: 40 }),
        trade({ arm: 'live', closed_at: new Date('2026-09-01T10:00:00Z'), realized_pnl_net: -10 }),
        trade({ arm: 'live', closed_at: new Date('2026-09-01T11:00:00Z'), realized_pnl_net: 20 }),
        // Control: −30, +90 → ends +60 (BEATS live on return) with a 30 hole
        // first. This is doc 12 D4's exact scenario: the return-only reading
        // says the indicator arm won.
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

    // The same window and the same denominator for both — which is what makes
    // the two `return_pct` numbers comparable at all.
    expect(comparison.from).toEqual(WINDOW_FROM);
    expect(comparison.to).toEqual(WINDOW_TO);
    expect(comparison.basis).toBe(1_000);
  });

  /**
   * AC5, structurally. Every per-arm view the report exposes carries a
   * drawdown; there is no shape a caller can destructure that omits it.
   */
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

    // If `max_drawdown_pct` were ever loosened to optional, this stops erroring
    // and the file fails to type-check — the compiler is the enforcement.
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
        // Exactly at `from`: excluded (half-open at the start).
        trade({ arm: 'live', closed_at: WINDOW_FROM, realized_pnl_net: 999 }),
        // Exactly at `to`: included.
        trade({ arm: 'control', closed_at: WINDOW_TO, realized_pnl_net: 25 }),
        // After the window: excluded.
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

  /**
   * #1099. Before this, a window of nothing but refused control passes was
   * `trade_count: 0` on both arms — the same row an idle control arm writes.
   */
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

  /**
   * The high-water mark is the capital the arm started with, not its best
   * trade: an arm that is down from its first close has a real drawdown.
   */
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
    // 'a' (−10) sorts first, so the series dips before it peaks.
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

  /**
   * #1546. The counts are produced by the reader and carried through untouched
   * — `buildArmComparison` does not re-derive them from `trades`, and could
   * not: the dropped rows are precisely the ones absent from `trades`.
   */
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

/**
 * #1546. The partition is the whole measurement: a `close_reason` in the wrong
 * bucket moves a row between the one-capture and the two-capture population and
 * silently flattens the asymmetry the counts exist to show.
 */
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

  /**
   * The `never` arm is the real guard — a fifth `close_reason` is a compile
   * error, not a silent flatten. This pins the runtime half for a row that
   * reached the database outside the type system (a hand-edited or
   * future-migration value), which must be loud rather than miscounted.
   */
  it('throws on a close_reason it cannot classify', () => {
    const unclassifiable = 'partial_liquidation' as ClosedTrade['close_reason'];
    expect(() => exitClassOf(unclassifiable)).toThrow(/unhandled close_reason/);
  });
});

/**
 * #1595: `cumulativePnl` is the derivation `performanceFor` (above) and the
 * dashboard's P&L headline both build on. These tests exercise it directly,
 * with no `arm` filtering in the input — the function's whole contract is
 * "sum what you're given", and `buildArmComparison`'s own suite above already
 * proves the filter-then-delegate wiring produces the same numbers it always
 * did.
 */
describe('cumulativePnl', () => {
  it('sums realized PnL and finds the deepest peak-to-trough fall, as a fraction of basis', () => {
    // +40, −10, +20 → ends +50; peak reaches 40, falls to 30 (a 10 drawdown),
    // never falls below a later peak after that.
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
    // +40 then -30: peak 40, trough 10 → drawdown 30. Given out of order, an
    // unsorted sum would still total 10 but the WRONG drawdown (0, since -30
    // would be read as the first, lower-then-rising point) if this function
    // summed in input order instead of `closed_at` order.
    expect(forward.max_drawdown_pct).toBeCloseTo(0.03);
  });
});
