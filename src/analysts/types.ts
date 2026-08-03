/**
 * Domain types & contracts for the Analysts layer (Stage 1).
 * See docs/specs/analysts-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md. Ticket #70 shipped one stateless
 * persona (Technical) end-to-end. Ticket #71 adds Fundamental/Sentiment and
 * the `AnalystOrchestrator` (applicability filtering + role-dependent
 * quorum). Retry-on-failure and the 2-consecutive-skip alert
 * (analysts-spec.md "Module: Failure Handling") are not built here — no
 * ticket covers them yet, so a persona failure is reported after a single
 * attempt rather than a retried one.
 *
 * `AnalystView`/`Direction` are NOT redefined here: analysts-spec.md keeps
 * them in lockstep with the Debate Engine's copy (cross-spec-contracts.md
 * GAP-J), and this is the Debate Engine's upstream contract, so this module
 * imports rather than duplicates (mirrors trader/types.ts importing
 * `DebateResult` from debate-engine).
 */

import type { AnalystView } from '../debate-engine/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { MarketIntelligenceStore } from '../market-intelligence/index.js';
import type { AssetClass, Clock } from '../shared/index.js';

export type { AssetClass };

/**
 * What the Analysts layer consumes to run a tick. Production (scanning /
 * scheduling the universe) is out of scope for this spec — see
 * analysts-spec.md "Out of Scope: Signal Production" — the Orchestrator is
 * the likely producer (cross-spec-contracts.md OPEN-GAP-D). Defined here
 * because no other module owns it yet.
 */
export interface Signal {
  asset: string;
  asset_class: AssetClass;
}

/**
 * What the orchestrator assembles for each analyst per tick (analysts-spec.md
 * "Key Interfaces"). No weight here — the analyst is weight-blind; weights
 * are applied downstream in the Debate Engine.
 */
export interface AnalystInput {
  /** Cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  signal: Signal;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
}

/**
 * A single analyst persona: a pure function of its inputs. Stateless per
 * tick (analysts-spec.md "Module: State Management") — implementations must
 * hold no memory across `run` calls.
 */
export interface Analyst {
  analyst_type: string;
  applies_to(asset_class: AssetClass): boolean;
  role: 'mandatory' | 'optional';
  run(input: AnalystInput): Promise<AnalystView>;
}

/** One persona's failure this tick, reason-tagged (analysts-spec.md "Module: Failure Handling"). */
export interface AnalystFailure {
  analyst_type: string;
  role: 'mandatory' | 'optional';
  reason: string;
}

/**
 * What `AnalystOrchestrator.runAnalysts` returns (analysts-spec.md "Key
 * Interfaces"). No `weights` field here — the shared SQLite weight store is
 * owned by the Feedback Loop and not built yet; adding it is a follow-up,
 * not invented here.
 */
export interface AnalystRunResult {
  /** One per successful applicable analyst; empty if the tick was skipped. */
  views: AnalystView[];
  /** 2 for crypto, 3 for stocks — the applicable count before failures. */
  analyst_count: number;
  /** True if a mandatory analyst failed, blocking the handoff downstream. */
  skipped: boolean;
  /** Every persona failure this tick, reason-tagged. */
  failures: AnalystFailure[];
}
