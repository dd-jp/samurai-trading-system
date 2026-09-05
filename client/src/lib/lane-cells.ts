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
import { type Presented, presentCell } from './state-presentation.ts';

const STAGES_WITHOUT_RECORDED_DECISION: readonly PipelineStage[] = ['trader', 'risk'];

function decisionWordOf(cell: PipelineCell): string | null {
  return cell.decision !== null && cell.decision !== '' ? cell.decision : null;
}

function cellsByStageOf(lane: PipelineLane): ReadonlyMap<PipelineStage, PipelineCell> {
  return new Map(lane.cells.map((cell) => [cell.stage, cell]));
}

/** What a present cell's decision area says when the store recorded no word. */
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
  /** The state word and its tone, paired so a caller cannot render one without the other (#1138). */
  state: Presented;
  /** Whether `audit_log` recorded a decision word for this cell — the matrix's render gate. */
  hasRecordedDecision: boolean;
  /**
   * The bare `audit_log` word (`no_trade`, `budget_exhausted`, …), never
   * glossed — dashboard-spec.md:135 gives a cell its decision WORD, so this
   * is what the matrix paints. `null` iff `hasRecordedDecision` is `false`.
   */
  decisionWord: string | null;
  /**
   * The full prose: `decisionWord` glossed when degraded (#1080), or the
   * sentence naming why there is no word (not reached, skipped, in
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

function resolvePresentCell(cell: PipelineCell, lane: PipelineLane): ResolvedCell {
  const decisionWord = decisionWordOf(cell);
  const degraded = isDegradedDecision(decisionWord);
  const decisionText =
    decisionWord === null
      ? fallbackText(cell)
      : degraded
        ? `${decisionWord} — ${DEGRADED_DECISIONS[decisionWord]}`
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

/** A lane's stage cells, resolved for display — one array, in `PIPELINE_STAGES` order. */
export function resolveLaneCells(lane: PipelineLane): readonly ResolvedCell[] {
  const cellsByStage = cellsByStageOf(lane);
  return PIPELINE_STAGES.map((stage) => {
    const cell = cellsByStage.get(stage);
    return cell === undefined ? resolveAbsentCell(stage) : resolvePresentCell(cell, lane);
  });
}
