export interface MetricsSuite {
  sharpe: number;
  sortino: number;
  calmar: number;
  max_drawdown: number;
  profit_factor: number;
  expectancy: number;
  skew: number;
  kurtosis: number;
  per_period_sharpe: number;
  annualization_factor: number;
  observations: number;
  turnover: number;
  exposure: number;
}

export type ProfitFactorWire =
  | { kind: 'ratio'; value: number }
  | { kind: 'no_losses' }
  | { kind: 'unreadable' };

export function toProfitFactorWire(value: number): ProfitFactorWire {
  if (Number.isFinite(value)) return { kind: 'ratio', value };
  if (value === Number.POSITIVE_INFINITY) return { kind: 'no_losses' };
  return { kind: 'unreadable' };
}
