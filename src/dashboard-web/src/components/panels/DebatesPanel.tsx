/**
 * Recent completed debates (dashboard-spec.md stories 3, 4d): direction,
 * rounds, and each analyst's stance strip with a legend.
 *
 * Completed debates only, deliberately. The Debate Engine does not persist
 * round-by-round operational state (decision #10), so there is no live
 * debate-round view to render here and the coarse "tick in progress" line
 * lives in the telemetry strip instead. Rows are rendered in wire order — the
 * store already returns them most-recent-first, and a second comparator over
 * the same facts is a way to disagree with it.
 */

import type { DebateRow } from '../../../../dashboard/types.ts';
import { formatClockUtc, formatFixed } from '../../lib/format.ts';
import { StanceStrip } from '../StanceStrip.tsx';

export interface DebatesPanelProps {
  debates: readonly DebateRow[];
}

export function DebatesPanel({ debates }: DebatesPanelProps) {
  return (
    <section className="panel panel-debates" aria-label="Recent debates">
      <div className="panel-head">
        <h2>Recent debates</h2>
        <span className="panel-sub">completed only · direction · rounds · stances</span>
      </div>
      {debates.length === 0 ? (
        <p className="empty-state">
          No completed debate in the recent-debates window. In-flight rounds are not persisted
          (decision #10), so a debate appears here only once it finishes.
        </p>
      ) : (
        <>
          <ul className="debate-list">
            {debates.map((debate) => (
              <li key={debate.debate_id} className="debate-row">
                <div className="debate-head">
                  <span className="debate-symbol">{debate.instrument}</span>
                  <span className={`direction direction-${debate.direction}`}>
                    {debate.direction}
                  </span>
                  <span className="debate-rounds">{debate.rounds} rounds</span>
                  <span className="debate-time">{formatClockUtc(debate.created_at)}</span>
                </div>
                <ul className="debate-contributions">
                  {debate.contributions.map((contribution) => (
                    <li key={contribution.analyst_id} className="debate-contribution">
                      <span className="stance-name">{contribution.analyst_id}</span>
                      <StanceStrip
                        stances={contribution.stance_during_debate}
                        finalPosition={contribution.final_position}
                      />
                      <span className="stance-final">→ {contribution.final_position}</span>
                      <span className="stance-influence numeric">
                        {formatFixed(contribution.influence_score, 2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="legend">
            <span>
              <i className="stance-mark stance-bullish" aria-hidden="true" /> bullish
            </span>
            <span>
              <i className="stance-mark stance-bearish" aria-hidden="true" /> bearish
            </span>
            <span>
              <i className="stance-mark stance-neutral" aria-hidden="true" /> neutral
            </span>
            <span className="legend-note">
              influence 0–1 · stance strips read round 1 → round N
            </span>
          </p>
        </>
      )}
    </section>
  );
}
