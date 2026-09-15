/**
 * A lane's stage cells, resolved once for display.
 *
 * Before this module, the lane matrix (`LiveTab.tsx`) and the drawer timeline
 * (`TraceSections.tsx`) each walked `PIPELINE_STAGES` over `lane.cells`,
 * handled the absent-cell case, and derived a decision word independently.
 * Only the drawer glossed a degraded decision (#1080's `DEGRADED_DECISIONS`),
 * so a starved debate read explained in the drawer and as the bare token
 * `budget_exhausted` in the matrix — the surface an operator scans first
 * (review 2026-09-04 F1, #1142). Resolving the lane once removes the seam a
 * fix to one renderer could fail to reach the other.
 *
 * #1428 closed the other half of that seam. Resolving once is not enough while
 * the resolution itself is incomplete: `audit_log` records THAT the debate
 * degraded, never which control fired, so both renderers agreed on a word that
 * disagreed with the drawer's own debate section. The degraded `debate` cell is
 * now reconciled against the debate row — see `degradedText`.
 */
import {
  DEGRADED_DECISIONS,
  type DebateRow,
  type DegradedDecision,
  isDegradedDecision,
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineLane,
  type PipelineStage,
} from '@contracts';
import { debateDegradedGloss } from './debate-termination.ts';
import { type Presented, presentCell } from './state-presentation.ts';

const STAGES_WITHOUT_RECORDED_DECISION: readonly PipelineStage[] = ['trader', 'risk'];

/** What a lane's `debate` cell needs from the debate the same trace produced */
export type DebateTermination = Pick<DebateRow, 'termination' | 'termination_cause'>;

/**
 * The `DEGRADED_DECISIONS` words `debateDecisionWord` writes off a fired
 * latency budget — the only ones that pair with `debate_log.termination =
 * 'latency_truncated'`, since both come from the same `result.timed_out`
 * (`enforceLatencyBudget`). `not_admitted` and `unread` are written by other
 * arms of that function, which set no `timed_out` and so record no cause.
 *
 * The list is what keeps the reconciliation below a consistency rule between
 * two records of ONE event rather than an overlay: the lane reaches its debate
 * by instrument alone (`laneDebate`), so an unrelated truncated debate is
 * reachable from a `not_admitted` cell, and glossing it on would claim a
 * cause for a debate that never started.
 */
const LATENCY_TRUNCATED_DECISIONS: readonly string[] = ['budget_exhausted', 'timed_out_partial'];

function decisionWordOf(cell: PipelineCell): string | null {
  return cell.decision !== null && cell.decision !== '' ? cell.decision : null;
}

function cellsByStageOf(lane: PipelineLane): ReadonlyMap<PipelineStage, PipelineCell> {
  return new Map(lane.cells.map((cell) => [cell.stage, cell]));
}

/** What a present cell's decision area says when the store recorded no word */
function fallbackText(cell: PipelineCell): string {
  if (cell.state === 'not_reached') return 'not reached';
  if (cell.state === 'skipped') return 'skipped — the tick continued';
  if (cell.state === 'live') return 'in progress';
  if (STAGES_WITHOUT_RECORDED_DECISION.includes(cell.stage)) {
    return 'no decision word recorded (#328)';
  }
  return 'no decision recorded';
}

export interface ResolvedCell {
  stage: PipelineStage;
  /** `false` when the wire carried no cell for this stage */
  present: boolean;
  /** The state word and its tone, paired so a caller cannot render one without the other (#1138) */
  state: Presented;
  /** Whether `audit_log` recorded a decision word for this cell — the matrix's render gate */
  hasRecordedDecision: boolean;
  /**
   * The bare `audit_log` word (`no_trade`, `budget_exhausted`, …), never
   * glossed — dashboard-spec.md:135 gives a cell its decision WORD, so this
   * is what the matrix paints. `null` iff `hasRecordedDecision` is `false`.
   */
  decisionWord: string | null;
  /**
   * The full prose: `decisionWord` glossed when degraded (#1080) — with the
   * debate row's cause appended where there is one (#1428, `degradedText`) —
   * or the sentence naming why there is no word (not reached, skipped, in
   * progress, no decision word recorded). The drawer paints this; the
   * matrix surfaces it as the decision word's `title` rather than as its
   * visible text, which would overflow the cell (review fix-round-1 F1).
   */
  decisionText: string;
  degraded: boolean;
  attempts: number;
  recordedAt: string | null;
  durationMs: number | null;
}

