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
 * Contrast the feedback cycle's own `scheduleFeedbackCycle` (production.ts),
 * which ALSO now self-reschedules a `setTimeout` — but for a different
 * reason (#1110): `runDailyCycle` is synchronous, so it cannot overlap
 * itself the way `ingestFills()` can, and its re-arming exists to recompute a
 * wall-clock boundary on every fire, not to guard against re-entrancy. This
 * loop's re-arming is the re-entrancy guard itself; that precedent does not
 * transfer here.
 *
 * ## Ordering: reconcile before the tick loop, and before every ingest
 *
 * `start()` awaits `reconcile()` once, before the tick loop and before the
 * first ingest (`runStartupReconcile`, awaited by the caller in
 * `production.ts`). Both orderings are load-bearing:
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
 * **#921: `reconcile()` is no longer startup-only.** `runPoll` below (the
 * body of every recurring pass `startFillSync` schedules) now calls
 * `reconcile()` again, before that pass's `ingestFills()`, for the SAME
 * "before every ingest" reason the startup call exists — a lost ack between
 * polls (e.g. a `submitFlatten` response dropped, leaving a
 * `flatten_submissions` row at `'submitting'` with the adapter's in-memory
 * worklist never populated) would otherwise sit unrecovered until the next
 * process restart, which on an always-on host may be arbitrarily far away.
 * Wrapped in its own try/catch so a reconcile failure — the venue briefly
 * unreachable, say — can neither block nor mask that pass's `ingestFills()`,
 * mirroring the posture the residual-protection sweep already takes in its
 * own `finally`-block try/catch below. Reported divergences are deduped
 * per-episode (`lastReconcileAction`, the same #342 "repeated-line lesson"
 * `lastSweepAction` already applies) so a divergence that persists across
 * many polls logs once, not once per poll.
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
import type {
  ReconcileDivergence,
  ReconcileReport,
  ResidualProtectionSweepResult,
} from '../../pipeline/execution/index.js';
import type { Clock, LogLevel } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { Logger } from './types.js';

/**
 * Log level for one `reconcile()` divergence (#1122, follow-up to #1096's
 * `submitted -> filled` benign-race noise).
 *
 * `undetermined` still warns — the adapter could not answer and a human must
 * look. A bracket lot's `adopted` transition to `filled`/`partially_filled`
 * demotes to `debug`: `reconcile.ts`'s own doc on `reconcileLot` states the
 * adopted lot "stays in `getOpenPositions()` and the very next `ingestFills()`
 * supplies the quantity" — and that same call, in the SAME poll (this file's
 * "Ordering" doc: reconcile before ingest, every pass), is exactly what
 * `FilledZeroSizeThrottle` (filled-zero-size-throttle.ts, #1087) watches,
 * warning with `stuck_ms`/`consecutive` at `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE`
 * (3) polls if the lot never actually fills. So nothing is lost by quieting
 * this one-shot breadcrumb: a genuine wedge is still reported, by the
 * purpose-built detector rather than this line.
 *
 * Every other case stays at `info`, deliberately: a flatten's `adopted` (
 * `kind: 'flatten'`) writes no `OpenPosition`, so the throttle above cannot
 * see it and there is no backstop to quiet against; `rejected`/`unrecorded`
 * carry no such backstop either. `debug` is dropped unless
 * `SAMURAI_LOG_LEVEL=debug` (logger.ts) — using it anywhere the throttle
 * doesn't independently cover would be silent deletion, which #1096
 * explicitly refused ("suppressing it wholesale would have hidden the one
 * real anomaly among the benign ones").
 */
function reconcileDivergenceLevel(divergence: ReconcileDivergence): LogLevel {
  if (divergence.action === 'undetermined') return 'warn';
  if (
    divergence.action === 'adopted' &&
    divergence.kind === 'bracket' &&
    (divergence.broker_state === 'filled' || divergence.broker_state === 'partially_filled')
  ) {
    return 'debug';
  }
  return 'info';
}

/**
 * The `error`-level messages this loop writes when a pass rejects — one per
 * `catch` below. Exported because the smoke gate's `FillSyncFailureRecorder`
 * (smoke-run.ts, #1049) matches on them: a reworded literal here with a stale
 * copy there would leave the recorder capturing nothing and the gate green,
 * which is the invisible-failure hole that gate check exists to close.
 */
export const FILL_SYNC_RECONCILE_FAILED = 'periodic reconcile failed' as const;
export const FILL_SYNC_SWEEP_FAILED = 'residual-protection sweep failed' as const;
export const FILL_SYNC_POLL_FAILED = 'fill poll failed' as const;

