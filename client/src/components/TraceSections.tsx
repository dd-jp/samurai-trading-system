/**
 * The sections both drawers are built from: a trace's stage timeline, its
 * Risk gates and invalidation conditions, its debate record, and its fills.
 *
 * Every empty state names its reason. The wire is honest about what the
 * store never kept — no decision word for Trader and Risk (#328), no
 * round-by-round debate state (decision #10) — and the page repeats that
 * rather than papering over it with a dash.
 */
import type { DebateRow, FillRow, RiskCriticRow, VerdictRow } from '@contracts';
import { debateDegradedGloss } from '../lib/debate-termination.ts';
import {
  formatClockUtc,
  formatFixed,
  formatPrice,
  formatQty,
  formatStageDuration,
} from '../lib/format.ts';
import type { ResolvedCell } from '../lib/lane-cells.ts';
import type { DebateJoin, RiskCriticJoin } from '../lib/resolve-trace.ts';
import {
  presentCondition,
  presentCriticVerdict,
  presentVerdictStatus,
} from '../lib/state-presentation.ts';
import { CONTROL_NO_CRITIC, CONTROL_NO_DEBATE, stageName } from '../lib/vocabulary.ts';
import { StanceStrip } from './StanceStrip.tsx';
import { StateWord } from './StateWord.tsx';

export function Timeline({ cells }: { cells: readonly ResolvedCell[] }) {
  return (
    <ol className="timeline" aria-label="Stage timeline">
      {cells.map((cell) => {
        if (!cell.present) {
          return (
            <li key={cell.stage} className="timeline-row" data-stage={cell.stage}>
              <span className="timeline-stage">{stageName(cell.stage)}</span>
              <span className="muted">no cell for this stage on the wire</span>
            </li>
          );
        }
        return (
          <li
            key={cell.stage}
            className="timeline-row"
            data-stage={cell.stage}
            // Set only when it applies, so a test (and a stylesheet) can select
            // the degraded rows without matching every healthy one (#1080).
            data-degraded={cell.degraded ? 'true' : undefined}
          >
            <span className="timeline-stage">
              {stageName(cell.stage)}
              <StateWord state={cell.state} />
            </span>
            <span className="timeline-decision">
              {cell.decisionText}
              {cell.attempts > 1 ? ` · ${cell.attempts} attempts` : ''}
            </span>
            <span className="timeline-duration mono muted">
              {cell.recordedAt !== null ? `${formatClockUtc(cell.recordedAt)} · ` : ''}
              {formatStageDuration(cell.durationMs)}
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

/**
 * `isControl` overrides the whole reading, not just a fallback (#1597): the
 * control arm calls no model and so consults no critic — `critic_verdict` is
 * `null` on its own rows for that structural reason, not because a live-only
 * critic was skipped this one time, and the two must not share a sentence.
 * The binding constraint and conditions above this line still render
 * normally — the control's own Risk decision happened and is not absent
 * (dashboard-spec.md's #1594 amendment) — only the critic verdict is N/A.
 */
function criticVerdictText(row: RiskCriticRow, isControl: boolean): string {
  if (isControl) return CONTROL_NO_CRITIC;
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
  /** How the row was found — the empty state names the key that found nothing. */
  keyedBy: RiskCriticJoin;
  /** The control arm consults no critic — see `criticVerdictText`'s doc comment. */
  isControl: boolean;
}

export function GatesSection({ riskCritic, verdict, keyedBy, isControl }: GatesSectionProps) {
  return (
    <div data-section="gates">
      {verdict !== undefined && (
        <p className="gate-line" data-verdict={verdict.status}>
          <StateWord state={presentVerdictStatus(verdict.status)} />
          <span>
            {verdict.reason} · {formatClockUtc(verdict.timestamp)}
            {verdict.hitl_override ? ' · human override' : ''}
          </span>
        </p>
      )}
      {riskCritic === undefined ? (
        <p className="empty-state" data-invalidation="no-decision">
          {keyedBy.by === 'trace_id'
            ? "No Risk decision for this trace in the snapshot's recent-decisions window — a tick that never reached Risk records none, and older ones age out of the list."
            : "No Risk decision keyed to this trade's debate in the snapshot's recent-decisions window."}
        </p>
      ) : (
        <RiskCriticBody riskCritic={riskCritic} isControl={isControl} />
      )}
    </div>
  );
}

function RiskCriticBody({
  riskCritic,
  isControl,
}: {
  riskCritic: RiskCriticRow;
  isControl: boolean;
}) {
  const conditions = riskCritic.conditions ?? [];
  const dropped = riskCritic.dropped_conditions ?? [];
  return (
    <>
      <p
        className="gate-line"
        data-invalidation="binding"
        data-binding={riskCritic.binding_constraint ?? 'none'}
      >
        <StateWord
          state={{
            word: riskCritic.binding_constraint === null ? 'gates' : 'bound',
            tone: riskCritic.binding_constraint === null ? 'done' : 'stop',
          }}
        />
        <span>{bindingConstraintText(riskCritic.binding_constraint)}</span>
      </p>
      <p className="gate-line" data-critic={riskCritic.critic_verdict ?? 'none'}>
        <StateWord state={presentCriticVerdict(riskCritic.critic_verdict)} />
        <span>{criticVerdictText(riskCritic, isControl)}</span>
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
              <StateWord state={presentCondition(condition.state)} title={condition.rationale} />
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
              <StateWord state={{ word: 'dropped', tone: 'skip' }} />
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
  linkedBy: DebateJoin;
  /** The control arm trades by indicator alone and never runs a debate (#1597). */
  isControl: boolean;
}

export function DebateSection({ debate, inFlight, linkedBy, isControl }: DebateSectionProps) {
  if (debate === undefined) {
    return (
      <p className="empty-state" data-section="debate">
        {isControl
          ? CONTROL_NO_DEBATE
          : inFlight
            ? 'This tick is in flight — round-by-round state is not persisted (decision #10), so there is nothing to show until the debate completes.'
            : 'No completed debate recorded for this instrument in the recent-debates window.'}
      </p>
    );
  }
  const gloss = debateDegradedGloss(debate);
  return (
    <div data-section="debate">
      <p className="drawer-line" data-degraded={gloss === null ? undefined : 'true'}>
        <b>{debate.direction}</b> · {debate.rounds} rounds · opened{' '}
        {formatClockUtc(debate.created_at)}
        {gloss === null ? null : <span className="muted"> · {gloss}</span>}
        {linkedBy.exact ? null : (
          <span className="muted">
            {' '}
            · the instrument's latest completed debate, not keyed to this trace
          </span>
        )}
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
