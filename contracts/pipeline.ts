
import type { AssetClass } from './primitives.js';

export const PIPELINE_STAGES = [
  'analysts',
  'debate',
  'trader',
  'risk',
  'verdict',
  'execution',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type PipelineCellState =
  | 'done'
  | 'live'
  | 'stopped'
  | 'skipped'
  | 'not_reached';

export interface PipelineCell {
  stage: PipelineStage;
  state: PipelineCellState;
  duration_ms: number | null;
  decision: string | null;
  recorded_at: string | null;
  attempts: number;
}

export const DEGRADED_DECISIONS = {
  budget_exhausted:
    'the debate hit its latency budget, or an LLM call it depended on failed outright, before ' +
    'any round completed — no synthesis exists, so the neutral direction and zero confidence ' +
    'are the absence of an answer, not an answer',
  timed_out_partial:
    'the debate hit its latency budget, or an LLM call it depended on failed outright, mid-debate ' +
    '— the direction is a real but truncated synthesis from the last round that finished',
  not_admitted:
    'the debate produced no result because something refused it a budget it needed — the LLM ' +
    'rate limiter, the spend cap, or the account-wide in-flight gate (#1080). The first two ' +
    'refuse before the debate starts, so no model was asked anything; the gate can also refuse ' +
    'mid-debate, in which case earlier persona calls were billed and their answers discarded. ' +
    'Either way nothing was handed downstream',
  unread:
    'the result was not read from a debate at all — neither the latency budget nor the rate ' +
    'limiter accounts for it, so whatever produced it read nothing',
  quorum_skip_timeout:
    'a mandatory analyst missed its per-attempt deadline on every attempt — the empty view set ' +
    'is a budget firing, not the analysts finding nothing to trade',
  quorum_skip_fault:
    'a mandatory analyst failed for a reason other than its deadline (a data gap, a provider ' +
    'fault) — the tick was stopped before any view existed, not decided',
} as const satisfies Record<string, string>;

export type DegradedDecision = keyof typeof DEGRADED_DECISIONS;

export const QUORUM_SKIP_DECISIONS = [
  'quorum_skip',
  'quorum_skip_timeout',
  'quorum_skip_fault',
] as const;

export function isQuorumSkipDecision(decision: string | null): boolean {
  return decision !== null && (QUORUM_SKIP_DECISIONS as readonly string[]).includes(decision);
}

export function isDegradedDecision(decision: string | null): decision is DegradedDecision {
  return decision !== null && Object.hasOwn(DEGRADED_DECISIONS, decision);
}

export type PipelineOutcome =
  | 'go'
  | 'no_go'
  | 'stopped'
  | 'quorum_skip'
  | 'in_flight'
  | 'idle';

export interface PipelineLane {
  instrument: string;
  asset_class: AssetClass;
  trace_id: string | null;
  cells: PipelineCell[];
  outcome: PipelineOutcome;
  final_stage: PipelineStage | null;
  started_at: string | null;
  total_ms: number | null;
}

export interface PipelineView {
  lanes: PipelineLane[];
  live_trace_id: string | null;
  live_entered_at: string | null;
}
