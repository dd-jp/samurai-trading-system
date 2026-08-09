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

import type { PipelineLane, PipelineOutcome, PipelineStage, PipelineView } from '@contracts';

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
  /**
   * Every trace_id ever ledgered this session, including cap-evicted ones.
   *
   * Deliberately uncapped, and it must stay that way: the spec's dedupe is
   * "against every entry ever seen this session, so a re-poll of an unchanged
   * lane never re-stamps it", and a lane sits in the 15-minute window across
   * ~300 polls. Any bound smaller than the session re-opens exactly the
   * double-stamp this set exists to prevent (PR #582 review round 2).
   *
   * The growth it trades for that is negligible: lanes are capped at 24 and a
   * trace turns over at the tick cadence (15 minutes, ADR-0008), so a tab left
   * open for a week accumulates on the order of 10^4 UUID strings — under a
   * megabyte, against a 190 kB bundle.
   */
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
 * Sort key for a batch entry: the settle moment in epoch ms, or `null` when
 * there is none to trust — no `recorded_at` at all, or one the store wrote
 * malformed. Both degrade the same way, because both mean the same thing to
 * this ordering: no defensible claim to recency.
 */
function settleKey(entry: LedgerEntry): number | null {
  if (entry.settled_at === null) return null;
  const ms = Date.parse(entry.settled_at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest settle first within a batch; entries with no usable timestamp sink
 * to the batch's end in wire order rather than claiming recency.
 *
 * The timestamps are parsed BEFORE the comparator runs, and the comparator
 * never sees a NaN (PR #582 review round 3): a comparator that returns NaN
 * makes `Array.prototype.sort`'s ordering implementation-defined, so one
 * malformed `recorded_at` could scramble the whole batch rather than
 * misplace its own row. Ties — including every unparseable entry against
 * every other — fall back to the wire index, so the result is a total order
 * that does not depend on the engine's sort being stable either.
 */
function orderNewestFirst(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, key: settleKey(entry) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key === b.key) return a.index - b.index;
        return a.key === null ? 1 : -1;
      }
      return b.key - a.key || a.index - b.index;
    })
    .map((decorated) => decorated.entry);
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

  const seen = new Set(state.seen);
  for (const entry of additions) seen.add(entry.trace_id);
  return {
    entries: [...orderNewestFirst(additions), ...state.entries].slice(0, LEDGER_CAP),
    seen,
  };
}