/** Execution's polled surfaces — the subset of `Execution` this loop drives. */
export interface FillSyncSurface {
  reconcile(): Promise<ReconcileReport>;
  ingestFills(): Promise<void>;
  /**
   * The #549 residual-protection sweep's within-process cadence — run after
   * every fill poll (see `runOnce`), so a re-arm failure the process
   * survives must not wait for the next restart to be retried. This runs
   * ALONGSIDE `reconcile()`'s own periodic call (#921), not in place of it:
   * `reconcile()`'s pass is scoped to `IN_FLIGHT` bracket/flatten rows
   * (`reconcile.ts`), while this sweep is scoped to lots already marked
   * `#549`-unprotected — two different worklists, both worth revisiting
   * every poll. Cheap when healthy: an empty marker worklist makes no
   * broker call.
   */
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}

export interface FillSyncDeps {
  execution: FillSyncSurface;
  clock: Clock;
  logger: Logger;
  /** Gap between the END of one poll and the start of the next. */
  fillPollIntervalMs: number;
  /**
   * `trace_id` for this loop's periodic `reconcile()` log lines (divergence,
   * completion, sweep). Required rather than defaulted, matching
   * `buildExecutionSurface`'s own `traceId` parameter (#1321) — this loop is
   * shared by both arms (production.ts), and a default here is exactly what
   * let both arms log under one literal (`RECONCILE_TRACE_ID`) despite the
   * control arm's execution surface already carrying its own
   * `CONTROL_RECONCILE_TRACE_ID`.
   */
  reconcileTraceId: string;
  /** `trace_id` for this loop's own fill-poll log lines. Same reasoning as `reconcileTraceId`. */
  fillSyncTraceId: string;
}

