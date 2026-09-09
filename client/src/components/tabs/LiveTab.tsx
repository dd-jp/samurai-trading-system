import {
  type DebateRow,
  type FillRow,
  PIPELINE_STAGES,
  type PipelineLane,
  type PositionRow,
} from '@contracts';
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
import {
  formatClockUtc,
  formatPrice,
  formatQty,
  formatStageDuration,
  formatUsd,
} from '../../lib/format.ts';
import { type ResolvedCell, resolveLaneCells } from '../../lib/lane-cells.ts';
import { settledOutcome } from '../../lib/ledger.ts';
import {
  laneDebate,
  resolveTrace,
  type Selection,
  type TraceDetail,
} from '../../lib/resolve-trace.ts';
import {
  OUTCOME_WORD,
  sideWord,
  stageName,
  WAITING_FOR_FIRST_SNAPSHOT,
} from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { StateWord } from '../StateWord.tsx';
import { DebateSection, FillsList, GatesSection, Timeline } from '../TraceSections.tsx';

export interface LiveTabProps {
  snapshot: WireSnapshot | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}

/**
 * The button's own accessible name, since `aria-label` here overrides the
 * inner text for assistive tech — a degraded cell has to be named here or it
 * is not reachable by anything but sighted, mouse-driven inspection.
 */
function laneName(lane: PipelineLane, cells: readonly ResolvedCell[]): string {
  const where =
    lane.final_stage === null
      ? lane.outcome === 'idle'
        ? 'no trace in the window'
        : 'no stage recorded'
      : `at ${stageName(lane.final_stage)}`;
  const degradedCount = cells.filter((cell) => cell.degraded).length;
  const degraded = degradedCount === 0 ? '' : `, ${degradedCount} stage(s) degraded`;
  return `${lane.instrument}, ${lane.asset_class}, ${OUTCOME_WORD[lane.outcome]}, ${where}${degraded}`;
}

function LaneRow(props: {
  lane: PipelineLane;
  /** The lane's debate row, for the degraded `debate` cell's cause (#1428). */
  debate: DebateRow | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { lane, debate, selected, onSelect } = props;
  const settled = settledOutcome(lane.outcome);
  const cells = resolveLaneCells(lane, debate);
  return (
    <li>
      <button
        type="button"
        className={`lane lane-${lane.outcome}${selected ? ' lane-selected' : ''}`}
        data-instrument={lane.instrument}
        data-outcome={lane.outcome}
        aria-label={laneName(lane, cells)}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="lane-head">
          {settled !== null && <Seal outcome={settled} />}
          <b className="display lane-instrument">{lane.instrument}</b>
        </span>
        {cells.map((cell) => (
          <span
            key={cell.stage}
            className="lane-cell"
            data-stage={cell.stage}
            // Same hook the drawer timeline sets (#1080, #1142) — a degraded
            // decision must read differently on the surface an operator
            // scans first, not only once they open the trace.
            data-degraded={cell.degraded ? 'true' : undefined}
          >
            <StateWord state={cell.state} />
            {cell.hasRecordedDecision && (
              // The cell shows its decision WORD (dashboard-spec.md:135), not
              // the full gloss — a gloss sentence overflows this column
              // (`.lane-decision`'s ellipsis truncation clipped it, review
              // fix-round-1 F1). The gloss is one hover away via `title`; the
              // glyph is the non-colour carrier the dashboard's accessibility
              // floor requires alongside the amber tint.
              <span className="lane-decision" title={cell.decisionText}>
                {cell.degraded && (
                  <span className="lane-degraded-mark" role="img" aria-label="degraded">
                    ⚠
                  </span>
                )}
                {cell.decisionWord}
              </span>
            )}
          </span>
        ))}
      </button>
    </li>
  );
}

function LaneList(props: LiveTabProps) {
  const { snapshot, selection, onSelect } = props;
  const lanes = snapshot?.pipeline.lanes ?? [];
  const debates = snapshot?.debates ?? [];
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
              debate={laneDebate(debates, lane)}
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

const NO_LANE_LINE: Readonly<Record<NonNullable<TraceDetail['absence']['lane']>, string>> = {
  none: 'no lane on this snapshot for this instrument',
  aged_out:
    'this trace has aged out of the 15-minute pipeline window — the verdict row is what remains',
  idle: 'idle — no trace in the last 15 minutes',
  wrong_instrument:
    'this trace belongs to another instrument — the selection is mismatched, not aged out',
};

function whereLine({ lane, absence }: TraceDetail): string {
  if (absence.lane !== null || lane === undefined) return NO_LANE_LINE[absence.lane ?? 'none'];
  return `${lane.asset_class}${
    lane.started_at === null ? '' : ` · started ${formatClockUtc(lane.started_at)}`
  }${lane.total_ms === null ? '' : ` · ${formatStageDuration(lane.total_ms)} total`}`;
}

function OrderSection({ position, fills }: { position: PositionRow; fills: readonly FillRow[] }) {
  return (
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
  const detail = resolveTrace(snapshot, selection);
  const { lane, traceId, settled } = detail;
  return (
    <aside className="drawer" aria-label="Trace detail" data-trace-id={traceId ?? ''}>
      <div className="drawer-head">
        {settled !== null && <Seal outcome={settled} />}
        <h2 className="display">{detail.instrument}</h2>
        {lane !== undefined && (
          <b className={`outcome-${lane.outcome}`}>{OUTCOME_WORD[lane.outcome]}</b>
        )}
        <span className="mono muted drawer-trace">{traceId === null ? 'no trace' : traceId}</span>
      </div>
      <p className="drawer-line muted">{whereLine(detail)}</p>

      <h3>Timeline</h3>
      {detail.cells !== null ? (
        <Timeline cells={detail.cells} />
      ) : (
        <p className="empty-state">No stage record — there is no trace to draw a timeline from.</p>
      )}
      <p className="drawer-caveat">
        Trader and Risk carry no decision word (#328) — they report that the stage ran.
      </p>

      <h3>Gates and conditions</h3>
      <GatesSection
        riskCritic={detail.riskCritic}
        verdict={detail.verdict}
        keyedBy={detail.riskCriticJoin}
      />

      <h3>Debate</h3>
      <DebateSection
        debate={detail.debate}
        inFlight={detail.inFlight}
        linkedBy={detail.debateJoin}
      />

      <h3>Order and fills</h3>
      {detail.position === undefined ? (
        <p className="empty-state">
          No open position for this instrument — nothing was filled, or the round trip has already
          closed and lives on Review.
        </p>
      ) : (
        <OrderSection position={detail.position} fills={detail.fills} />
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