function resolveAbsentCell(stage: PipelineStage): ResolvedCell {
  return {
    stage,
    present: false,
    state: { word: 'no cell', tone: 'wait' },
    hasRecordedDecision: false,
    decisionWord: null,
    decisionText: '',
    degraded: false,
    attempts: 0,
    recordedAt: null,
    durationMs: null,
  };
}

/**
 * The audit word's gloss, plus the cause `audit_log` cannot carry (#1428).
 *
 * `debateDecisionWord` derives its word from the `DebateResult` at write time
 * and never sees `termination_cause`, so `budget_exhausted` and
 * `timed_out_partial` say a control fired without saying WHICH — and
 * `DEGRADED_DECISIONS`'s own comment sends the reader to
 * `debate_log.termination_cause` for that. Appending the shared
 * `debateDegradedGloss` is what stops the drawer from answering that question
 * twice, differently, in two sections of one panel: the Timeline resolves
 * through here and `DebateSection` calls the same function directly.
 *
 * Appended rather than substituted, matching `whyTaken` (ReviewTab.tsx) and
 * `DebateSection`'s own `${base} · ${gloss}` — the audit word's sentence also
 * carries whether a partial synthesis survived, which the cause does not.
 *
 * A stage-specific branch, not a per-stage data channel: `debate` is the only
 * stage whose degradation cause is recorded outside `audit_log`.
 */
function degradedText(
  stage: PipelineStage,
  word: DegradedDecision,
  debate: DebateTermination | undefined,
): string {
  const audit = `${word} — ${DEGRADED_DECISIONS[word]}`;
  if (stage !== 'debate' || debate === undefined || !LATENCY_TRUNCATED_DECISIONS.includes(word)) {
    return audit;
  }
  const cause = debateDegradedGloss(debate);
  return cause === null ? audit : `${audit} · ${cause}`;
}

function resolvePresentCell(
  cell: PipelineCell,
  lane: PipelineLane,
  debate: DebateTermination | undefined,
): ResolvedCell {
  const decisionWord = decisionWordOf(cell);
  const degraded = isDegradedDecision(decisionWord);
  const decisionText =
    decisionWord === null
      ? fallbackText(cell)
      : degraded
        ? degradedText(cell.stage, decisionWord, debate)
        : decisionWord;
  return {
    stage: cell.stage,
    present: true,
    state: presentCell(cell.state, lane.outcome),
    hasRecordedDecision: decisionWord !== null,
    decisionWord,
    decisionText,
    degraded,
    attempts: cell.attempts,
    recordedAt: cell.recorded_at,
    durationMs: cell.duration_ms,
  };
}

/**
 * A lane's stage cells, resolved for display — one array, in `PIPELINE_STAGES`
 * order.
 *
 * `debate` is required rather than optional, and `undefined` is a real answer
 * (no debate row for this instrument reached the client): a caller that has
 * one and forgets to pass it is the two-renderer drift this closes, so the
 * seam makes every call site decide (#1428).
 */
export function resolveLaneCells(
  lane: PipelineLane,
  debate: DebateTermination | undefined,
): readonly ResolvedCell[] {
  const cellsByStage = cellsByStageOf(lane);
  return PIPELINE_STAGES.map((stage) => {
    const cell = cellsByStage.get(stage);
    return cell === undefined ? resolveAbsentCell(stage) : resolvePresentCell(cell, lane, debate);
  });
}
