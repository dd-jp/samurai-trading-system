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
 * Moved here from `server/apps/service-api/pipeline-types.ts` unchanged apart from the
 * `AssetClass` import — see `primitives.ts` for why that import had to stop
 * pointing at a server module.
 */

import type { AssetClass } from './primitives.js';

/**
 * The stages a tick passes through, in pipeline order.
 *
 * **This array is seven wide, but the pipeline is six stages and stays six.**
 * `invalidation` was specced between `trader` and `risk` on 2026-08-05
 * (docs/specs/devils-advocate-spec.md) and declared here at full width so the
 * column would fill in on its own the day the stage shipped — `audit_log.stage`
 * is unconstrained TEXT, so no migration on the read path would have been needed.
 *
 * **That day is not coming.** The standalone stage was **declined 2026-09-02**;
 * its typed invalidation-condition mechanism folds into the Risk Critic instead
 * (issue #994). Nothing has ever written an `invalidation` row and nothing ever
 * will, so the member is now a dead placeholder rendering a permanently
 * never-reached column.
 *
 * Left seven wide **deliberately, for now**: `PipelineStage` derives from this
 * array and the dashboard iterates it to render rooms (dashboard-spec.md's
 * "Seven stages, not six" section, room 04 lights-off). Narrowing it to six is a
 * typed contract change with client render ripple, owned by #994 — not a tail on
 * the docs pass that recorded the ruling.
 *
 * Do not re-derive a seven-stage pipeline from this array. Prior text here quoted
 * orchestrator-spec.md's "the pipeline is SEVEN stages"; that line has since been
 * corrected at its source and the quote removed.
 */
export const PIPELINE_STAGES = [
  'analysts',
  'debate',
  'trader',
  'invalidation',
  'risk',
  'verdict',
  'execution',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * What happened to one ticker at one stage.
 *
 * `skipped` and `stopped` are separate on purpose. A skipped stage is normal
 * traffic — `invalidation` runs only for `entry`/`scale_in` intents and an
 * `exit` skips it, and that stage "never terminates the tick" — whereas
 * `stopped` means the tick ended there. Collapsing the two would report a
 * routine exit trade as a halted pipeline.
 */
export type PipelineCellState =
  /** Reached, completed, tick continued past it. */
  | 'done'
  /** Where the in-flight tick is right now, per `current_tick`. */
  | 'live'
  /** Reached, and the tick ended here. */
  | 'stopped'
  /** Deliberately not run for this tick, though the tick continued. */
  | 'skipped'
  /** The tick never got this far (it ended earlier), or the stage does not exist yet. */
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
  /** The `audit_log` decision word (`quorum_met`, `quorum_skip`, …), when one was recorded. */
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

/** How a trace ended, or that it hasn't. */
export type PipelineOutcome =
  | 'go'
  | 'no_go'
  /** Ended before Verdict — the last cell carries which stage and why. */
  | 'stopped'
  /** Ended at Analysts without quorum. */
  | 'quorum_skip'
  /** Still running (this lane holds `current_tick`). */
  | 'in_flight'
  /** No trace at all in the window — a closed market, or an instrument not yet ticked. */
  | 'idle';

/** One instrument's row: its most recent trace across all seven stages. */
export interface PipelineLane {
  instrument: string;
  asset_class: AssetClass;
  /** `null` only for an `idle` lane. */
  trace_id: string | null;
  /** Exactly `PIPELINE_STAGES.length` cells, in `PIPELINE_STAGES` order. */
  cells: PipelineCell[];
  outcome: PipelineOutcome;
  /** The stage the trace ended at, or is currently in. `null` when idle. */
  final_stage: PipelineStage | null;
  /** First `audit_log` timestamp of the trace, ISO. `null` when idle. */
  started_at: string | null;
  /** Sum of the completed cells' durations. `null` when idle. */
  total_ms: number | null;
}

/** The `pipeline` field on the snapshot — what the Pipeline view renders from. */
export interface PipelineView {
  lanes: PipelineLane[];
  /** `current_tick`'s trace, or `null` when nothing is in flight. */
  live_trace_id: string | null;
  /** When the live tick entered its current stage, ISO. `null` when nothing is in flight. */
  live_entered_at: string | null;
}
