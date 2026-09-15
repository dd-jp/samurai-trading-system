/**
 * Wire model for the dashboard's Pipeline view — the second operator view,
 * alongside the existing tables (wayfinder map #411, primitive decided in
 * #412: ticker lanes, one row per instrument, one column per stage).
 *
 * This file is the frozen contract between the two halves of the feature:
 * the query layer that reads `audit_log` / `current_tick` and produces these
 * shapes, and the render layer that turns them into the lanes. Neither half
 * defines its own version of anything here.
 *
 * Serialization convention matches `snapshot.ts`: every `Date` is an ISO
 * string by the time it reaches this model, because `buildSnapshot` is the
 * single place that crosses the HTTP/JSON boundary.
 *
 * Moved here from `server/apps/service-api/pipeline-types.ts`, <!-- cite-exempt: historical — statement about the pre-move location; true because it no longer resolves -->
 * unchanged apart from the `AssetClass` import — see `primitives.ts` for why that
 * import had to stop pointing at a server module.
 */

import type { AssetClass } from './primitives.js';

/**
 * The stages a tick passes through, in pipeline order.
 *
 * **Six stages, and stays six.** Every member here is a stage the runtime can
 * actually write; a proposed `invalidation` stage was declined 2026-09-02
 * (its mechanism folds into the Risk Critic instead, issue #994) and does not
 * belong in this array. Do not re-widen it to seven on that mechanism's
 * account — a wire-visible stage for it would be a new, separate decision.
 */
