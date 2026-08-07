/**
 * The detail drawer (dashboard-spec.md, "Verdict ledger + detail drawer"). A
 * chip or a ledger row opens it; it carries the stage strip, the debate's
 * stances x influence, the reserved invalidation section and the trace id.
 *
 * **The stage strip is the sole per-stage record.** A sigil chip is a single
 * point, so a skipped stage and a retried stage have no room to show
 * themselves in the hero (spec, "The primitive's accepted cost"). The strip
 * therefore lists all seven stages including the never-reached ones, with
 * state word, decision, duration, attempts and recorded time.
 *
 * **Every empty state names its reason.** Never a bare dash, never a spinner
 * that cannot resolve: "Trader and Risk persist no decision content (#328)",
 * "round-by-round state is not persisted (decision #10)", "no trace in the
 * last 15 minutes".
 */

import type {
  PipelineCell,
  PipelineLane,
  PipelineStage,
} from '../../../dashboard/pipeline-types.ts';
import type { DebateRow, VerdictRow } from '../../../dashboard/types.ts';
import { formatClockUtc, formatFixed, formatStageDuration, UNKNOWN } from '../lib/format.ts';
import { ROOM_ORDER } from '../lib/room-layout.ts';
import { CELL_STATE_WORD, OUTCOME_WORD, stageName } from '../lib/vocabulary.ts';
import { StanceStrip } from './StanceStrip.tsx';

/**
 * The seven stages, in pipeline order, taken from `ROOM_ORDER` rather than
 * imported as a value from the backend's `PIPELINE_STAGES`: the client's
 * modules keep the backend out of the bundle by importing only types from it,
 * and `room-layout.ts` already redeclares this order under a compile-time
 * exhaustiveness check against the wire union.
 */
const STAGES: readonly PipelineStage[] = ROOM_ORDER.filter(
  (room): room is PipelineStage => room !== 'lobby',
);

export interface DetailDrawerProps {
  instrument: string | null;
  lane: PipelineLane | undefined;
  debate: DebateRow | undefined;
  verdict: VerdictRow | undefined;
}

/** Stages whose decision content nothing persists — owned by #328. */
const UNPERSISTED_DECISION_STAGES: readonly PipelineStage[] = ['trader', 'risk'];

/**
 * The decision column, which is never blank. A `null` decision has four
 * different meanings and each one is spelled out, because "—" for all four
 * would hide the only interesting one (#328).
 */
function decisionText(cell: PipelineCell): string {
  if (cell.decision !== null && cell.decision !== '') return cell.decision;
  if (cell.state === 'not_reached') return 'not reached';
  if (cell.state === 'skipped') return 'skipped — the tick continued';
  // `live` is checked BEFORE the never-persisted stages: a live Trader cell
  // has no decision yet because it is still running, and reporting that as
  // "not persisted (#328)" would blame the schema for a stage that simply has
  // not finished.
  if (cell.state === 'live') return 'in progress';
  if (UNPERSISTED_DECISION_STAGES.includes(cell.stage)) return 'not persisted (#328)';
  return 'no decision recorded';
}

