/**
 * The fill-sync loop — the scheduled caller for Execution's two non-tick
 * surfaces, `reconcile()` (#86) and `ingestFills()` (#83).
 *
 * ## Why this exists
 *
 * Both surfaces were implemented and neither was ever scheduled: nothing in
 * #234–#237 wired them, and `production.ts` said so in its own doc comment.
 * The consequence is not "fills arrive late" — it is that a lot's lifecycle
 * stops dead at `submitted`. `updatePositionFill` is only reached from
 * `ingestFills`, so `filled_size` stays 0; `computePortfolioView` derives
 * exposure from `filled_size`, so Risk sizes every subsequent decision
 * against a portfolio that never grows; and `writeClosedTrade` is only
 * reached from `ingestFills`, so no `ClosedTrade` is ever emitted and the
 * Feedback Loop has nothing to attribute. One missing caller, four silent
 * failures.
 *
 * ## Why a self-scheduling timeout, not `setInterval`
 *
 * `startFillSync` below re-arms a `setTimeout` after each pass settles. The
 * rejected alternative was `setInterval`, and this paragraph describes that
 * hypothetical, not the code:
 *
 * `ingestFills()` is async and makes N broker calls — one `getOrder` per open
 * bracket, paced by the adapter's token bucket. A `setInterval` fires on a
 * fixed period regardless of whether the previous pass has finished, so a poll
 * slower than its own period would re-enter: two passes would both read
 * `getOpenPositions()` and both call `resizeProtectiveLegs`, racing on the
 * protective quantity of a lot that is mid-fill. The tick loop
 * (`startTickLoop`) already solved this — `setTimeout` re-armed only after
 * the previous pass settles, plus an `inFlight` guard — and this mirrors it
 * deliberately rather than inventing a second concurrency posture.
 *
 * Contrast `runFeedbackCycle`, which does use `setInterval`: `runDailyCycle`
 * is synchronous, so it cannot overlap itself. That precedent does not
 * transfer here.
 *
 * ## Ordering: reconcile once, before anything else
 *
 * `start()` awaits `reconcile()` before the tick loop and before the first
 * ingest. Both orderings are load-bearing:
 *
 * - **Before the tick loop** — reconcile adopts broker truth for lots a crash
 *   stranded in `pending`/`submitted`. Letting `execute()` write ahead first
 *   would have Risk sizing against a store that still disagrees with the
 *   venue.
 * - **Before the first ingest** — `reconcile.ts` states this itself: on the
 *   live adapters the bracket registry is process-local (`brackets` map), so
 *   after a restart `fetchNewFills` polls nothing until `getOrder` repopulates
 *   it, and reconcile is what calls `getOrder`.
 *
 * ## What this does NOT fix
 *
 * Reconcile only visits `IN_FLIGHT` states (`reconcile.ts`: `pending` /
 * `submitted`). A lot already `partially_filled` or `filled` at restart is
 * never passed to `getOrder`, so its bracket id is never re-learned, so its
 * exit-leg fills stay invisible to `fetchNewFills` for the rest of the
 * process's life. Scheduling reconcile does not close that — durable bracket
 * state does, which is #295/#287. Do not read this module as making the
 * adapters restart-safe.
 */
import type { ReconcileReport, ResidualProtectionSweepResult } from '../execution/index.js';
import type { Clock } from '../shared/index.js';
import type { Logger } from './types.js';

/** Execution's polled surfaces — the subset of `Execution` this loop drives. */
export interface FillSyncSurface {
  reconcile(): Promise<ReconcileReport>;
  ingestFills(): Promise<void>;
  /**
   * The #549 residual-protection sweep's within-process cadence — run after
   * every fill poll (see `runOnce`), because `reconcile()` has no recurring
   * schedule here and a re-arm failure the process survives must not wait
   * for the next restart to be retried. Cheap when healthy: an empty marker
   * worklist makes no broker call.
   */
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}

export interface FillSyncDeps {
  execution: FillSyncSurface;
  clock: Clock;
  logger: Logger;
  /** Gap between the END of one poll and the start of the next. */
  fillPollIntervalMs: number;
}

export const FILL_SYNC_TRACE_ID = 'fill-sync';
export const RECONCILE_TRACE_ID = 'reconcile';

