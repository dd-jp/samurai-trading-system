/**
 * CLI-owned read model (docs/specs/cli-spec.md, "Module: Query Store").
 * `QueryStore` is a thin, read-only wrapper the CLI's render functions
 * depend on — never a competing shape for data owned elsewhere. Populated
 * ticket-by-ticket like every other component's port; this file currently
 * only carries the slice #98 (debate view) needs. #97 (positions, verdicts,
 * performance) adds the remaining methods (`getOpenPositions`,
 * `getVerdictHistory`, `getAnalystWeights`, `getAttribution`,
 * `getDailyMetrics`, `getMark`) to this same interface.
 */
import type { AssetClass } from '../orchestrator/types.js';
import type { DebateLog } from '../shared/types.js';

/**
 * Coarse in-progress indicator sourced from the Orchestrator's `current_tick`
 * row (orchestrator-spec.md, Module: Tick Runner). The Debate Engine's
 * round-by-round state isn't persisted (decision #10), so this is the only
 * observable signal of an in-flight tick — not a live debate-round view.
 */
export interface TickStatus {
  instrument: string;
  asset_class: AssetClass;
  stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  trace_id: string;
}

export interface QueryStore {
  /** The `limit` most recent completed debates as of `asOf`, newest first. */
  getRecentDebates(limit: number, asOf: Date): DebateLog[];
  /** The active `current_tick` row as of `asOf`, or null if no tick is in progress. */
  getTickStatus(asOf: Date): TickStatus | null;
}
