import type {
  ClosedTradeRow,
  DebateRow,
  FillRow,
  PipelineLane,
  PositionRow,
  RiskCriticRow,
  VerdictRow,
} from '@contracts';
import type { WireSnapshot } from '../hooks/useSnapshot.ts';
import { type ResolvedCell, resolveLaneCells } from './lane-cells.ts';
import { type SettledOutcome, settledOutcome } from './ledger.ts';
import {
  closedTradeByKey,
  debateById,
  fillsFor,
  laneFor,
  latestDebateFor,
  openPositionFor,
  riskCriticFor,
  riskCriticForDebate,
  traceBelongsToAnotherInstrument,
  verdictFor,
} from './trace.ts';

type JoinProvenance =
  | { by: 'debate_id'; exact: true }
  | { by: 'trace_id'; exact: true }
  | { by: 'instrument'; exact: false };

export type DebateJoin = Extract<JoinProvenance, { by: 'debate_id' | 'instrument' }>;

export type RiskCriticJoin = Extract<JoinProvenance, { by: 'debate_id' | 'trace_id' }>;

const BY_DEBATE_ID: Extract<JoinProvenance, { by: 'debate_id' }> = { by: 'debate_id', exact: true };
const BY_TRACE_ID: Extract<JoinProvenance, { by: 'trace_id' }> = { by: 'trace_id', exact: true };
const BY_INSTRUMENT: Extract<JoinProvenance, { by: 'instrument' }> = {
  by: 'instrument',
  exact: false,
};

export interface Selection {
  instrument: string;
  traceId: string | null;
}

export interface TraceDetail {
  instrument: string;
  traceId: string | null;
  lane: PipelineLane | undefined;
  cells: readonly ResolvedCell[] | null;
  verdict: VerdictRow | undefined;
  riskCritic: RiskCriticRow | undefined;
  riskCriticJoin: RiskCriticJoin;
  debate: DebateRow | undefined;
  debateJoin: DebateJoin;
  position: PositionRow | undefined;
  fills: readonly FillRow[];
  settled: SettledOutcome | null;
  inFlight: boolean;
  absence: { lane: 'aged_out' | 'idle' | 'none' | 'wrong_instrument' | null };
}

export interface TradeDetail {
  trade: ClosedTradeRow;
  debate: DebateRow | undefined;
  debateJoin: DebateJoin;
  riskCritic: RiskCriticRow | undefined;
  riskCriticJoin: RiskCriticJoin;
  traceId: string | null;
  lane: PipelineLane | undefined;
  cells: readonly ResolvedCell[] | null;
  verdict: VerdictRow | undefined;
  fills: readonly FillRow[];
  absence: { trace: 'unreachable' | 'aged_out' | null };
}

function cellsOf(
  lane: PipelineLane | undefined,
  debate: DebateRow | undefined,
): readonly ResolvedCell[] | null {
  return lane === undefined || lane.trace_id === null ? null : resolveLaneCells(lane, debate);
}

export function laneDebate(
  snapshot: Pick<WireSnapshot, 'arm' | 'debates'>,
  lane: PipelineLane,
): DebateRow | undefined {
  return snapshot.arm === 'control'
    ? undefined
    : latestDebateFor(snapshot.debates, lane.instrument);
}

function laneAbsence(
  lane: PipelineLane | undefined,
  wrongInstrument: boolean,
  traceId: string | null,
): 'wrong_instrument' | 'none' | 'aged_out' | 'idle' | null {
  if (lane === undefined) {
    if (wrongInstrument) return 'wrong_instrument';
    return traceId === null ? 'none' : 'aged_out';
  }
  return lane.trace_id === null ? 'idle' : null;
}

export function resolveTrace(snapshot: WireSnapshot, selection: Selection): TraceDetail {
  const { instrument } = selection;
  const lane = laneFor(snapshot.pipeline, instrument, selection.traceId);
  const wrongInstrument =
    lane === undefined &&
    selection.traceId !== null &&
    traceBelongsToAnotherInstrument(
      snapshot.pipeline,
      snapshot.verdicts,
      snapshot.risk_critics ?? [],
      snapshot.tick_status,
      instrument,
      selection.traceId,
    );
  const traceId = wrongInstrument ? null : (selection.traceId ?? lane?.trace_id ?? null);
  const position = openPositionFor(snapshot.positions, instrument);
  const debate =
    snapshot.arm === 'control' ? undefined : latestDebateFor(snapshot.debates, instrument);
  return {
    instrument,
    traceId,
    lane,
    cells: cellsOf(lane, debate),
    verdict: verdictFor(snapshot.verdicts, traceId, instrument),
    riskCritic: riskCriticFor(snapshot.risk_critics ?? [], traceId, instrument),
    riskCriticJoin: BY_TRACE_ID,
    debate,
    debateJoin: BY_INSTRUMENT,
    position,
    fills: position === undefined ? [] : fillsFor(snapshot.fills, position.idempotency_key),
    settled: lane === undefined ? null : settledOutcome(lane.outcome),
    inFlight: lane?.outcome === 'in_flight',
    absence: { lane: laneAbsence(lane, wrongInstrument, traceId) },
  };
}

export function tradeDebate(
  debates: readonly DebateRow[],
  trade: ClosedTradeRow,
): DebateRow | undefined {
  return debateById(debates, trade.debate_id);
}

export function resolveTrade(snapshot: WireSnapshot, idempotencyKey: string): TradeDetail | null {
  const trade = closedTradeByKey(snapshot.closed_trades, idempotencyKey);
  if (trade === undefined) return null;
  const riskCritic = riskCriticForDebate(snapshot.risk_critics ?? [], trade.debate_id);
  const traceId = riskCritic?.trace_id ?? null;
  const lane = traceId === null ? undefined : laneFor(snapshot.pipeline, trade.instrument, traceId);
  const debate = debateById(snapshot.debates, trade.debate_id);
  const cells = cellsOf(lane, debate);
  return {
    trade,
    debate,
    debateJoin: BY_DEBATE_ID,
    riskCritic,
    riskCriticJoin: BY_DEBATE_ID,
    traceId,
    lane,
    cells,
    verdict: verdictFor(snapshot.verdicts, traceId, trade.instrument),
    fills: fillsFor(snapshot.fills, trade.idempotency_key),
    absence: { trace: traceId === null ? 'unreachable' : cells === null ? 'aged_out' : null },
  };
}
