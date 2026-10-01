import type { CostConfig, MarketState, PolygonAggregate, PolygonClient } from './backtest/index.js';
import { CostModelImpl } from './backtest/index.js';
import {
  printReport,
  runCostDecomposition,
  scaleCostConfig,
} from './run-stage2-cost-decomposition.js';

const DAY_MS = 86_400_000;

function cyclingAggregates(startMs: number, bars: number): PolygonAggregate[] {
  const closes = Array.from(
    { length: bars },
    (_, i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 100) + 0.02 * i,
  );
  return closes.map((close, i) => {
    const prevClose = i === 0 ? close : (closes[i - 1] as number);
    return {
      t: startMs + i * DAY_MS,
      o: prevClose,
      h: Math.max(close, prevClose) + 1,
      l: Math.min(close, prevClose) - 1,
      c: close,
      v: 1_000,
    };
  });
}

describe('runCostDecomposition', () => {
  it('scores the grid net and gross, sweeps the cost scales and prints the report', async () => {
    const start = Date.UTC(2020, 0, 1);
    const bars = 500;
    const client: PolygonClient = {
      async fetchAggregates() {
        return cyclingAggregates(start, bars);
      },
    };
    const lines: string[] = [];

    const result = await runCostDecomposition({
      polygonClient: client,
      window: { start: new Date(start), end: new Date(start + (bars - 1) * DAY_MS) },
      dbPath: ':memory:',
      print: (line) => lines.push(line),
    });

    expect(result.rows).toHaveLength(8);
    expect(result.sensitivity.map((point) => point.scale)).toEqual([1, 0.5, 0.25, 0.1, 0.05]);
    expect(result.passes_net).toBeLessThanOrEqual(result.rows.length);
    expect(result.passes_gross).toBeLessThanOrEqual(result.rows.length);
    expect(lines[0]).toMatch(/^Stage 2 cost decomposition: ingesting over 2020-01-01/);
    expect(lines).toContain('=== Discriminator ===');
  });
});

describe('printReport', () => {
  const row = {
    config_hash: 'abc',
    asset_class: 'stocks' as const,
    label: 'sma 10/50',
    net_oos_sharpe: 0.1,
    gross_oos_sharpe: 0.6,
    net_window_sharpe: 0.2,
    gross_window_sharpe: 0.7,
    net_profit_factor: 1.1,
    gross_profit_factor: 1.4,
    turnover: 12.34,
    costs: {
      total: 120,
      spread: 50,
      slippage: 30,
      market_impact: 20,
      commission: 20,
      bps_of_notional: 4.25,
      trades: 9,
    },
  };

  function report(overrides: { passes_gross: number; passes_net: number; atr?: number }) {
    const lines: string[] = [];
    const costs =
      overrides.atr === undefined
        ? row.costs
        : { ...row.costs, mean_adverse_move_in_atr: overrides.atr };
    printReport(
      {
        window: { start: new Date(0), end: new Date(DAY_MS) },
        rows: [{ ...row, costs } as Parameters<typeof printReport>[0]['rows'][number]],
        passes_gross: overrides.passes_gross,
        passes_net: overrides.passes_net,
        sensitivity: [{ scale: 0.5, passes: 1, stocks_bps: 2.04, crypto_bps: 3 }],
      },
      (line) => lines.push(line),
    );
    return lines;
  }

  it('calls a gross-only rescue cost drag and prints the adverse move when known', () => {
    const lines = report({ passes_gross: 1, passes_net: 0, atr: 0.1234 });
    expect(lines).toContain('[stocks] sma 10/50 (abc)');
    expect(lines).toContain(
      '    cost rate: 4.3bps of notional over 9 trades, 0.123 ATR adverse move per fill',
    );
    expect(lines).toContain('  cost×0.5   passes=1/1 stocks=2.0bps crypto=3.0bps');
    expect(lines).toContain('  cost×0     passes=1/1 (gross)');
    expect(lines.at(-1)).toBe(
      'Removing modeled costs rescues configs: the net kill is at least partly COST DRAG.',
    );
  });

  it('calls an unrescued kill the signal and omits an unknown adverse move', () => {
    const lines = report({ passes_gross: 0, passes_net: 0 });
    expect(lines).toContain('    cost rate: 4.3bps of notional over 9 trades');
    expect(lines.at(-1)).toBe(
      'Removing modeled costs rescues nothing: the kill is the SIGNAL, not the cost model.',
    );
  });
});