/**
 * The live arm's canonical trace ids, passed explicitly by production.ts —
 * see `FillSyncDeps.reconcileTraceId`/`fillSyncTraceId` above for why these
 * are no longer read directly by this module. Also the `traceId` production.ts
 * passes to `buildExecutionSurface` for the live arm's own execution-surface
 * writes, which is a separate labelling and unaffected by #1321.
 */
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
  /**
   * `trace_id` for this call's own log lines — see `FillSyncDeps.reconcileTraceId`
   * (#1321). The caller supplies its arm's constant (`RECONCILE_TRACE_ID` for
   * the live arm, `CONTROL_RECONCILE_TRACE_ID` for the control arm) rather
   * than this module defaulting to one value for both.
   */
  traceId: string;
}): Promise<ReconcileReport> {
  const report = await deps.execution.reconcile();

  for (const divergence of report.divergences) {
    deps.logger.log({
      trace_id: deps.traceId,
      stage: 'execution',
      event: 'reconcile_divergence',
      level: reconcileDivergenceLevel(divergence),
      message: 'reconcile divergence',
      payload: { ...divergence },
    });
  }

  deps.logger.log({
    trace_id: deps.traceId,
    stage: 'execution',
    level: 'info',
    message: 'startup reconcile complete',
    payload: { checked: report.checked, corrected: report.corrected },
  });

  // #1088: `sweepTerminalPositions` runs unconditionally on every
  // `reconcile()` pass, so it needs its own operator-visible trace even
  // though it isn't a divergence — otherwise a DELETE against
  // `open_positions` happens on every startup with no line anywhere to show
  // it. Only when it actually deleted something, matching every other
  // dedup/no-spam convention in this file.
  if (report.swept > 0) {
    deps.logger.log({
      trace_id: deps.traceId,
      stage: 'execution',
      level: 'info',
      message: 'reconcile: terminal-row sweep',
      payload: { swept: report.swept },
    });
  }

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
   * Per-lot dedup for the sweep-divergence log line (#549 review, #342's
   * repeated-line lesson): a lot stuck `undetermined` is returned by EVERY
   * pass, and a warn re-fired on every poll cadence indefinitely is a line
   * nobody reads. Logged on first observation and on state TRANSITIONS
   * (`undetermined` -> `adopted` and vice versa) only; a lot that leaves the
   * sweep's report is forgotten here, so a LATER episode on the same lot
   * logs afresh — the same episode scoping the durable alert dedup uses.
   * In-memory deliberately: this dedups a log line, not the page, and a
   * restart re-logging current state once is a feature.
   */
  const lastSweepAction = new Map<string, string>();
  /**
   * The same per-episode dedup as `lastSweepAction`, above, but for the
   * periodic `reconcile()` call's own divergences (#921) — a SEPARATE Map
   * rather than one shared namespace, because the two worklists overlap in
   * shape (`ReconcileDivergence`) but not in membership, and a shared Map's
   * "delete every key not reported this pass" cleanup (see both loops below)
   * would otherwise evict one call's entries on a poll where only the OTHER
   * call reported anything.
   *
   * Keyed on `idempotency_key || instrument`, not `idempotency_key` alone:
   * `findUnrecordedVenuePositions` (reconcile.ts) reports an `unrecorded`
   * divergence with `idempotency_key: ''` for every such position — an empty
   * string is not a distinguishing key, so keying on it bare would collapse
   * every unrecorded-venue-position divergence onto one dedup slot and mask
   * all but the first from ever logging. `instrument` is populated on every
   * `ReconcileDivergence` shape (bracket, flatten, and unrecorded alike), so
   * it is always a safe fallback.
   */
  const lastReconcileAction = new Map<string, string>();

  /**
   * One pass: `reconcile()`, then the fill poll, then the #549
   * residual-protection sweep.
   *
   * `reconcile()` runs FIRST and in its OWN try/catch (#921) — the same
   * "before every ingest" ordering `runStartupReconcile` establishes at
   * startup (see this module's top-of-file doc), now repeated on cadence so
   * a lost ack between polls does not sit unrecovered until the next
   * restart. Caught independently of `ingestFills()` so a reconcile failure
   * (the venue briefly unreachable, say) can neither block nor mask that
   * pass's ingest — log-and-continue, the same posture the sweep's own
   * try/catch below already takes for its failure mode.
   *
   * The #549 sweep runs in a `finally` — even when the poll itself failed,
   * and ESPECIALLY then: a residual whose re-arm the failed poll never
   * confirmed is exactly the durable marker it retries. Its own failure is
   * contained to a log line so it can neither mask the poll's error nor add
   * a second failure mode to a loop whose posture is log-and-poll-again.
   */
  const runPoll = async (): Promise<void> => {
    try {
      const report = await deps.execution.reconcile();
      const reportedThisPass = new Set<string>();
      for (const divergence of report.divergences) {
        const dedupKey = divergence.idempotency_key || divergence.instrument;
        reportedThisPass.add(dedupKey);
        // Repeat pass, same state: already logged — see `lastReconcileAction`.
        if (lastReconcileAction.get(dedupKey) === divergence.action) continue;
        lastReconcileAction.set(dedupKey, divergence.action);
        deps.logger.log({
          trace_id: deps.reconcileTraceId,
          stage: 'execution',
          event: 'reconcile_divergence',
          // Same `reconcileDivergenceLevel` `runStartupReconcile` uses for
          // this same report shape.
          level: reconcileDivergenceLevel(divergence),
          message: 'reconcile divergence',
          payload: { ...divergence },
        });
      }
      for (const key of [...lastReconcileAction.keys()]) {
        if (!reportedThisPass.has(key)) lastReconcileAction.delete(key);
      }
      // #1088: same trace `runStartupReconcile` logs above — the sweep is
      // not a divergence and runs on every pass, so it needs its own
      // operator-visible line, logged only when it deleted something.
      if (report.swept > 0) {
        deps.logger.log({
          trace_id: deps.reconcileTraceId,
          stage: 'execution',
          level: 'info',
          message: 'reconcile: terminal-row sweep',
          payload: { swept: report.swept },
        });
      }
    } catch (reconcileError) {
      deps.logger.log({
        trace_id: deps.fillSyncTraceId,
        stage: 'execution',
        event: 'fill_sync_reconcile_failed',
        level: 'error',
        message: FILL_SYNC_RECONCILE_FAILED,
        payload: {
          error: describeThrownSafely(reconcileError),
        },
      });
    }

    try {
      await deps.execution.ingestFills();
    } finally {
      try {
        const sweep = await deps.execution.sweepResidualProtection();
        const reportedThisPass = new Set<string>();
        for (const divergence of sweep.divergences) {
          reportedThisPass.add(divergence.idempotency_key);
          // Repeat pass, same state: already logged — see `lastSweepAction`.
          if (lastSweepAction.get(divergence.idempotency_key) === divergence.action) continue;
          lastSweepAction.set(divergence.idempotency_key, divergence.action);
          deps.logger.log({
            trace_id: deps.fillSyncTraceId,
            stage: 'execution',
            event: 'residual_sweep_divergence',
            // Mirrors `runStartupReconcile`'s split: `undetermined` means the
            // marker stays and a human may need to look; `adopted` means
            // protection was confirmed and the marker cleared.
            level: divergence.action === 'undetermined' ? 'warn' : 'info',
            message: 'residual-protection sweep divergence',
            payload: { ...divergence },
          });
        }
        for (const key of [...lastSweepAction.keys()]) {
          if (!reportedThisPass.has(key)) lastSweepAction.delete(key);
        }
      } catch (sweepError) {
        deps.logger.log({
          trace_id: deps.fillSyncTraceId,
          stage: 'execution',
          event: 'fill_sync_sweep_failed',
          level: 'error',
          message: FILL_SYNC_SWEEP_FAILED,
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
        trace_id: deps.fillSyncTraceId,
        stage: 'execution',
        event: 'fill_poll_skipped',
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
        trace_id: deps.fillSyncTraceId,
        stage: 'execution',
        event: 'fill_poll_failed',
        level: 'error',
        message: FILL_SYNC_POLL_FAILED,
        payload: { error: describeThrownSafely(error) },
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
