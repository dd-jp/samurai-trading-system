/**
 * `renderPerformance` — CLI Performance view (#97, docs/specs/cli-spec.md
 * "Module: Views"). Renders current per-analyst weights, their rolling
 * attribution, and the Feedback Loop's daily `MetricsSuite` — the full
 * metrics picture the research constraints require, not a single vanity
 * number. Pure function of `(QueryStore, asOf)`, matching `renderDebates`'s
 * one-seam-per-view convention.
 */
import type { QueryStore } from './types.js';

export function renderPerformance(store: QueryStore, asOf: Date): string {
  const weights = store.getAnalystWeights(asOf);
  const attribution = store.getAttribution(asOf);
  const metrics = store.getDailyMetrics(asOf);

  const lines: string[] = ['=== Performance ===', '-- Analyst Weights --'];

  const weightEntries = Object.entries(weights);
  if (weightEntries.length === 0) {
    lines.push('No analyst weights.');
  } else {
    for (const [analystId, weight] of weightEntries) {
      lines.push(`${analystId}  weight=${weight}`);
    }
  }

  lines.push('-- Rolling Attribution --');
  const attributionEntries = Object.entries(attribution);
  if (attributionEntries.length === 0) {
    lines.push('No attribution data.');
  } else {
    for (const [analystId, summary] of attributionEntries) {
      lines.push(
        `${analystId}  rolling_r=${summary.rolling_r}  window_days=${summary.window_days}`,
      );
    }
  }

  lines.push(
    '-- Daily Metrics --',
    `sharpe=${metrics.sharpe}  sortino=${metrics.sortino}  calmar=${metrics.calmar}  max_drawdown=${metrics.max_drawdown}`,
    `profit_factor=${metrics.profit_factor}  expectancy=${metrics.expectancy}  skew=${metrics.skew}  kurtosis=${metrics.kurtosis}`,
    `turnover=${metrics.turnover}  exposure=${metrics.exposure}`,
  );

  return lines.join('\n');
}
