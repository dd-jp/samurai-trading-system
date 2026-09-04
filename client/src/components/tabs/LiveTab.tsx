import { PIPELINE_STAGES, type PipelineLane } from '@contracts';
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
import {
  formatClockUtc,
  formatPrice,
  formatQty,
  formatStageDuration,
  formatUsd,
} from '../../lib/format.ts';
import { settledOutcome } from '../../lib/ledger.ts';
import {
  cellsByStageOf,
  decisionOf,
  fillsFor,
  laneFor,
  latestDebateFor,
  openPositionFor,
  riskCriticFor,
  verdictFor,
} from '../../lib/trace.ts';
import {
  cellStateWord,
  OUTCOME_WORD,
  sideWord,
  stageName,
  WAITING_FOR_FIRST_SNAPSHOT,
} from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { cellTone, StateWord } from '../StateWord.tsx';
import { DebateSection, FillsList, GatesSection, Timeline } from '../TraceSections.tsx';

export interface Selection {
  instrument: string;
  /** `null` selects the instrument's current lane; a trace id pins one trace. */
  traceId: string | null;
}

export interface LiveTabProps {
  snapshot: WireSnapshot | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}

function laneName(lane: PipelineLane): string {
  const where =
    lane.final_stage === null
      ? lane.outcome === 'idle'
        ? 'no trace in the window'
        : 'no stage recorded'
      : `at ${stageName(lane.final_stage)}`;
  return `${lane.instrument}, ${lane.asset_class}, ${OUTCOME_WORD[lane.outcome]}, ${where}`;
}

function LaneRow(props: { lane: PipelineLane; selected: boolean; onSelect: () => void }) {
  const { lane, selected, onSelect } = props;
  const cellsByStage = cellsByStageOf(lane);
  const settled = settledOutcome(lane.outcome);
  return (
    <li>
      <button
        type="button"
        className={`lane lane-${lane.outcome}${selected ? ' lane-selected' : ''}`}
        data-instrument={lane.instrument}
        data-outcome={lane.outcome}
        aria-label={laneName(lane)}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="lane-head">
          {settled !== null && <Seal outcome={settled} />}
          <b className="display lane-instrument">{lane.instrument}</b>
        </span>
        {PIPELINE_STAGES.map((stage) => {
          const cell = cellsByStage.get(stage);
          if (cell === undefined) {
            return (
              <span key={stage} className="lane-cell" data-stage={stage}>
                <StateWord tone="wait">no cell</StateWord>
              </span>
            );
          }
          const decision = decisionOf(cell);
          return (
            <span key={stage} className="lane-cell" data-stage={stage} data-state={cell.state}>
              <StateWord tone={cellTone(cell.state)}>
                {cellStateWord(cell.state, lane.outcome)}
              </StateWord>
              {decision !== null && <span className="lane-decision">{decision}</span>}
            </span>
          );
        })}
      </button>
    </li>
  );
}

