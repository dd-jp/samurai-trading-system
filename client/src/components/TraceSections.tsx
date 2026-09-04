/**
 * The sections both drawers are built from: a trace's stage timeline, its
 * Risk gates and invalidation conditions, its debate record, and its fills.
 *
 * Every empty state names its reason. The wire is honest about what the
 * store never kept — no decision word for Trader and Risk (#328), no
 * round-by-round debate state (decision #10) — and the page repeats that
 * rather than papering over it with a dash.
 */
import {
  type DebateRow,
  type FillRow,
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineLane,
  type PipelineStage,
  type RiskCriticRow,
  type VerdictRow,
} from '@contracts';
import {
  formatClockUtc,
  formatFixed,
  formatPrice,
  formatQty,
  formatStageDuration,
} from '../lib/format.ts';
import { cellsByStageOf, decisionOf } from '../lib/trace.ts';
import {
  CONDITION_STATE_WORD,
  cellStateWord,
  criticVerdictWord,
  stageName,
} from '../lib/vocabulary.ts';
import { StanceStrip } from './StanceStrip.tsx';
import { cellTone, conditionTone, criticTone, StateWord } from './StateWord.tsx';

const STAGES_WITHOUT_RECORDED_DECISION: readonly PipelineStage[] = ['trader', 'risk'];

function decisionText(cell: PipelineCell): string {
  const decision = decisionOf(cell);
  if (decision !== null) return decision;
  if (cell.state === 'not_reached') return 'not reached';
  if (cell.state === 'skipped') return 'skipped — the tick continued';
  if (cell.state === 'live') return 'in progress';
  if (STAGES_WITHOUT_RECORDED_DECISION.includes(cell.stage)) {
    return 'no decision word recorded (#328)';
  }
  return 'no decision recorded';
}