/**
 * Runs the one-shot startup reconcile. Separate from the loop because it is
 * awaited by `start()` — a failure here is reported to the caller rather than
 * swallowed, since starting the tick loop against an unreconciled store is
 * the thing reconcile exists to prevent.
 *
 * Divergences are logged individually: each one is a lot whose stored state
 * disagreed with the venue, which is exactly what an operator needs to see
 * after a crash.
 */
export async function runStartupReconcile(deps: {
  execution: FillSyncSurface;
  logger: Logger;
}): Promise<ReconcileReport> {
  const report = await deps.execution.reconcile();

  for (const divergence of report.divergences) {
    deps.logger.log({
      trace_id: RECONCILE_TRACE_ID,
      stage: 'execution',
      // `undetermined` means the adapter could not answer and a human must
      // look; an adopted/rejected lot was settled automatically.
      level: divergence.action === 'undetermined' ? 'warn' : 'info',
      message: 'reconcile divergence',
      payload: { ...divergence },
    });
  }

  deps.logger.log({
    trace_id: RECONCILE_TRACE_ID,
    stage: 'execution',
    level: 'info',
    message: 'startup reconcile complete',
    payload: { checked: report.checked, corrected: report.corrected },
  });

  return report;
}

/**
 * Starts the recurring fill poll. Returns a `stop()` that clears the timer and
 * awaits the in-flight pass, so a shutdown never abandons a poll between
 * `writeFill` and `updatePositionFill`.
 */
export function startFillSync(deps: FillSyncDeps): { stop: () => Promise<void> } {
  let stopped = false;
  /** The current pass, so `stop()` awaits it rather than cutting it off. */
  let inFlight: Promise<void> | undefined;
  let handle: NodeJS.Timeout | undefined;

  /**
   * One pass: the fill poll, then the #549 residual-protection sweep. The
   * sweep runs in a `finally` — even when the poll itself failed, and
   * ESPECIALLY then: a residual whose re-arm the failed poll never confirmed
   * is exactly the durable marker it retries. Its own failure is contained
   * to a log line so it can neither mask the poll's error nor add a second
   * failure mode to a loop whose posture is log-and-poll-again.
   */
  const runPoll = async (): Promise<void> => {
    try {
      await deps.execution.ingestFills();
    } finally {
      try {
        const sweep = await deps.execution.sweepResidualProtection();
        for (const divergence of sweep.divergences) {
          deps.logger.log({
            trace_id: FILL_SYNC_TRACE_ID,
            stage: 'execution',
            // Mirrors `runStartupReconcile`'s split: `undetermined` means the
            // marker stays and a human may need to look; `adopted` means
            // protection was confirmed and the marker cleared.
            level: divergence.action === 'undetermined' ? 'warn' : 'info',
            message: 'residual-protection sweep divergence',
            payload: { ...divergence },
          });
        }
      } catch (sweepError) {
        deps.logger.log({
          trace_id: FILL_SYNC_TRACE_ID,
          stage: 'execution',
          level: 'error',
          message: 'residual-protection sweep failed',
          payload: {
            error: sweepError instanceof Error ? sweepError.message : String(sweepError),
          },
        });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    // Belt-and-braces against re-entry: `schedule()` already re-arms only
    // after the previous pass settles, but the guard keeps that invariant
    // local to the thing it protects rather than resting on the caller.
    if (inFlight !== undefined) {
      deps.logger.log({
        trace_id: FILL_SYNC_TRACE_ID,
        stage: 'execution',
        level: 'warn',
        message: 'fill poll skipped: previous poll still running',
      });
      return;
    }
    try {
      inFlight = runPoll();
      await inFlight;
    } catch (error) {
      // One bad poll must not end the run — the venue being briefly
      // unreachable is expected, and `ingestFills` is idempotent, so the next
      // poll re-offers whatever this one missed. Same posture as the tick
      // loop: log, survive, let the heartbeat's silence be the external
      // failure signal.
      deps.logger.log({
        trace_id: FILL_SYNC_TRACE_ID,
        stage: 'execution',
        level: 'error',
        message: 'fill poll failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      inFlight = undefined;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = setTimeout(() => {
      void runOnce().then(schedule);
    }, deps.fillPollIntervalMs);
  };

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
      // `runOnce` swallows its own errors, so this only ever waits.
      await inFlight;
    },
  };
}