function StageStrip({ lane }: { lane: PipelineLane }) {
  const cellsByStage = new Map(lane.cells.map((cell) => [cell.stage, cell]));
  return (
    <table className="stage-strip">
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">State</th>
          <th scope="col">Decision</th>
          <th scope="col">Attempts</th>
          <th scope="col">Recorded</th>
          <th scope="col" className="numeric">
            Duration
          </th>
        </tr>
      </thead>
      <tbody>
        {STAGES.map((stage) => {
          const cell = cellsByStage.get(stage);
          if (cell === undefined) {
            // The wire contract promises one cell per stage; if a payload
            // breaks it, say so rather than dropping the row silently.
            return (
              <tr key={stage}>
                <td>{stageName(stage)}</td>
                <td colSpan={5} className="muted">
                  no cell for this stage on the wire
                </td>
              </tr>
            );
          }
          return (
            <tr key={stage} data-stage={stage} data-state={cell.state}>
              <td>{stageName(stage)}</td>
              <td>
                <span className={`state-word state-${cell.state}`}>
                  {CELL_STATE_WORD[cell.state]}
                </span>
              </td>
              <td>{decisionText(cell)}</td>
              <td>{cell.attempts > 1 ? `${cell.attempts} attempts` : String(cell.attempts)}</td>
              <td className="muted">
                {cell.recorded_at === null ? 'not recorded' : formatClockUtc(cell.recorded_at)}
              </td>
              <td className="numeric muted">{formatStageDuration(cell.duration_ms)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DebateSection(props: { debate: DebateRow | undefined; lane: PipelineLane | undefined }) {
  const { debate, lane } = props;
  if (debate === undefined) {
    const live = lane?.outcome === 'in_flight';
    return (
      <p className="empty-state">
        {live
          ? 'This tick is in flight — round-by-round state is not persisted (decision #10), so there is nothing to show until the debate completes.'
          : 'No completed debate recorded for this instrument in the recent-debates window.'}
      </p>
    );
  }
  return (
    <>
      <ul className="stance-list">
        {debate.contributions.map((contribution) => (
          <li key={contribution.analyst_id} className="stance-row">
            <span className="stance-name">{contribution.analyst_id}</span>
            <StanceStrip
              stances={contribution.stance_during_debate}
              finalPosition={contribution.final_position}
            />
            <span className="stance-final">final {contribution.final_position}</span>
            <span className="stance-influence numeric">
              influence {formatFixed(contribution.influence_score, 2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="panel-sub">
        {debate.direction} · {debate.rounds} rounds · opened {formatClockUtc(debate.created_at)}
      </p>
    </>
  );
}

export function DetailDrawer(props: DetailDrawerProps) {
  const { instrument, lane, debate, verdict } = props;

  return (
    <section className="drawer-panel" aria-label="Instrument detail">
      <div className="panel-head">
        <h2>{instrument ?? 'Detail'}</h2>
        <span className="panel-sub">
          {instrument === null
            ? 'no instrument selected — choose a sigil chip or a ledger row'
            : lane === undefined
              ? 'no lane on this snapshot for this instrument'
              : `${lane.asset_class} · ${OUTCOME_WORD[lane.outcome]}${
                  lane.final_stage === null
                    ? ''
                    : ` at ${stageName(lane.final_stage).toLowerCase()}`
                }${lane.total_ms === null ? '' : ` · ${formatStageDuration(lane.total_ms)} total`}`}
        </span>
        <span className="drawer-trace">
          {lane === undefined || lane.trace_id === null ? 'no trace' : `trace ${lane.trace_id}`}
        </span>
      </div>

      {lane === undefined ? (
        <p className="empty-state">
          {instrument === null
            ? 'Select an instrument to see its stage strip, debate stances and invalidation section.'
            : 'This instrument has no lane in the current snapshot.'}
        </p>
      ) : lane.trace_id === null ? (
        <p className="empty-state">
          No trace in the last 15 minutes — this instrument is idle and stands in the Lobby.
        </p>
      ) : (
        <StageStrip lane={lane} />
      )}

      {lane !== undefined && (
        <>
          <p className="drawer-started">
            {lane.started_at === null
              ? 'no start time recorded for this lane'
              : `started ${formatClockUtc(lane.started_at)}`}
            {verdict === undefined
              ? ''
              : ` · verdict ${verdict.status} · ${verdict.reason} · ${formatClockUtc(verdict.timestamp)}`}
            {verdict?.hitl_override === true ? ' · human override' : ''}
          </p>

          <h3 className="drawer-section">Debate · stances × influence</h3>
          <DebateSection debate={debate} lane={lane} />

          {/*
            The reserved invalidation section (spec, "Information Inventory":
            required, not optional, and not yet buildable). `invalidation_log`
            does not exist in the codebase — the stage is specced and not
            built — so this names the reason rather than rendering nothing or
            inventing a field. Reserving the slot now means the layout does
            not move the day the data arrives.
          */}
          <h3 className="drawer-section">Invalidation</h3>
          <p className="empty-state" data-section="invalidation">
            Reserved — the invalidation stage is specced and not built (devils-advocate-spec.md).
            When it ships this section carries the restated thesis, its conditions with evaluation
            states, and the validator-dropped conditions with their drop reasons — with{' '}
            <code>no_conditions</code> and <code>unavailable</code> rendered as distinct states.
            Note that a Risk reject is inferable from a breached condition but is never recorded
            (#328), so this section will not claim it.
          </p>

          <p className="drawer-caveat">
            Trader and Risk persist no decision content anywhere (#328) — their rows report that the
            stage ran, and nothing about what it decided. Duration shown as {UNKNOWN} means the
            store recorded none.
          </p>
        </>
      )}
    </section>
  );
}
