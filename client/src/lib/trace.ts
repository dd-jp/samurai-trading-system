/**
 * How the drawers find the rows that belong to one trace or one trade.
 *
 * The wire carries no single "trace record": a lane, a debate, a verdict, a
 * Risk decision, a position and its fills are separate lists keyed
 * differently, and the joins that ARE exact are worth stating so nobody
 * "improves" one into a guess later.
 *
 * - `verdicts[]` and `risk_critics[]` key on `trace_id` (the critic row also
 *   carries `instrument`, and both are matched — #1066 explains the
 *   mis-attribution a looser match invites).
 * - `closed_trades[]` carry their `debate_id`, so a closed trade's debate is
 *   an exact join; a live lane's debate is NOT (`DebateRow` has no
 *   `trace_id`), so the Live drawer shows the instrument's most recent
 *   completed debate and says so.
 * - `fills[]` and `positions[]` key on `idempotency_key`.
 */
import type {
  ClosedTradeRow,
  DebateRow,
  FillRow,
  PipelineCell,
  PipelineLane,
  PipelineStage,
  PipelineView,
  PositionRow,
  RiskCriticRow,
  VerdictRow,
} from '@contracts';

export function laneFor(
  view: PipelineView,
  instrument: string,
  traceId: string | null,
): PipelineLane | undefined {
  return traceId === null
    ? view.lanes.find((lane) => lane.instrument === instrument)
    : view.lanes.find((lane) => lane.trace_id === traceId);
}

/** A lane's cells keyed by stage, for the renderers that walk `PIPELINE_STAGES` in order. */
/** A cell's decision word, or `null` when the store recorded none (an empty string counts as none). */
export function decisionOf(cell: PipelineCell): string | null {
  return cell.decision !== null && cell.decision !== '' ? cell.decision : null;
}

export function cellsByStageOf(lane: PipelineLane): ReadonlyMap<PipelineStage, PipelineCell> {
  return new Map(lane.cells.map((cell) => [cell.stage, cell]));
}

export function verdictFor(
  verdicts: readonly VerdictRow[],
  traceId: string | null,
): VerdictRow | undefined {
  return traceId === null ? undefined : verdicts.find((row) => row.trace_id === traceId);
}

export function riskCriticFor(
  critics: readonly RiskCriticRow[],
  traceId: string | null,
  instrument: string,
): RiskCriticRow | undefined {
  return traceId === null
    ? undefined
    : critics.find((row) => row.trace_id === traceId && row.instrument === instrument);
}

/** The instrument's most recent completed debate — NOT keyed to a trace. */
export function latestDebateFor(
  debates: readonly DebateRow[],
  instrument: string,
): DebateRow | undefined {
  return debates.find((row) => row.instrument === instrument);
}

export function debateById(debates: readonly DebateRow[], debateId: string): DebateRow | undefined {
  return debates.find((row) => row.debate_id === debateId);
}

/** The Risk decision that attacked one debate — the exact join a closed trade allows. */
export function riskCriticForDebate(
  critics: readonly RiskCriticRow[],
  debateId: string,
): RiskCriticRow | undefined {
  return critics.find((row) => row.debate_id === debateId);
}

export function openPositionFor(
  positions: readonly PositionRow[],
  instrument: string,
): PositionRow | undefined {
  return positions.find((row) => row.instrument === instrument);
}

export function fillsFor(fills: readonly FillRow[], idempotencyKey: string): FillRow[] {
  return fills.filter((row) => row.idempotency_key === idempotencyKey);
}

export function closedTradeByKey(
  trades: readonly ClosedTradeRow[],
  key: string,
): ClosedTradeRow | undefined {
  return trades.find((row) => row.idempotency_key === key);
}
