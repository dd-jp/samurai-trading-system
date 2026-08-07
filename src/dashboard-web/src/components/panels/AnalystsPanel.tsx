/**
 * Per-analyst weights and rolling attribution (dashboard-spec.md story 6).
 *
 * The weight is shown **numerically as well as** as a bar, so the comparison
 * does not depend on judging bar lengths — and the bar is dropped entirely,
 * with its reason, when the weight is not a number this can draw. Rolling-R
 * carries an explicit sign from `formatSignedR` and its window in days, because
 * "+1.84R" over 7 days and over 90 days are different claims.
 */

import type { AnalystPerformanceRow } from '../../../../dashboard/types.ts';
import { barWidth, formatCount, formatPercent, formatSignedR } from '../../lib/format.ts';

export interface AnalystsPanelProps {
  analysts: readonly AnalystPerformanceRow[];
}

export function AnalystsPanel({ analysts }: AnalystsPanelProps) {
  return (
    <section className="panel panel-analysts" aria-label="Analysts">
      <div className="panel-head">
        <h2>Analysts</h2>
        <span className="panel-sub">weight × rolling realized R</span>
      </div>
      {analysts.length === 0 ? (
        <p className="empty-state">
          No analyst weights on this snapshot — the Feedback Loop writes them nightly, so an empty
          list means no run has landed yet.
        </p>
      ) : (
        <ul className="analyst-list">
          {analysts.map((analyst) => {
            const width = barWidth(analyst.weight);
            return (
              <li key={analyst.analyst_id} className="analyst-row">
                <span className="analyst-name">{analyst.analyst_id}</span>
                {width === null ? (
                  <span className="analyst-bar-missing">weight not a drawable number</span>
                ) : (
                  <span className="analyst-bar" aria-hidden="true">
                    <i style={{ width }} />
                  </span>
                )}
                <span className="analyst-weight numeric">{formatPercent(analyst.weight, 0)}</span>
                <span
                  className={
                    analyst.rolling_r < 0 ? 'analyst-r numeric loss' : 'analyst-r numeric gain'
                  }
                >
                  {formatSignedR(analyst.rolling_r)}
                </span>
                <span className="analyst-window">{formatCount(analyst.window_days)}d window</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
