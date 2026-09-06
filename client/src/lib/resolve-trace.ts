/**
 * The two join sequences the drawers are built on, resolved once each.
 *
 * The wire carries no single "trace record": a lane, a debate, a verdict, a
 * Risk decision, a position and its fills are separate lists keyed
 * differently, and the sequence that walks them is the client's own domain
 * knowledge. It ran inline in the two drawers until #1139, where the only way
 * to test a join was to render a React tree — the least-tested layer of the
 * client, and exactly where #1066-class mis-attribution lives.
 *
 * `resolveTrade` runs the harder direction: a closed trade reaches its stage
 * record ONLY by finding the Risk decision keyed to its debate and recovering
 * a `trace_id` from that row. Nothing else on the wire bridges the two, so a
 * trade whose critic row has aged out of the recent-decisions window has no
 * trace at all — `absence.trace` says which of the two silences it is.
 *
 * `trace.ts` holds the individual lookups; it is this module's private
 * implementation, not an interface any component reaches through.
 */
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
  verdictFor,
} from './trace.ts';

/**
 * How a joined row was found. `exact` is not free: only the instrument
 * fallback is approximate, so `{ by: 'instrument', exact: true }` does not
 * type-check and no resolver can pass a guess off as a key match.
 */
export type JoinProvenance =
  | { by: 'debate_id'; exact: true }
  | { by: 'trace_id'; exact: true }
  | { by: 'instrument'; exact: false };

/** A `DebateRow` carries no `trace_id`, so a live lane's debate can only be approximate. */
export type DebateJoin = Extract<JoinProvenance, { by: 'debate_id' | 'instrument' }>;

/** Both routes to a Risk decision are exact key matches; neither falls back. */
export type RiskCriticJoin = Extract<JoinProvenance, { by: 'debate_id' | 'trace_id' }>;

const BY_DEBATE_ID: Extract<JoinProvenance, { by: 'debate_id' }> = { by: 'debate_id', exact: true };
const BY_TRACE_ID: Extract<JoinProvenance, { by: 'trace_id' }> = { by: 'trace_id', exact: true };
const BY_INSTRUMENT: Extract<JoinProvenance, { by: 'instrument' }> = {
  by: 'instrument',
  exact: false,
};

export interface Selection {
  instrument: string;
  /** `null` selects the instrument's current lane; a trace id pins one trace. */
  traceId: string | null;
}

export interface TraceDetail {
  instrument: string;
  traceId: string | null;
  lane: PipelineLane | undefined;
  /** `null` when there is no trace to draw a timeline from — `absence.lane` says why. */
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
  absence: { lane: 'aged_out' | 'idle' | 'none' | null };
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
  /** `unreachable`: no critic row named the debate. `aged_out`: the trace left the window. */
  absence: { trace: 'unreachable' | 'aged_out' | null };
}

function cellsOf(lane: PipelineLane | undefined): readonly ResolvedCell[] | null {
  return lane === undefined || lane.trace_id === null ? null : resolveLaneCells(lane);
}

/** Every row the Live drawer shows for one selected lane or pinned trace. */
export function resolveTrace(snapshot: WireSnapshot, selection: Selection): TraceDetail {
  const { instrument } = selection;
  const lane = laneFor(snapshot.pipeline, instrument, selection.traceId);
  const traceId = selection.traceId ?? lane?.trace_id ?? null;
  const position = openPositionFor(snapshot.positions, instrument);
  return {
    instrument,
    traceId,
    lane,
    cells: cellsOf(lane),
    verdict: verdictFor(snapshot.verdicts, traceId, instrument),
    riskCritic: riskCriticFor(snapshot.risk_critics ?? [], traceId, instrument),
    riskCriticJoin: BY_TRACE_ID,
    debate: latestDebateFor(snapshot.debates, instrument),
    debateJoin: BY_INSTRUMENT,
    position,
    fills: position === undefined ? [] : fillsFor(snapshot.fills, position.idempotency_key),
    settled: lane === undefined ? null : settledOutcome(lane.outcome),
    inFlight: lane?.outcome === 'in_flight',
    absence: {
      lane:
        lane === undefined
          ? traceId === null
            ? 'none'
            : 'aged_out'
          : lane.trace_id === null
            ? 'idle'
            : null,
    },
  };
}

/**
 * The one join a Review row needs, without the rest of `resolveTrade`'s
 * sequence: a table of N rows would otherwise re-run all of it per poll.
 */
export function tradeDebate(
  debates: readonly DebateRow[],
  trade: ClosedTradeRow,
): DebateRow | undefined {
  return debateById(debates, trade.debate_id);
}

/** Every row the Review drawer shows for one closed trade, or `null` if it has left the window. */
export function resolveTrade(snapshot: WireSnapshot, idempotencyKey: string): TradeDetail | null {
  const trade = closedTradeByKey(snapshot.closed_trades, idempotencyKey);
  if (trade === undefined) return null;
  const riskCritic = riskCriticForDebate(snapshot.risk_critics ?? [], trade.debate_id);
  const traceId = riskCritic?.trace_id ?? null;
  const lane = traceId === null ? undefined : laneFor(snapshot.pipeline, trade.instrument, traceId);
  const cells = cellsOf(lane);
  return {
    trade,
    debate: debateById(snapshot.debates, trade.debate_id),
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