export const PIPELINE_STAGES = [
  'analysts',
  'debate',
  'trader',
  'risk',
  'verdict',
  'execution',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * What happened to one ticker at one stage.
 *
 * `skipped` and `stopped` are separate on purpose. A skipped stage is normal
 * traffic — a stage reached by a later one in the trace but carrying no row of
 * its own — whereas `stopped` means the tick ended there. Collapsing the two
 * would report routine traffic as a halted pipeline. `cellState`'s rule is
 * mechanical over any stage-index gap, not tied to any one stage.
 */
export type PipelineCellState =
  /** Reached, completed, tick continued past it */
  | 'done'
  /** Where the in-flight tick is right now, per `current_tick` */
  | 'live'
  /** Reached, and the tick ended here */
  | 'stopped'
  /** Deliberately not run for this tick, though the tick continued */
  | 'skipped'
  /** The tick never got this far (it ended earlier), or the stage does not exist yet */
  | 'not_reached';

export interface PipelineCell {
  stage: PipelineStage;
  state: PipelineCellState;
  /**
   * Wall time in this stage, derived from the gap between consecutive
   * `audit_log` timestamps. `null` whenever there is nothing honest to
   * report: a `not_reached` or `skipped` cell, and a `live` cell (whose
   * duration is still running and is computed client-side from `entered_at`).
   */
  duration_ms: number | null;
  /** The `audit_log` decision word (`quorum_met`, `quorum_skip`, …), when one was recorded */
  decision: string | null;
  /**
   * ISO timestamp of the stage's last `audit_log` row; `null` for
   * `not_reached`, `skipped`, and `live` cells (a live stage has no row yet
   * for its CURRENT attempt — `live_entered_at` is its clock). A live cell
   * mid-retry may still have an older row from a prior attempt — that is
   * where `decision` comes from — but this field stays `null` regardless, so
   * a client never mistakes a stale prior-attempt timestamp for the live
   * stage's own recorded transition time.
   */
  recorded_at: string | null;
  /**
   * How many times this stage was reached in this trace. Normally 1.
   *
   * `audit_log` has no primary key precisely because "a tick can legitimately
   * reach the same stage twice across retries", so this is a real case rather
   * than a defensive one, and a lane that showed only the last attempt would
   * hide a retry storm.
   */
  attempts: number;
}

/**
 * The `audit_log` decision words that name a DEGRADED stage — one whose output
 * was produced by a resource control firing or an upstream failure, not by the
 * market (#1080) — mapped to the sentence a reader needs to tell the two apart.
 *
 * The problem this closes: a debate that hit its latency budget before any
 * round completed returns `direction: 'neutral', confidence: 0`, and the tick
 * runner recorded that bare direction. `debate: neutral` followed by
 * `trader: no_trade` is then byte-identical to a debate that ran to
 * convergence and genuinely found nothing — the two outcomes an operator must
 * act on most differently (fix the budget vs. accept the quiet market) were
 * indistinguishable in the log, in `audit_log`, and on the dashboard. In the
 * 2026-09-03 session that was 22 of 26 timed-out debates.
 *
 * The Analysts stage had the same defect one stage earlier and it was larger:
 * `quorum_skip` was written whether a mandatory analyst missed its deadline or
 * threw, at `info` either way. In that session 34 of 60 main-arm runs skipped,
 * every one of them on the technical analyst's 10s deadline.
 *
 * Lives in `contracts/` because both runtimes read it: the server writes these
 * words, the dashboard glosses them. Plain strings rather than a widening of
 * `PipelineOutcome` — `PipelineCell.decision` is already free text, so a new
 * word reaches the client with no wire change, whereas `PipelineOutcome` is a
 * closed union whose members drive lane-level rendering.
 */
export const DEGRADED_DECISIONS = {
  // #1380 widened what can produce this word: an `LlmClient` call that fails
  // outright (its retries exhausted, or a non-retryable fault) and arrives
  // before the debate's own latency budget timer degrades through the
  // IDENTICAL word, deliberately — both really are "no market answer, a
  // control fired", and the operator action (accept the quiet market vs.
  // investigate) is the same either way this word alone can tell. Which of
  // the two actually happened is `debate_log.termination_cause`
  // ('budget' | 'llm_failure'), not this string — read that column to tell
  // "the budget is too tight" and "the LLM provider is unreliable" apart
  // before acting on either
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
  // #1393: no producer writes this yet. It exists so that a future fallback
  // producing a neutral `DebateResult` for a reason neither `timed_out` nor
  // `rate_limited` names still glosses as degraded rather than as a genuine
  // `neutral` wash — see `DebateResult.read` (debate-engine/types.ts)
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

/** One of `DEGRADED_DECISIONS`'s keys */
export type DegradedDecision = keyof typeof DEGRADED_DECISIONS;

/**
 * Every `audit_log` decision word the Analysts stage writes when it produced no
 * views (#1080) — the plain one and the two that say why.
 *
 * Here rather than beside the runner that writes them because the reader is in
 * the other runtime: `outcomeOf` (service-api/pipeline-query.ts) maps all three
 * to the single `quorum_skip` lane outcome, and a new word added there and not
 * here would silently re-classify a skipped lane as `stopped`.
 */
export const QUORUM_SKIP_DECISIONS = [
  'quorum_skip',
  'quorum_skip_timeout',
  'quorum_skip_fault',
] as const;

/** Whether an `audit_log` decision word names a stage that produced no analyst views */
export function isQuorumSkipDecision(decision: string | null): boolean {
  return decision !== null && (QUORUM_SKIP_DECISIONS as readonly string[]).includes(decision);
}

/** Whether an `audit_log` decision word names a degraded stage rather than a market outcome */
export function isDegradedDecision(decision: string | null): decision is DegradedDecision {
  return decision !== null && Object.hasOwn(DEGRADED_DECISIONS, decision);
}

/** How a trace ended, or that it hasn't */
export type PipelineOutcome =
  | 'go'
  | 'no_go'
  /** Ended before Verdict — the last cell carries which stage and why */
  | 'stopped'
  /** Ended at Analysts without quorum */
  | 'quorum_skip'
  /** Still running (this lane holds `current_tick`) */
  | 'in_flight'
  /** No trace at all in the window — a closed market, or an instrument not yet ticked */
  | 'idle';

/** One instrument's row: its most recent trace across all six stages */
export interface PipelineLane {
  instrument: string;
  asset_class: AssetClass;
  /** `null` only for an `idle` lane */
  trace_id: string | null;
  /** Exactly `PIPELINE_STAGES.length` cells, in `PIPELINE_STAGES` order */
  cells: PipelineCell[];
  outcome: PipelineOutcome;
  /** The stage the trace ended at, or is currently in. `null` when idle. */
  final_stage: PipelineStage | null;
  /** First `audit_log` timestamp of the trace, ISO. `null` when idle. */
  started_at: string | null;
  /** Sum of the completed cells' durations. `null` when idle. */
  total_ms: number | null;
}

/** The `pipeline` field on the snapshot — what the Pipeline view renders from */
export interface PipelineView {
  lanes: PipelineLane[];
  /** `current_tick`'s trace, or `null` when nothing is in flight */
  live_trace_id: string | null;
  /** When the live tick entered its current stage, ISO. `null` when nothing is in flight. */
  live_entered_at: string | null;
}
