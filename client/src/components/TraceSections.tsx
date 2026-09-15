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
import { stageName } from '../lib/vocabulary.ts';
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
              <span className="muted">no cell on the wire</span>
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
  if (constraint === null) return 'no binding constraint — no gate named one';
  if (constraint === 'risk_critic:invalidated') {
    return `${constraint} — measured breach of a condition below`;
  }
  if (constraint === 'risk_critic:reject') {
    return `${constraint} — critic's prose verdict, no measured breach`;
  }
  return constraint;
}

function criticVerdictText(row: RiskCriticRow): string {
  if (row.critic_verdict === null) {
    return 'no critic verdict — skipped, or no linked debate';
  }
  if (row.critic_verdict === 'unavailable') {
    return 'critic could not answer — mechanical checks alone decided';
  }
  return row.reasoning === null ? `critic ${row.critic_verdict}` : row.reasoning;
}

export interface GatesSectionProps {
  riskCritic: RiskCriticRow | undefined;
  verdict: VerdictRow | undefined;
  /** How the row was found — the empty state names the key that found nothing. */
  keyedBy: RiskCriticJoin;
}

export function GatesSection({ riskCritic, verdict, keyedBy }: GatesSectionProps) {
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
            ? 'No Risk decision for this trace in the recent-decisions window — never reached Risk, or aged out.'
            : "No Risk decision keyed to this trade's debate in the recent-decisions window."}
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
        <span>{criticVerdictText(riskCritic)}</span>
      </p>
      {conditions.length === 0 ? (
        <p
          className="empty-state"
          data-invalidation="no-conditions"
          title="One state for four causes: none emitted, every one dropped, an unreadable column, or a row written before the fold."
        >
          <code>no_conditions</code> — nothing checkable; the prose verdict stands alone.
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
}

export function DebateSection({ debate, inFlight, linkedBy }: DebateSectionProps) {
  if (debate === undefined) {
    return (
      <p className="empty-state" data-section="debate">
        {inFlight
          ? 'Tick in flight — rounds are not persisted (decision #10); shown once the debate completes.'
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
          <span className="muted"> · latest for instrument, not keyed to this trace</span>
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
            <span className="stance-final">{contribution.final_position}</span>
            <span className="stance-influence mono">
              influence {formatFixed(contribution.influence_score, 2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="drawer-caveat">Arguments are not persisted (decision #10).</p>
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
        <li key={fill.broker_fill_id} className="fill-row">
          <span className="muted">{formatClockUtc(fill.timestamp)}</span>
          <span>{fill.leg}</span>
          <span className="fill-price">
            {formatQty(fill.qty)} @ {formatPrice(fill.price)}
          </span>
          <span className="fill-fee muted">
            {fill.fee !== 0 ? `fee ${formatPrice(fill.fee)}` : ''}
          </span>
          <span className="fill-id muted" title={fill.broker_fill_id}>
            {fill.broker_fill_id}
          </span>
        </li>
      ))}
    </ul>
  );
}
