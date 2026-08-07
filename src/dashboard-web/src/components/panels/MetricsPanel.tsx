/**
 * The metrics suite (dashboard-spec.md story 7): Sharpe, Sortino, Calmar, max
 * drawdown, profit factor, expectancy, skew, excess kurtosis, turnover and
 * exposure — **reported together, never one number**. The research constraints
 * exist because one metric in isolation misleads, so there is no headline tile
 * here and there is not meant to be.
 *
 * ## The sparkline plots equity, and only when equity is real
 *
 * `metrics` is a suite of scalars: the wire carries no equity series, and the
 * only equity figure on the snapshot is `providers.alpaca.balance.equity`,
 * which is the broker's own number and is `null` unless the probe reports
 * `ok`. So the series drawn here is what THIS PAGE observed — one sample per
 * poll that carried a live balance — and it is labelled that way. It is not a
 * historical equity curve, and the panel does not pretend to have one.
 *
 * The alternative considered and rejected: summing `unrealized_pnl` across
 * open positions. That sum is taken over a changing set of positions, so
 * consecutive points would measure different quantities — a line whose y-axis
 * changes meaning between points is exactly what the honesty conventions
 * exist to stop.
 */

import type { MetricsSuiteWire } from '../../../../dashboard/types.ts';
import { formatFixed, formatPercent, formatUsd } from '../../lib/format.ts';

/** One observed equity sample: the broker's equity at a snapshot's `as_of`. */
export interface EquitySample {
  as_of: string;
  equity: number;
}

export interface MetricsPanelProps {
  metrics: MetricsSuiteWire | null;
  /** Samples accumulated this session, oldest first. */
  equitySamples: readonly EquitySample[];
}

const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 40;
/** Below this many points there is no line to draw, only dots pretending to be one. */
const MIN_SPARK_POINTS = 2;

function EquitySparkline({ samples }: { samples: readonly EquitySample[] }) {
  const values = samples.map((sample) => sample.equity).filter((value) => Number.isFinite(value));
  if (values.length < MIN_SPARK_POINTS) {
    return (
      <p className="empty-state">
        No equity series yet — this line plots the Alpaca balance observed once per poll, and the
        probe has reported {values.length === 0 ? 'none' : 'one'} so far. The wire carries no
        historical equity curve; <code>metrics</code> reports the daily suite as scalars.
      </p>
    );
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A flat series is legitimate (nothing traded), so the range guard picks a
  // denominator rather than refusing to draw: `|| 1` keeps the line centred
  // instead of emitting NaN coordinates.
  const span = high - low || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * SPARK_WIDTH;
    const y = SPARK_HEIGHT - 3 - ((value - low) / span) * (SPARK_HEIGHT - 8);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`).join(' ');
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  return (
    <figure className="spark-figure">
      <svg
        className="spark"
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        role="img"
        aria-label={`Alpaca equity observed this session: ${values.length} samples, ${formatUsd(
          first,
        )} to ${formatUsd(last)}`}
      >
        <path
          d={`${path} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT}Z`}
          className="spark-fill"
        />
        <path d={path} className="spark-line" />
      </svg>
      <figcaption className="panel-sub">
        Alpaca equity, {values.length} samples observed this session — not a historical equity
        curve.
      </figcaption>
    </figure>
  );
}

interface Tile {
  label: string;
  value: string;
  /** Extra context the number is meaningless without. */
  note?: string;
}

function tilesFor(metrics: MetricsSuiteWire): Tile[] {
  return [
    { label: 'Sharpe', value: formatFixed(metrics.sharpe), note: 'annualized, Lo-adjusted' },
    { label: 'Sortino', value: formatFixed(metrics.sortino) },
    { label: 'Calmar', value: formatFixed(metrics.calmar) },
    { label: 'Max drawdown', value: formatPercent(metrics.max_drawdown, 2) },
    { label: 'Profit factor', value: formatFixed(metrics.profit_factor) },
    {
      label: 'Expectancy',
      value: formatFixed(metrics.expectancy),
      note: 'per trade, net of costs',
    },
    { label: 'Skew', value: formatFixed(metrics.skew) },
    { label: 'Excess kurtosis', value: formatFixed(metrics.kurtosis), note: '0 = normal' },
    { label: 'Turnover', value: formatFixed(metrics.turnover) },
    { label: 'Exposure', value: formatPercent(metrics.exposure, 1) },
    {
      label: 'Observations',
      value: formatFixed(metrics.observations, 0),
      note: 'return samples in the suite',
    },
  ];
}

export function MetricsPanel({ metrics, equitySamples }: MetricsPanelProps) {
  return (
    <section className="panel panel-metrics" aria-label="Metrics suite">
      <div className="panel-head">
        <h2>Metrics suite</h2>
        <span className="panel-sub">daily suite — reported together, never one number</span>
      </div>
      {metrics === null ? (
        <p className="empty-state">
          No metrics on this snapshot — the Feedback Loop reports its suite daily, so an empty panel
          here means no daily run has landed yet.
        </p>
      ) : (
        <ul className="stat-grid">
          {tilesFor(metrics).map((tile) => (
            <li key={tile.label} className="stat">
              <span className="stat-label">{tile.label}</span>
              <b className="stat-value numeric">{tile.value}</b>
              {tile.note !== undefined && <span className="stat-note">{tile.note}</span>}
            </li>
          ))}
        </ul>
      )}
      <EquitySparkline samples={equitySamples} />
    </section>
  );
}
