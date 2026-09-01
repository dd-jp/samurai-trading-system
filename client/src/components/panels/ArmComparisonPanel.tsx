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
 * ## The non-diverged line now names which of two states it is (#982)
 *
 * `evaluateArmDivergence` returns `diverged: false` for two different reasons:
 * dominance was tested and not found, and — below its per-arm closed-trade floor
 * — dominance was never tested at all. `ArmComparisonRow.min_trades_per_arm`
 * carries the floor each verdict was actually evaluated against, so this panel
 * can now tell the two states apart instead of softening its copy to cover
 * both:
 *
 * - **Below the floor on either arm** — dominance was never tested, so no claim
 *   about the control is made. The panel states the trade counts against the
 *   floor instead ("not enough closed trades yet for a verdict").
 * - **At or above the floor on both arms, and `diverged: false`** — dominance
 *   WAS tested and the control did not win, so the panel makes the claim #979
 *   had to withdraw ("the control is not ahead … on both … together"). It is
 *   provably true here: this branch is only reachable when the floor is
 *   cleared, which is exactly when the test actually ran.
 *
 * The trend list below the headline renders many historical rows at once, and
 * a below-floor row there is otherwise pixel-identical to a tested-and-did-not-
 * diverge row — both show `diverged: false` and neither carries the alert
 * class. Each row's own `min_trades_per_arm` marks it (`arm-trend-below-floor`
 * plus a "below floor" word, never colour alone) so a reader scanning the
 * trend does not read an absent verdict as a settled one. This is also *why*
 * the floor is stored per row rather than once for the whole snapshot: a
 * snapshot-level field could only describe the *current* policy, but this list
 * renders older rows evaluated under whatever the floor was at their own
 * `computed_at`.
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

/**
 * Whether either arm was still below `min_trades_per_arm` when this row was
 * computed — the "dominance was never tested" state (#982). Only meaningful
 * when `diverged` is false: a diverged row proves both arms cleared the floor,
 * by construction of `evaluateArmDivergence`.
 */
function isBelowTradeFloor(row: ArmComparisonRow): boolean {
  return (
    row.live.trade_count < row.min_trades_per_arm ||
    row.control.trade_count < row.min_trades_per_arm
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
          ) : isBelowTradeFloor(latest) ? (
            <p className="arm-divergence arm-below-floor">
              Not enough closed trades yet for a verdict — the floor is {latest.min_trades_per_arm}{' '}
              per arm (live {latest.live.trade_count}, control {latest.control.trade_count}).
            </p>
          ) : (
            <p className="arm-divergence arm-ok">
              Did not diverge: the control is not ahead of the live arm on both return and drawdown
              together.
            </p>
          )}
          {comparisons.length > 1 ? (
            <ul className="arm-trend">
              {comparisons.map((row) => {
                const belowFloor = !row.diverged && isBelowTradeFloor(row);
                return (
                  <li
                    key={row.computed_at}
                    className={
                      row.diverged
                        ? 'arm-trend-diverged'
                        : belowFloor
                          ? 'arm-trend-below-floor'
                          : ''
                    }
                  >
                    <span>{formatClockUtc(row.computed_at)}</span>
                    <span className="numeric">
                      live {formatPercent(row.live.return_pct, 2)} /{' '}
                      {formatPercent(row.live.max_drawdown_pct, 2)} dd
                    </span>
                    <span className="numeric">
                      control {formatPercent(row.control.return_pct, 2)} /{' '}
                      {formatPercent(row.control.max_drawdown_pct, 2)} dd
                    </span>
                    {belowFloor ? <span>below floor</span> : null}
                  </li>
                );
              })}
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