function LaneList(props: LiveTabProps) {
  const { snapshot, selection, onSelect } = props;
  const lanes = snapshot?.pipeline.lanes ?? [];
  const running = lanes.filter((lane) => lane.outcome === 'in_flight').length;
  return (
    <section className="lanes" aria-label="Lanes">
      <div className="section-head">
        <h2>Lanes</h2>
        <span className="muted small">
          {snapshot === null
            ? WAITING_FOR_FIRST_SNAPSHOT
            : `${lanes.length} in the 15-minute window · ${running} running`}
        </span>
      </div>
      <div className="lane lane-header" aria-hidden="true">
        <span />
        {PIPELINE_STAGES.map((stage) => (
          <span key={stage} className="label">
            {stageName(stage)}
          </span>
        ))}
      </div>
      {snapshot !== null && lanes.length === 0 ? (
        <p className="empty-state">
          No lane on this snapshot — no instrument has a trace inside the 15-minute window and none
          is configured idle. An empty universe reads as empty, not as quiet.
        </p>
      ) : (
        <ul className="lane-list">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.instrument}
              lane={lane}
              selected={
                selection !== null &&
                selection.instrument === lane.instrument &&
                (selection.traceId === null || selection.traceId === lane.trace_id)
              }
              onSelect={() => onSelect({ instrument: lane.instrument, traceId: null })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TraceDrawer(props: LiveTabProps) {
  const { snapshot, selection } = props;
  if (snapshot === null || selection === null) {
    return (
      <aside className="drawer" aria-label="Trace detail">
        <p className="empty-state">
          {snapshot === null
            ? WAITING_FOR_FIRST_SNAPSHOT
            : 'No lane selected — choose a lane, or a verdict row on Glance, to see its trace.'}
        </p>
      </aside>
    );
  }
  const lane = laneFor(snapshot.pipeline, selection.instrument, selection.traceId);
  const traceId = selection.traceId ?? lane?.trace_id ?? null;
  const verdict = verdictFor(snapshot.verdicts, traceId);
  const riskCritic = riskCriticFor(snapshot.risk_critics ?? [], traceId, selection.instrument);
  const debate = latestDebateFor(snapshot.debates, selection.instrument);
  const position = openPositionFor(snapshot.positions, selection.instrument);
  const fills = position === undefined ? [] : fillsFor(snapshot.fills, position.idempotency_key);
  const settled = lane === undefined ? null : settledOutcome(lane.outcome);
  return (
    <aside className="drawer" aria-label="Trace detail" data-trace-id={traceId ?? ''}>
      <div className="drawer-head">
        {settled !== null && <Seal outcome={settled} />}
        <h2 className="display">{selection.instrument}</h2>
        {lane !== undefined && (
          <b className={`outcome-${lane.outcome}`}>{OUTCOME_WORD[lane.outcome]}</b>
        )}
        <span className="mono muted drawer-trace">{traceId === null ? 'no trace' : traceId}</span>
      </div>
      <p className="drawer-line muted">
        {lane === undefined
          ? traceId === null
            ? 'no lane on this snapshot for this instrument'
            : 'this trace has aged out of the 15-minute pipeline window — the verdict row is what remains'
          : lane.trace_id === null
            ? 'idle — no trace in the last 15 minutes'
            : `${lane.asset_class}${
                lane.started_at === null ? '' : ` · started ${formatClockUtc(lane.started_at)}`
              }${lane.total_ms === null ? '' : ` · ${formatStageDuration(lane.total_ms)} total`}`}
      </p>

      <h3>Timeline</h3>
      {lane !== undefined && lane.trace_id !== null ? (
        <Timeline lane={lane} />
      ) : (
        <p className="empty-state">No stage record — there is no trace to draw a timeline from.</p>
      )}
      <p className="drawer-caveat">
        Trader and Risk carry no decision word (#328) — they report that the stage ran.
      </p>

      <h3>Gates and conditions</h3>
      <GatesSection riskCritic={riskCritic} verdict={verdict} keyedBy="trace" />

      <h3>Debate</h3>
      <DebateSection
        debate={debate}
        inFlight={lane?.outcome === 'in_flight'}
        linkedBy="instrument"
      />

      <h3>Order and fills</h3>
      {position === undefined ? (
        <p className="empty-state">
          No open position for this instrument — nothing was filled, or the round trip has already
          closed and lives on Review.
        </p>
      ) : (
        <div data-section="order">
          <p className="drawer-line mono">
            {sideWord(position.side)} {formatQty(position.filled_size)} @{' '}
            {formatPrice(position.avg_entry_price)} · stop {formatPrice(position.stop)} · target{' '}
            {formatPrice(position.target)} · {position.order_state}
          </p>
          <p className="drawer-line mono muted">
            opened {formatClockUtc(position.opened_at)} · mark {formatPrice(position.mark_price)} ·{' '}
            {formatUsd(position.unrealized_pnl)} unrealized · key {position.idempotency_key}
          </p>
          <FillsList fills={fills} />
        </div>
      )}
    </aside>
  );
}

export function LiveTab(props: LiveTabProps) {
  return (
    <div className="live">
      <LaneList {...props} />
      <TraceDrawer {...props} />
    </div>
  );
}
