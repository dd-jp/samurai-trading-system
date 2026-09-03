/**
 * The detail drawer (dashboard-spec.md, "Verdict ledger + detail drawer"). A
 * chip or a ledger row opens it; it carries the stage strip, the debate's
 * stances x influence, the invalidation section and the trace id.
 *
 * **The stage strip is the sole per-stage record.** A sigil chip is a single
 * point, so a skipped stage and a retried stage have no room to show
 * themselves in the hero (spec, "The primitive's accepted cost"). The strip
 * therefore lists all six stages including the never-reached ones, with
 * state word, decision, duration, attempts and recorded time.
 *
 * **Every empty state names its reason.** Never a bare dash, never a spinner
 * that cannot resolve: "the Trader and Risk cells carry no decision word (#328)",
 * "round-by-round state is not persisted (decision #10)", "no trace in the
 * last 15 minutes".
 */

import type {
  DebateRow,
  EvaluatedConditionWire,
  PipelineCell,
  PipelineLane,
  PipelineStage,
  RiskCriticRow,
  VerdictRow,
} from '@contracts';
import { formatClockUtc, formatFixed, formatStageDuration, UNKNOWN } from '../lib/format.ts';
import { ROOM_ORDER } from '../lib/room-layout.ts';
import { CELL_STATE_WORD, OUTCOME_WORD, stageName } from '../lib/vocabulary.ts';
import { StanceStrip } from './StanceStrip.tsx';

/**
 * The six stages, in pipeline order, taken from `ROOM_ORDER` rather than
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
  /**
   * The trace being shown, which OUTLIVES its lane (#606 item 5). A ledger row
   * keeps its entry for the session while the pipeline view only reaches back
   * 15 minutes, so a row can name a trace that has no lane left — and the
   * drawer must report that trace rather than fall silent or, worse, describe
   * the instrument's newer one.
   */
  traceId: string | null;
  lane: PipelineLane | undefined;
  debate: DebateRow | undefined;
  verdict: VerdictRow | undefined;
  /**
   * The Risk decision for THIS trace, with its critic verdict and invalidation
   * conditions (#1066). Resolved by `App` on `(trace_id, instrument)` — the
   * pair `risk_log` is keyed by — never by the debate, which the drawer
   * resolves by instrument and which a retried tick shares across traces.
   */
  riskCritic: RiskCriticRow | undefined;
}

/**
 * Stages whose decision word `audit_log` does not carry: it holds a digest,
 * not the stage's decision, so the strip has nothing to print for these two.
 * `risk_log` does record the Risk binding constraint, and the invalidation
 * section below reads it; the strip's own column is owned by #328.
 */
const STAGES_WITHOUT_RECORDED_DECISION: readonly PipelineStage[] = ['trader', 'risk'];

/**
 * The decision column, which is never blank. A `null` decision has four
 * different meanings and each one is spelled out, because "—" for all four
 * would hide the only interesting one (#328).
 */
function decisionText(cell: PipelineCell): string {
  if (cell.decision !== null && cell.decision !== '') return cell.decision;
  if (cell.state === 'not_reached') return 'not reached';
  if (cell.state === 'skipped') return 'skipped — the tick continued';
  // `live` is checked BEFORE the stages with no recorded decision word: a
  // live Trader cell has no decision yet because it is still running, and
  // blaming the schema for that would misread a stage that simply has not
  // finished.
  if (cell.state === 'live') return 'in progress';
  if (STAGES_WITHOUT_RECORDED_DECISION.includes(cell.stage))
    return 'no decision word recorded (#328)';
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

/** The tri-state, in words. `not_breached` reads as two words; the wire keeps the tag. */
const CONDITION_STATE_WORD: Record<EvaluatedConditionWire['state'], string> = {
  breached: 'breached',
  not_breached: 'not breached',
  unevaluable: 'unevaluable',
};

/**
 * What the gate that decided this entry was, in the operator's words.
 *
 * The two `risk_critic:` constraints are spelled out rather than printed
 * bare, because the whole reason #997 Q2b kept them distinct is that they mean
 * opposite things about the model: `invalidated` is deterministic code
 * measuring a predicate the critic named, `reject` is the critic's prose. A
 * row whose conditions all held under an `invalidated` constraint — or whose
 * conditions breached under a prose `pass` — is the disagreement this section
 * exists to make visible.
 */
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
    return 'no critic verdict recorded for this decision — the critic was skipped, or this trace links to no debate';
  }
  if (row.critic_verdict === 'unavailable') {
    return 'critic verdict unavailable — the critic was consulted and could not answer, so the mechanical checks alone decided this';
  }
  return `critic verdict ${row.critic_verdict}${row.reasoning === null ? '' : ` · ${row.reasoning}`}`;
}