export function Timeline({ lane }: { lane: PipelineLane }) {
  const cellsByStage = cellsByStageOf(lane);
  return (
    <ol className="timeline" aria-label="Stage timeline">
      {PIPELINE_STAGES.map((stage) => {
        const cell = cellsByStage.get(stage);
        if (cell === undefined) {
          return (
            <li key={stage} className="timeline-row" data-stage={stage}>
              <span className="timeline-stage">{stageName(stage)}</span>
              <span className="muted">no cell for this stage on the wire</span>
            </li>
          );
        }
        return (
          <li key={stage} className="timeline-row" data-stage={stage} data-state={cell.state}>
            <span className="timeline-stage">
              {stageName(stage)}
              <StateWord tone={cellTone(cell.state)}>
                {cellStateWord(cell.state, lane.outcome)}
              </StateWord>
            </span>
            <span className="timeline-decision">
              {decisionText(cell)}
              {cell.attempts > 1 ? ` · ${cell.attempts} attempts` : ''}
            </span>
            <span className="timeline-duration mono muted">
              {cell.recorded_at !== null ? `${formatClockUtc(cell.recorded_at)} · ` : ''}
              {formatStageDuration(cell.duration_ms)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function bindingConstraintText(constraint: string | null): string {
  if (constraint === null) return 'no binding constraint recorded — no gate named one';
  if (constraint === 'risk_critic:invalidated') {
    return `bound by ${constraint} — Risk rejected on a MEASURED breach of a condition below, not on the critic's argument`;
  }
  if (constraint === 'risk_critic:reject') {
    return `bound by ${constraint} — Risk rejected on the critic's PROSE verdict; no measured breach decided it`;
  }
  return `bound by ${constraint}`;
}

function criticVerdictText(row: RiskCriticRow): string {
  if (row.critic_verdict === null) {
    return 'no critic verdict recorded — the critic was skipped, or this decision links to no debate';
  }
  if (row.critic_verdict === 'unavailable') {
    return 'critic unavailable — consulted and could not answer, so the mechanical checks alone decided this';
  }
  return row.reasoning === null ? `critic ${row.critic_verdict}` : row.reasoning;
}

export interface GatesSectionProps {
  riskCritic: RiskCriticRow | undefined;
  verdict: VerdictRow | undefined;
  /** What the empty state says the row was looked up by. */
  keyedBy: 'trace' | 'debate';
}

export function GatesSection({ riskCritic, verdict, keyedBy }: GatesSectionProps) {
  return (
    <div data-section="gates">
      {verdict !== undefined && (
        <p className="gate-line" data-verdict={verdict.status}>
          <StateWord tone={verdict.status === 'go' ? 'done' : 'stop'}>
            {verdict.status === 'go' ? 'go' : 'no-go'}
          </StateWord>
          <span>
            {verdict.reason} · {formatClockUtc(verdict.timestamp)}
            {verdict.hitl_override ? ' · human override' : ''}
          </span>
        </p>
      )}
      {riskCritic === undefined ? (
        <p className="empty-state" data-invalidation="no-decision">
          {keyedBy === 'trace'
            ? "No Risk decision for this trace in the snapshot's recent-decisions window — a tick that never reached Risk records none, and older ones age out of the list."
            : "No Risk decision keyed to this trade's debate in the snapshot's recent-decisions window."}
        </p>
      ) : (
        <RiskCriticBody riskCritic={riskCritic} />
      )}
    </div>
  );
}

function RiskCriticBody({ riskCritic }: { riskCritic: RiskCriticRow }) {
  const conditions = riskCritic.conditions ?? [];
  const dropped = riskCritic.dropped_conditions ?? [];
  return (
    <>
      <p
        className="gate-line"
        data-invalidation="binding"
        data-binding={riskCritic.binding_constraint ?? 'none'}
      >
        <StateWord tone={riskCritic.binding_constraint === null ? 'done' : 'stop'}>
          {riskCritic.binding_constraint === null ? 'gates' : 'bound'}
        </StateWord>
        <span>{bindingConstraintText(riskCritic.binding_constraint)}</span>
      </p>
      <p className="gate-line" data-critic={riskCritic.critic_verdict ?? 'none'}>
        <StateWord tone={criticTone(riskCritic.critic_verdict)}>
          {criticVerdictWord(riskCritic.critic_verdict)}
        </StateWord>
        <span>{criticVerdictText(riskCritic)}</span>
      </p>
      {conditions.length === 0 ? (
        <p className="empty-state" data-invalidation="no-conditions">
          <code>no_conditions</code> — nothing checkable came out of this pass, so the conditions
          enforced nothing and the prose verdict stands on its own. One state for all four causes:
          none emitted, every one dropped, an unreadable column, and a row written before the fold.
        </p>
      ) : (
        <ul className="condition-list">
          {conditions.map((condition) => (
            <li
              key={condition.id}
              className="gate-line"
              data-condition={condition.id}
              data-condition-state={condition.state}
            >
              <StateWord tone={conditionTone(condition.state)} title={condition.rationale}>
                {CONDITION_STATE_WORD[condition.state]}
              </StateWord>
              <span>
                {condition.observable} {condition.comparator} {condition.threshold}
                <span className="muted mono">
                  {' '}
                  · observed {condition.observed === null ? 'not read' : condition.observed}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dropped.length > 0 && (
        <ul className="condition-list condition-dropped">
          {dropped.map((drop) => (
            <li key={`${drop.id ?? 'no-id'}:${drop.raw}`} data-drop-reason={drop.reason}>
              <StateWord tone="skip">dropped</StateWord>
              <span>
                {drop.reason} <span className="muted">· {drop.raw}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface DebateSectionProps {
  debate: DebateRow | undefined;
  /** `true` while the selected lane is still running — changes the empty state. */
  inFlight: boolean;
  /** Whether the debate was found by exact `debate_id` or by instrument only. */
  linkedBy: 'debate_id' | 'instrument';
}

export function DebateSection({ debate, inFlight, linkedBy }: DebateSectionProps) {
  if (debate === undefined) {
    return (
      <p className="empty-state" data-section="debate">
        {inFlight
          ? 'This tick is in flight — round-by-round state is not persisted (decision #10), so there is nothing to show until the debate completes.'
          : 'No completed debate recorded for this instrument in the recent-debates window.'}
      </p>
    );
  }
  return (
    <div data-section="debate">
      <p className="drawer-line">
        <b>{debate.direction}</b> · {debate.rounds} rounds · opened{' '}
        {formatClockUtc(debate.created_at)}
        {linkedBy === 'instrument' ? (
          <span className="muted">
            {' '}
            · the instrument's latest completed debate, not keyed to this trace
          </span>
        ) : null}
      </p>
      <ul className="stance-list">
        {debate.contributions.map((contribution) => (
          <li key={contribution.analyst_id} className="stance-row">
            <span className="stance-name">{contribution.analyst_id}</span>
            <StanceStrip
              stances={contribution.stance_during_debate}
              finalPosition={contribution.final_position}
            />
            <span className="stance-final">final {contribution.final_position}</span>
            <span className="stance-influence mono">
              influence {formatFixed(contribution.influence_score, 2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="drawer-caveat">
        Arguments are not persisted (decision #10) — stances by round and final influence are what
        the store keeps of a debate.
      </p>
    </div>
  );
}

export function FillsList({ fills }: { fills: readonly FillRow[] }) {
  if (fills.length === 0) {
    return <p className="empty-state">No fill recorded against this order key on the snapshot.</p>;
  }
  return (
    <ul className="fill-list mono" aria-label="Fills">
      {fills.map((fill) => (
        <li key={fill.broker_fill_id}>
          {formatClockUtc(fill.timestamp)} · {fill.leg} · {formatQty(fill.qty)} @{' '}
          {formatPrice(fill.price)}
          {fill.fee !== 0 ? ` · fee ${formatPrice(fill.fee)}` : ''}{' '}
          <span className="muted">{fill.broker_fill_id}</span>
        </li>
      ))}
    </ul>
  );
}
