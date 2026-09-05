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
 */
import {
  DEGRADED_DECISIONS,
  isDegradedDecision,
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineLane,
  type PipelineStage,
} from '@contracts';
import { presentCell, type StateTone } from './state-presentation.ts';

const STAGES_WITHOUT_RECORDED_DECISION: readonly PipelineStage[] = ['trader', 'risk'];

function decisionWordOf(cell: PipelineCell): string | null {
  return cell.decision !== null && cell.decision !== '' ? cell.decision : null;
}

function cellsByStageOf(lane: PipelineLane): ReadonlyMap<PipelineStage, PipelineCell> {
  return new Map(lane.cells.map((cell) => [cell.stage, cell]));
}

/**
 * The prose a present cell's decision area shows when there is a real
 * decision word (glossed when degraded), and the sentence that names what
 * happened instead when there is none — moved here unchanged from the
 * drawer's former `decisionText` so both renderers agree.
 */
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
  /** `false` when the wire carried no cell for this stage. */
  present: boolean;
  /** The state word, already resolved against the lane's outcome. */
  word: string;
  tone: StateTone;
  /** The `audit_log` decision word, glossed when degraded. `null` when the store recorded none. */
  decision: string | null;
  degraded: boolean;
  attempts: number;
  recordedAt: string | null;
  durationMs: number | null;
  /**
   * The drawer's full prose for this cell: `decision` when there is one,
   * otherwise the sentence naming why there isn't (not reached, skipped,
   * in progress, no decision word recorded). The matrix does not use this —
   * it paints only `decision`, unchanged from before this module existed —
   * so this is the one field the review's proposed interface did not name;
   * without it the drawer's non-degraded empty states could only be
   * reconstructed by re-deriving `PipelineCellState` from `tone`, which is
   * exhaustive today only because `state-presentation.ts`'s `CELL_TONE`
   * happens to be injective, not because anything guarantees it stays so.
   */
  decisionText: string;
}

function resolveAbsentCell(stage: PipelineStage): ResolvedCell {
  return {
    stage,
    present: false,
    word: 'no cell',
    tone: 'wait',
    decision: null,
    degraded: false,
    attempts: 0,
    recordedAt: null,
    durationMs: null,
    decisionText: '',
  };
}

function resolvePresentCell(cell: PipelineCell, lane: PipelineLane): ResolvedCell {
  const rawDecision = decisionWordOf(cell);
  const degraded = isDegradedDecision(rawDecision);
  const decision = degraded ? `${rawDecision} — ${DEGRADED_DECISIONS[rawDecision]}` : rawDecision;
  const { word, tone } = presentCell(cell.state, lane.outcome);
  return {
    stage: cell.stage,
    present: true,
    word,
    tone,
    decision,
    degraded,
    attempts: cell.attempts,
    recordedAt: cell.recorded_at,
    durationMs: cell.duration_ms,
    decisionText: decision ?? fallbackText(cell),
  };
}

/** A lane's stage cells, resolved for display — one array, in `PIPELINE_STAGES` order. */
export function resolveLaneCells(lane: PipelineLane): readonly ResolvedCell[] {
  const cellsByStage = cellsByStageOf(lane);
  return PIPELINE_STAGES.map((stage) => {
    const cell = cellsByStage.get(stage);
    return cell === undefined ? resolveAbsentCell(stage) : resolvePresentCell(cell, lane);
  });
}