/**
 * The invalidation section (#1066), filling the slot the spec reserved:
 * `RiskCriticVerdict.conditions` / `dropped_conditions` as #994's fold
 * persists them, read off `risk_critics` on the snapshot.
 *
 * Three empty states, all distinct and all named, because they are three
 * different facts: no Risk decision for this trace on this snapshot, a
 * decision whose critic never answered, and a decision whose conditions
 * enforced nothing (`no_conditions`). The last collapses four causes — none
 * emitted, all dropped, an unreadable column, and a row written before the
 * fold — into one state on purpose (#997 Q3), which is why a pre-fold row
 * needs no branch of its own here.
 */
function InvalidationSection({ riskCritic }: { riskCritic: RiskCriticRow | undefined }) {
  if (riskCritic === undefined) {
    return (
      <p className="empty-state" data-section="invalidation" data-invalidation="no-decision">
        No Risk decision for this trace in the snapshot's recent-decisions window. The ledger keeps
        a row for the whole session; this list does not reach as far back, and a tick that never
        reached Risk records no decision at all.
      </p>
    );
  }

  // Keyed by position, not by id: nothing in the validator forbids a model
  // from emitting two conditions under one id, and a duplicate key would drop
  // a row an operator is entitled to see. Position is stable within one
  // decision's fixed audit list.
  const conditions = (riskCritic.conditions ?? []).map((condition, index) => ({
    ...condition,
    key: String(index),
  }));
  // A dropped condition may carry no id at all (the emission was too malformed
  // to have one) and two drops of the same malformed text are two real
  // records, so neither the id nor the content identifies a row. Position in
  // the wire list does: this list is a fixed audit record of one decision, not
  // a reorderable collection.
  const droppedRows = (riskCritic.dropped_conditions ?? []).map((drop, index) => ({
    ...drop,
    key: String(index),
  }));

  return (
    <div data-section="invalidation">
      <p
        className="drawer-started"
        data-invalidation="binding"
        data-binding={riskCritic.binding_constraint ?? 'none'}
      >
        {bindingConstraintText(riskCritic.binding_constraint)}
      </p>
      <p className="drawer-started">{criticVerdictText(riskCritic)}</p>

      {conditions.length === 0 ? (
        <p className="empty-state" data-invalidation="no-conditions">
          <code>no_conditions</code> — nothing checkable came out of this pass, so the conditions
          enforced nothing and the prose verdict stands on its own. One state for all four causes:
          none emitted, every one dropped, an unreadable column, and a row written before the fold
          (which carries no conditions and never will).
        </p>
      ) : (
        <table className="stage-strip">
          <thead>
            <tr>
              <th scope="col">Condition</th>
              <th scope="col">Observable</th>
              <th scope="col">Falsifies if</th>
              <th scope="col" className="numeric">
                Observed
              </th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {conditions.map((condition) => (
              <tr
                key={condition.key}
                data-condition={condition.id}
                data-condition-state={condition.state}
              >
                <td title={condition.rationale}>{condition.id}</td>
                <td>{condition.observable}</td>
                <td>{`${condition.comparator} ${condition.threshold}`}</td>
                {/*
                  `observed` is null exactly when the read failed or returned
                  too little data. "not read" rather than a dash or a zero: a
                  zero is a measurement, and this is the absence of one.
                */}
                <td className="numeric">
                  {condition.observed === null ? 'not read' : String(condition.observed)}
                </td>
                <td>
                  <span className={`state-word condition-${condition.state}`}>
                    {CONDITION_STATE_WORD[condition.state]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        Shown INDEPENDENTLY of the list above, including beside
        `no_conditions`: "every condition was dropped" and "the model emitted
        none" report identically as one state, and the drop reasons are the
        only thing that tells them apart. A systematically malformed prompt
        hides for a month otherwise (user story 23).
      */}
      {droppedRows.length > 0 && (
        <ul className="stance-list">
          {droppedRows.map((drop) => (
            <li key={drop.key} className="stance-row" data-drop-reason={drop.reason}>
              <span className="stance-name">{drop.id ?? '<no id>'}</span>
              <span>dropped: {drop.reason}</span>
              <span className="muted">{drop.raw}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DetailDrawer(props: DetailDrawerProps) {
  const { instrument, traceId, lane, debate, verdict, riskCritic } = props;
  // The pinned trace wins over the lane's, and they only ever differ when the
  // lane is absent — `App` resolves the lane BY that trace when one is pinned.
  const shownTrace = traceId ?? lane?.trace_id ?? null;

  return (
    <section className="drawer-panel" aria-label="Instrument detail">
      <div className="panel-head">
        <h2>{instrument ?? 'Detail'}</h2>
        <span className="panel-sub">
          {instrument === null
            ? 'no instrument selected — choose a sigil chip or a ledger row'
            : lane === undefined
              ? shownTrace === null
                ? 'no lane on this snapshot for this instrument'
                : 'this trace has aged out of the 15-minute pipeline window'
              : `${lane.asset_class} · ${OUTCOME_WORD[lane.outcome]}${
                  lane.final_stage === null
                    ? ''
                    : ` at ${stageName(lane.final_stage).toLowerCase()}`
                }${lane.total_ms === null ? '' : ` · ${formatStageDuration(lane.total_ms)} total`}`}
        </span>
        <span className="drawer-trace">
          {shownTrace === null ? 'no trace' : `trace ${shownTrace}`}
        </span>
      </div>

      {lane === undefined ? (
        <>
          <p className="empty-state">
            {instrument === null
              ? 'Select an instrument to see its stage strip, debate stances and invalidation section.'
              : shownTrace === null
                ? 'This instrument has no lane in the current snapshot.'
                : // The ledger keeps a settled row for the whole session; the
                  // pipeline view reaches back 15 minutes. Past that the
                  // stage-by-stage record is genuinely gone, and the verdict
                  // line below is all that survives — which is still the row
                  // the operator clicked, not a newer one.
                  'The stage strip is drawn from the 15-minute pipeline window, and this trace is older than that. The ledger row and its verdict are what remain.'}
          </p>
          {verdict !== undefined && (
            <p className="drawer-started">
              verdict {verdict.status} · {verdict.reason} · {formatClockUtc(verdict.timestamp)}
              {verdict.hitl_override ? ' · human override' : ''}
            </p>
          )}
        </>
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
            The invalidation section (spec, "Information Inventory": required,
            not optional). There is no `invalidation_log` and never will be —
            the standalone stage was declined 2026-09-02 and #994 folded its
            mechanism into the Risk Critic, where conditions ride
            `RiskCriticVerdict.conditions` / `dropped_conditions` on
            `risk_critic_log` (migration 0040). #1066 wired that onto the
            snapshot as `risk_critics` and renders it here, in the slot the
            spec reserved for it, so the layout did not move when it landed.
          */}
          <h3 className="drawer-section">Invalidation</h3>
          <InvalidationSection riskCritic={riskCritic} />

          {/*
            The stage strip's decision column, specifically — not the whole
            record. `risk_log` DOES persist the Risk decision's status,
            binding constraint and reasons (migration 0016), which is what the
            invalidation section above renders; what neither `trader_log` nor
            `audit_log` gives the strip is a per-stage decision word, so those
            two cells still report only that the stage ran.
          */}
          <p className="drawer-caveat">
            The Trader and Risk cells above carry no decision word (#328) — they report that the
            stage ran, and the invalidation section is where Risk's own record is read. Duration
            shown as {UNKNOWN} means the store recorded none.
          </p>
        </>
      )}
    </section>
  );
}
