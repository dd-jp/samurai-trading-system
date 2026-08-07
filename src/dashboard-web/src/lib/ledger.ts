/**
 * Verdict ledger accumulation (issue #537; dashboard-spec.md "Verdict ledger
 * + detail drawer"). Pure state transition — no React, no clock: a seeded or
 * appended entry is stamped with the lane's last recorded timestamp, never
 * with `Date.now()`, so an entry can never claim to have just happened.
 *
 * Fed from settled pipeline lanes, not `verdicts[]` alone: a lane that ended
 * at `stopped` or `quorum_skip` never reaches `verdict_log` and would be
 * invisible in a verdict-table-only ledger.
 */

import type {
  PipelineLane,
  PipelineOutcome,
  PipelineStage,
  PipelineView,
} from '../../../dashboard/pipeline-types.ts';

/** The outcomes that settle a lane and earn a hanko stamp. */
export type SettledOutcome = 'go' | 'no_go' | 'stopped' | 'quorum_skip';

/** Newest-first display cap. `seen` is NOT capped — dedupe outlives eviction. */
export const LEDGER_CAP = 30;

export interface LedgerEntry {
  trace_id: string;
  instrument: string;
  outcome: SettledOutcome;
  /** The stage the trace ended at, straight off the lane. */
  final_stage: PipelineStage | null;
  /**
   * The lane's last non-null `recorded_at` — when the decision actually
   * happened. `null` only if a settled lane carried no recorded rows at all,
   * which the wire contract does not produce but the type permits.
   */
  settled_at: string | null;
  /**
   * True when this entry was seeded on first paint rather than observed
   * settling. The renderer stamps (animates) only un-seeded entries — a
   * seeded entry must not claim to have just happened.
   */
  seeded: boolean;
}

export interface LedgerState {
  /** Newest first, at most `LEDGER_CAP` entries. */
  entries: readonly LedgerEntry[];
  /** Every trace_id ever ledgered this session, including cap-evicted ones. */
  seen: ReadonlySet<string>;
}

export function createLedger(): LedgerState {
  return { entries: [], seen: new Set() };
}

function settledOutcome(outcome: PipelineOutcome): SettledOutcome | null {
  switch (outcome) {
    case 'go':
    case 'no_go':
    case 'stopped':
    case 'quorum_skip':
      return outcome;
    default:
      return null;
  }
}

/** Last non-null `recorded_at` in pipeline order — the lane's settle moment. */
function lastRecordedAt(lane: PipelineLane): string | null {
  let last: string | null = null;
  for (const cell of lane.cells) {
    if (cell.recorded_at !== null) last = cell.recorded_at;
  }
  return last;
}

/**
 * Fold one poll into the ledger. `prev === null` marks first paint: the
 * currently-settled lanes seed the ledger (flagged `seeded`); on any later
 * poll a newly-settled, never-seen trace is appended as a live settle.
 * Re-polls of an unchanged lane are deduped by `trace_id` against ALL seen
 * traces, so nothing is ever stamped twice — even after cap eviction.
 */
export function updateLedger(
  state: LedgerState,
  prev: PipelineView | null,
  next: PipelineView,
): LedgerState {
  const additions: LedgerEntry[] = [];
  for (const lane of next.lanes) {
    if (lane.trace_id === null) continue;
    const outcome = settledOutcome(lane.outcome);
    if (outcome === null) continue;
    if (state.seen.has(lane.trace_id)) continue;
    if (additions.some((entry) => entry.trace_id === lane.trace_id)) continue;
    additions.push({
      trace_id: lane.trace_id,
      instrument: lane.instrument,
      outcome,
      final_stage: lane.final_stage,
      settled_at: lastRecordedAt(lane),
      seeded: prev === null,
    });
  }

  if (additions.length === 0) return state;

  // Newest settle first within the batch; entries with no timestamp sink to
  // the batch's end rather than claiming recency.
  additions.sort((a, b) => {
    if (a.settled_at === null) return b.settled_at === null ? 0 : 1;
    if (b.settled_at === null) return -1;
    return Date.parse(b.settled_at) - Date.parse(a.settled_at);
  });

  const seen = new Set(state.seen);
  for (const entry of additions) seen.add(entry.trace_id);
  return {
    entries: [...additions, ...state.entries].slice(0, LEDGER_CAP),
    seen,
  };
}
