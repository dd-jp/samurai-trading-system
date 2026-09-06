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

/** Matches `trace_id` AND `instrument`; a `trace_id`-only match renders another instrument's lane, cells, outcome and timeline under this one's header (#1205). */
export function laneFor(
  view: PipelineView,
  instrument: string,
  traceId: string | null,
): PipelineLane | undefined {
  return traceId === null
    ? view.lanes.find((lane) => lane.instrument === instrument)
    : view.lanes.find((lane) => lane.trace_id === traceId && lane.instrument === instrument);
}

/**
 * True when `traceId` is attested — on a lane, a verdict, OR a risk-critic
 * row — under some OTHER instrument. Distinguishes a mismatched `Selection`
 * (#1267, recoverable by reselecting) from a trace that has genuinely aged
 * out of every window on the wire (not recoverable at all). Only meaningful
 * once `laneFor` has already failed to find `traceId` under `instrument`.
 *
 * The lanes arm's own `!== instrument` conjunct is redundant given that
 * precondition — `laneFor` already ruled out a same-instrument match — kept
 * as executable documentation of why this reads "another instrument" rather
 * than "any instrument". The verdicts and risk-critics arms carry no such
 * precondition (those joins run separately, after `traceId` is decided) and
 * their conjuncts are load-bearing: without them, a verdict/critic row for
 * the SAME instrument as a lane that has genuinely aged out would be
 * misread as a wrong-instrument mismatch instead.
 */
export function traceBelongsToAnotherInstrument(
  view: PipelineView,
  verdicts: readonly VerdictRow[],
  riskCritics: readonly RiskCriticRow[],
  instrument: string,
  traceId: string,
): boolean {
  return (
    view.lanes.some((lane) => lane.trace_id === traceId && lane.instrument !== instrument) ||
    verdicts.some((row) => row.trace_id === traceId && row.instrument !== instrument) ||
    riskCritics.some((row) => row.trace_id === traceId && row.instrument !== instrument)
  );
}

/** Matches `trace_id` AND `instrument`; a `trace_id`-only match renders another instrument's verdict under this one's header (#1205). */
export function verdictFor(
  verdicts: readonly VerdictRow[],
  traceId: string | null,
  instrument: string,
): VerdictRow | undefined {
  return traceId === null
    ? undefined
    : verdicts.find((row) => row.trace_id === traceId && row.instrument === instrument);
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
