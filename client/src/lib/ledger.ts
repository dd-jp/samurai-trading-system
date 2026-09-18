import type { PipelineLane, PipelineOutcome, PipelineStage, PipelineView } from '@contracts';

export type SettledOutcome = 'go' | 'no_go' | 'stopped' | 'quorum_skip';

export const LEDGER_CAP = 30;

export interface LedgerEntry {
  trace_id: string;
  instrument: string;
  outcome: SettledOutcome;
  final_stage: PipelineStage | null;
  settled_at: string | null;
}

export interface LedgerState {
  entries: readonly LedgerEntry[];
  seen: ReadonlySet<string>;
}

export function createLedger(): LedgerState {
  return { entries: [], seen: new Set() };
}

export function settledOutcome(outcome: PipelineOutcome): SettledOutcome | null {
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

function lastRecordedAt(lane: PipelineLane): string | null {
  let last: string | null = null;
  for (const cell of lane.cells) {
    if (cell.recorded_at !== null) last = cell.recorded_at;
  }
  return last;
}

function settleKey(entry: LedgerEntry): number | null {
  if (entry.settled_at === null) return null;
  const ms = Date.parse(entry.settled_at);
  return Number.isNaN(ms) ? null : ms;
}

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

export function updateLedger(state: LedgerState, next: PipelineView): LedgerState {
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
