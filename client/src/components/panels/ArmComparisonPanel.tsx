/**
 * Falsifier arm 2 against the live arm (#971, #913 surface 2; dashboard-spec.md
 * story 8) — the debate layer's own falsifier, on the operator's screen.
 *
 * ## Both columns, always, on every branch
 *
 * `docs/research/12-edge-hypothesis-critique.md` D4 rules out a return-only
 * comparison against a risk-targeted stream, and CLAUDE.md's Key Constraints
 * line says the same thing about this exact pair of arms. The wire makes that
 * structural — `ArmPerformanceWire.max_drawdown_pct` is required, so no
 * drawdown-less row reaches this file — and this panel holds the other half of
 * it: **there is no branch below that renders a return without the drawdown
 * beside it**, and no toggle that hides one column. Both figures come off the
 * same row object for the same reason `formatArmComparison` prints them on one
 * line at the CLI (#753 AC5).
 *
 * ## The empty state is a reading, not a blank
 *
 * No samples means the Feedback Loop has not computed a comparison yet, and it
 * says so. Rendering zeros instead would read as "both arms flat, no
 * divergence" — a claim about the book rather than about the measurement.
 *
 * ## The asymmetry is on the panel, not only in the spec
 *
 * The control arm has no debate rounds, so it is always treated as converged.
 * On bars where the live debate did not converge the live arm takes a size
 * haircut and refuses a scale-in and the control takes neither — so a
 * non-converging stretch can produce a gap here on its own. That caveat is
 * printed under the trend rather than left in `feedback-loop-spec.md`, for the
 * same reason it travels with the alert body.
 */

import type { ArmComparisonRow, ArmPerformanceWire } from '@contracts';
import { formatClockUtc, formatCount, formatPercent, formatSignedUsd } from '../../lib/format.ts';

export interface ArmComparisonPanelProps {
  /** Most-recently-computed first. Empty = the Feedback Loop has computed none. */
  comparisons: readonly ArmComparisonRow[];
}

const ARM_LABEL: Record<ArmPerformanceWire['arm'], string> = {
  live: 'live (debate)',
  control: 'control (arm 2)',
};

/**
 * One arm's row. Takes the whole `ArmPerformanceWire` rather than individual
 * numbers: a props shape of `{ returnPct }` would be a drawdown-less view of an
 * arm, which is precisely what the wire type refuses to let exist.
 */
function ArmRow({ arm }: { arm: ArmPerformanceWire }) {
  return (
    <li className="arm-row">
      <span className="arm-name">{ARM_LABEL[arm.arm]}</span>
      <span className="arm-trades numeric">{formatCount(arm.trade_count)} trades</span>
      <span className="arm-return numeric">return {formatPercent(arm.return_pct, 2)}</span>
      <span className="arm-drawdown numeric">
        max drawdown {formatPercent(arm.max_drawdown_pct, 2)}
      </span>
      <span className="arm-pnl numeric">{formatSignedUsd(arm.realized_pnl_net)}</span>
    </li>
  );
}

export function ArmComparisonPanel({ comparisons }: ArmComparisonPanelProps) {
  const latest = comparisons[0];

  return (
    <section className="panel panel-arm-comparison" aria-label="Arm comparison">
      <div className="panel-head">
        <h2>Arm comparison</h2>
        <span className="panel-sub">falsifier arm 2 vs the live arm · return AND drawdown</span>
      </div>

      {latest === undefined ? (
        <p className="empty-state">
          The Feedback Loop has not computed a comparison yet. It runs on the daily feedback cycle —
          this is a missing measurement, not two flat arms.
        </p>
      ) : (
        <>
          <p className="arm-window">
            {formatClockUtc(latest.window_from)} → {formatClockUtc(latest.window_to)} · one window,
            both arms · basis £{latest.basis.toFixed(2)}
          </p>
          <ul className="arm-list">
            <ArmRow arm={latest.live} />
            <ArmRow arm={latest.control} />
          </ul>
          {latest.diverged && latest.divergence_reason !== null ? (
            <p className="arm-divergence">DIVERGED: {latest.divergence_reason}.</p>
          ) : (
            <p className="arm-divergence arm-ok">
              No divergence: the control is not ahead of the live arm on both return and drawdown
              together.
            </p>
          )}
          {comparisons.length > 1 ? (
            <ul className="arm-trend">
              {comparisons.map((row) => (
                <li key={row.computed_at} className={row.diverged ? 'arm-trend-diverged' : ''}>
                  <span>{formatClockUtc(row.computed_at)}</span>
                  <span className="numeric">
                    live {formatPercent(row.live.return_pct, 2)} /{' '}
                    {formatPercent(row.live.max_drawdown_pct, 2)} dd
                  </span>
                  <span className="numeric">
                    control {formatPercent(row.control.return_pct, 2)} /{' '}
                    {formatPercent(row.control.max_drawdown_pct, 2)} dd
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="arm-caveat">
            One known asymmetry: the control has no debate rounds, so it is always treated as
            converged. On bars where the live debate did not converge, the live arm takes a size
            haircut and refuses a scale-in and the control takes neither.
          </p>
        </>
      )}
    </section>
  );
}
