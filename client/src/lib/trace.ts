/**
 * The individual lookups the two join sequences are built from — private to
 * `resolve-trace.ts`, which owns the sequences and the provenance each join
 * carries.
 */
import type {
  ClosedTradeRow,
  DebateRow,
  FillRow,
  PipelineLane,
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

export function verdictFor(
  verdicts: readonly VerdictRow[],
  traceId: string | null,
): VerdictRow | undefined {
  return traceId === null ? undefined : verdicts.find((row) => row.trace_id === traceId);
}

/** Matches `trace_id` AND `instrument`; a looser match mis-attributes a row (#1066). */
export function riskCriticFor(
  critics: readonly RiskCriticRow[],
  traceId: string | null,
  instrument: string,
): RiskCriticRow | undefined {
  return traceId === null
    ? undefined
    : critics.find((row) => row.trace_id === traceId && row.instrument === instrument);
}

export function latestDebateFor(
  debates: readonly DebateRow[],
  instrument: string,
): DebateRow | undefined {
  return debates.find((row) => row.instrument === instrument);
}

export function debateById(debates: readonly DebateRow[], debateId: string): DebateRow | undefined {
  return debates.find((row) => row.debate_id === debateId);
}

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