const BASE: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.5,
    commissionRate: 0.001,
    slippageCoefficient: 0.2,
    impactK: 0.1,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.0005,
    slippageCoefficient: 0.05,
    impactK: 0.05,
  },
};

describe('scaleCostConfig', () => {
  it('scales every coefficient of both asset classes by factor', () => {
    const scaled = scaleCostConfig(BASE, 0.5);

    expect(scaled.stocks.commissionRate).toBeCloseTo(0.00025, 10);
    expect(scaled.crypto.commissionRate).toBeCloseTo(0.0005, 10);
    expect(scaled.stocks.spreadVolatilityCoefficient).toBeCloseTo(0.05, 10);
  });

  it('leaves a config with no floors/venues fields unchanged in that respect', () => {
    const scaled = scaleCostConfig(BASE, 0.1);

    expect(scaled.floors).toBeUndefined();
    expect(scaled.venues).toBeUndefined();
  });

  it('carries floors through UNSCALED rather than dropping them', () => {
    const withFloors: CostConfig = {
      ...BASE,
      floors: { minHalfSpreadRate: 0.002, minCommissionRate: 0.003 },
    };

    const scaled = scaleCostConfig(withFloors, 0.1);

    expect(scaled.floors).toEqual({ minHalfSpreadRate: 0.002, minCommissionRate: 0.003 });
  });

  it('scales every present rate field of each venue override by factor (#1017)', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008, impactK: 0.02 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues?.saxo?.commissionRate).toBeCloseTo(0.00004, 10);
    expect(scaled.venues?.saxo?.impactK).toBeCloseTo(0.001, 10);
  });

  it('leaves a venue override field unset when the input did not set it', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues?.saxo).toEqual({ commissionRate: 0.00004 });
    expect('spreadVolatilityCoefficient' in (scaled.venues?.saxo ?? {})).toBe(false);
  });

  it('copies floors rather than aliasing the input config object', () => {
    const withFloors: CostConfig = {
      ...BASE,
      floors: { minHalfSpreadRate: 0.002, minCommissionRate: 0.003 },
    };

    const scaled = scaleCostConfig(withFloors, 0.1);

    expect(scaled.floors).not.toBe(withFloors.floors);
  });

  it('copies venues (and each per-venue override object) rather than aliasing the input config object', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues).not.toBe(withVenues.venues);
    expect(scaled.venues?.saxo).not.toBe(withVenues.venues?.saxo);
  });

  it('charges the SCALED Saxo rate on a venue-stamped fill (end to end)', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const state: MarketState = {
      mid: 100,
      spread: 0.02,
      adv: 1_000_000,
      volatility: 1,
      asset_class: 'stocks',
      venue: 'saxo',
      timestamp: new Date('2026-09-05T10:00:00Z'),
    };
    const request = {
      instrument: '3USL',
      side: 'buy' as const,
      size: 10,
      order_type: 'market' as const,
      idempotency_key: 'k',
    };

    const full = new CostModelImpl(withVenues).fill(request, state);
    const half = new CostModelImpl(scaleCostConfig(withVenues, 0.5)).fill(request, state);
    const { venue: _venue, ...unstamped } = state;
    const unkeyed = new CostModelImpl(withVenues).fill(request, unstamped);

    expect(full.cost_breakdown.commission).toBeCloseTo(0.8, 10);
    expect(half.cost_breakdown.commission).toBeCloseTo(0.4, 10);
    expect(unkeyed.cost_breakdown.commission).toBeCloseTo(0.5, 10);
  });
});
