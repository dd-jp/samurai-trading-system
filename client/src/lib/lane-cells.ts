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

export type DebateTermination = Pick<DebateRow, 'termination' | 'termination_cause'>;

const LATENCY_TRUNCATED_DECISIONS: readonly string[] = ['budget_exhausted', 'timed_out_partial'];

function decisionWordOf(cell: PipelineCell): string | null {
  return cell.decision !== null && cell.decision !== '' ? cell.decision : null;
}

function cellsByStageOf(lane: PipelineLane): ReadonlyMap<PipelineStage, PipelineCell> {
  return new Map(lane.cells.map((cell) => [cell.stage, cell]));
}

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
  present: boolean;
  state: Presented;
  hasRecordedDecision: boolean;
  decisionWord: string | null;
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
