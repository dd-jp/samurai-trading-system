/**
 * The fill-sync loop — the scheduled caller for Execution's two non-tick
 * surfaces, `reconcile()` and `ingestFills()`. Without a scheduled caller a
 * lot's lifecycle stops dead at `submitted`: `filled_size` never advances,
 * Risk sizes against a portfolio that never grows, and no `ClosedTrade` is
 * ever emitted.
 *
 * Self-schedules a `setTimeout` after each pass settles rather than
 * `setInterval`, mirroring `startTickLoop`: `ingestFills()` is async and a
 * fixed-period timer firing before the previous pass finished would let two
 * passes race on `resizeProtectiveLegs` for the same mid-fill lot.
 *
 * `start()` awaits `reconcile()` once before the tick loop AND before the
 * first ingest — both load-bearing. Before the tick loop, so Risk never sizes
 * against a store that still disagrees with the venue after a crash. Before
 * the first ingest, because the live adapters' bracket registry is
 * process-local, so `fetchNewFills` polls nothing until `getOrder`
 * repopulates it. `runPoll` below repeats this same reconcile-before-ingest
 * ordering on every recurring pass, not just at startup, in its own
 * try/catch so a reconcile failure cannot block or mask that pass's ingest.
 *
 * Reconcile only visits in-flight (`pending`/`submitted`) orders. A lot
 * already `partially_filled` or `filled` at restart never has its bracket id
 * re-learned, so its exit-leg fills stay invisible to `fetchNewFills` for the
 * rest of the process's life — durable bracket state would close that, this
 * loop does not.
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
 * Log level for one `reconcile()` divergence. `undetermined` and
 * `unrecorded` warn — the first needs a human because the adapter could not
 * answer, the second because it is an unhedged exposure Risk cannot see and
 * no other detector reports.
 *
 * A bracket lot's `adopted` transition to `filled`/`partially_filled`
 * demotes to `debug`: the same poll's `ingestFills()` supplies the quantity
 * right after, and `FilledZeroSizeThrottle` already watches for the case
 * where it never actually fills — so nothing is lost quieting this one-shot
 * breadcrumb.
 *
 * A flatten's benign `adopted` stays at `info` rather than being demoted the
 * same way: it is the only record that a flatten was reconciled at all
 * (measured well below the noise level that justified the bracket demotion),
 * and a wrong adopt still escalates to an operator via
 * `cancelWedgedFlatten`/`judgeTerminalUnsweptFlatten` within a bounded
 * window regardless. `rejected` stays `info` too — the venue refused the
 * order, so no position exists to be exposed.
 *
 * `warn` here is a LOG level, not a page — the unrecorded-position page is a
 * separate `AlertChannelSlots` channel raised independently by
 * `findUnrecordedVenuePositions`, throttled per instrument, while this line
 * logs once per poll per divergence (collapsed by `lastReconcileAction`
 * below).
 */
function reconcileDivergenceLevel(divergence: ReconcileDivergence): LogLevel {
  if (divergence.action === 'undetermined' || divergence.action === 'unrecorded') return 'warn';
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
 * `lastReconcileAction`'s comparison value. `action` alone collapses distinct
 * events onto one dedup state — e.g. an escalated cancel shares `action:
 * 'adopted'` with the prior pass's benign flatten adopt, differing only in
 * `reason`. Folding `escalation` in gives each event its own value. Shared
 * with `lastSweepAction`'s loop below since `sweepResidualProtection` hits
 * the identical collision, so the two loops cannot drift on what "same dedup
 * state" means.
 */
function reconcileDedupState(divergence: ReconcileDivergence): string {
  return divergence.escalation
    ? `${divergence.action}:${divergence.escalation}`
    : divergence.action;
}

/**
 * The `error`-level messages this loop writes when a pass rejects — one per
 * `catch` below. Exported because the smoke gate's `FillSyncFailureRecorder`
 * (smoke-run.ts) matches on them: a reworded literal here with a stale copy
 * there would leave the recorder capturing nothing and the gate green.
 */
export const FILL_SYNC_RECONCILE_FAILED = 'periodic reconcile failed' as const;
export const FILL_SYNC_SWEEP_FAILED = 'residual-protection sweep failed' as const;
export const FILL_SYNC_POLL_FAILED = 'fill poll failed' as const;

/** Execution's polled surfaces — the subset of `Execution` this loop drives */
export interface FillSyncSurface {
  reconcile(): Promise<ReconcileReport>;
  ingestFills(): Promise<void>;
  /**
   * The residual-protection sweep's within-process cadence — run after every
   * fill poll, so a re-arm failure the process survives must not wait for
   * the next restart to be retried. Runs ALONGSIDE `reconcile()`'s own
   * periodic call, not in place of it: the two are scoped to different
   * worklists (in-flight bracket/flatten rows vs. lots already marked
   * unprotected). Cheap when healthy: an empty marker worklist makes no
   * broker call.
   */
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}

export interface FillSyncDeps {
  execution: FillSyncSurface;
  clock: Clock;
  logger: Logger;
  /** Gap between the END of one poll and the start of the next */
  fillPollIntervalMs: number;
  /**
   * `trace_id` for this loop's periodic `reconcile()` log lines. Required
   * rather than defaulted, matching `buildExecutionSurface`'s own `traceId`
   * parameter — this loop is shared by both arms (production.ts), and a
   * default here would let both arms log under one literal despite the
   * control arm carrying its own `CONTROL_RECONCILE_TRACE_ID`.
   */
  reconcileTraceId: string;
  /** `trace_id` for this loop's own fill-poll log lines. Same reasoning as `reconcileTraceId`. */
  fillSyncTraceId: string;
  /**
   * Reports a lot still open after ADR-0014's flatten grace expired
   * (`buildCarriedLotReporter`). Rides on THIS loop because there is nowhere
   * else it could: the tick scheduler has already stopped for the day by the
   * time the grace expires, and this loop has no market-hours gate. A NAMED
   * hook rather than a generic `afterPoll` callback, so a future caller
   * cannot quietly hang unrelated work off the fill poll.
   *
   * Optional because the backtest harness and every fixture drive this loop
   * without a calendar; the production root wires it on BOTH arms, since a
   * carried lot can occur on either.
   *
   * Must not throw; it is called inside the poll and is wrapped anyway.
   */
  reportCarriedLots?: () => Promise<void>;
}

/**
 * The live arm's canonical trace ids, passed explicitly by production.ts —
 * see `FillSyncDeps.reconcileTraceId`/`fillSyncTraceId` above for why these
 * are no longer read directly by this module
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
   * `trace_id` for this call's own log lines — see `FillSyncDeps.reconcileTraceId`.
   * The caller supplies its arm's constant (`RECONCILE_TRACE_ID` for the live
   * arm, `CONTROL_RECONCILE_TRACE_ID` for the control arm) rather than this
   * module defaulting to one value for both.
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

  // `sweepTerminalPositions` runs unconditionally on every `reconcile()`
  // pass, so it needs its own operator-visible trace even though it isn't a
  // divergence. Logged only when it deleted something, matching every other
  // dedup/no-spam convention in this file
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
  /** The current pass, so `stop()` awaits it rather than cutting it off */
  let inFlight: Promise<void> | undefined;
  let handle: NodeJS.Timeout | undefined;
  /**
   * Per-lot dedup for the sweep-divergence log line: a lot stuck
   * `undetermined` is returned by EVERY pass, and a warn re-fired every poll
   * indefinitely is a line nobody reads. Logged on first observation and on
   * state TRANSITIONS only; a lot that leaves the sweep's report is
   * forgotten here, so a later episode logs afresh. In-memory deliberately —
   * this dedups a log line, not a page, and a restart re-logging once is a
   * feature.
   *
   * Keyed on `reconcileDedupState()`, not bare `action`: several push sites
   * share `action: 'undetermined'`, so a bare-`action` key would mask every
   * transition after the first.
   */
  const lastSweepAction = new Map<string, string>();
  /**
   * The same per-episode dedup as `lastSweepAction` above, but for the
   * periodic `reconcile()` call's own divergences — a SEPARATE Map because
   * the two worklists overlap in shape but not membership, and a shared
   * Map's "delete every key not reported this pass" cleanup would otherwise
   * evict one call's entries on a poll where only the other call reported.
   *
   * Keyed on `idempotency_key || instrument`, not `idempotency_key` alone:
   * `findUnrecordedVenuePositions` reports an `unrecorded` divergence with
   * `idempotency_key: ''` for every such position, so keying on it bare
   * would collapse them all onto one dedup slot.
   */
  const lastReconcileAction = new Map<string, string>();

  /**
   * One pass: `reconcile()`, then the fill poll, then the residual-protection
   * sweep.
   *
   * `reconcile()` runs FIRST and in its OWN try/catch — the same
   * "before every ingest" ordering `runStartupReconcile` establishes at
   * startup, repeated on cadence so a lost ack between polls does not sit
   * unrecovered until the next restart. Caught independently of
   * `ingestFills()` so a reconcile failure cannot block or mask that pass's
   * ingest.
   *
   * The sweep runs in a `finally` — even when the poll itself failed, and
   * ESPECIALLY then: a residual whose re-arm the failed poll never confirmed
   * is exactly the durable marker it retries. Its own failure is contained
   * to a log line so it cannot mask the poll's error or add a second failure
   * mode to a loop whose posture is log-and-poll-again.
   */
  const runPoll = async (): Promise<void> => {
    try {
      const report = await deps.execution.reconcile();
      const reportedThisPass = new Set<string>();
      for (const divergence of report.divergences) {
        const dedupKey = divergence.idempotency_key || divergence.instrument;
        reportedThisPass.add(dedupKey);
        const dedupState = reconcileDedupState(divergence);
        // Repeat pass, same state: already logged — see `lastReconcileAction`
        if (lastReconcileAction.get(dedupKey) === dedupState) continue;
        lastReconcileAction.set(dedupKey, dedupState);
        deps.logger.log({
          trace_id: deps.reconcileTraceId,
          stage: 'execution',
          event: 'reconcile_divergence',
          level: reconcileDivergenceLevel(divergence),
          message: 'reconcile divergence',
          payload: { ...divergence },
        });
      }
      for (const key of lastReconcileAction.keys()) {
        if (!reportedThisPass.has(key)) lastReconcileAction.delete(key);
      }
      // Same trace `runStartupReconcile` logs above — the sweep is not a
      // divergence and runs on every pass, so it needs its own
      // operator-visible line, logged only when it deleted something
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
          const dedupState = reconcileDedupState(divergence);
          // Repeat pass, same state: already logged — see `lastSweepAction`
          if (lastSweepAction.get(divergence.idempotency_key) === dedupState) continue;
          lastSweepAction.set(divergence.idempotency_key, dedupState);
          deps.logger.log({
            trace_id: deps.fillSyncTraceId,
            stage: 'execution',
            event: 'residual_sweep_divergence',
            // Deliberately its own plain 2-way split, not
            // `reconcileDivergenceLevel()`: that function never demotes a
            // sweep row anyway (`kind !== 'bracket'`), so this agrees with it
            // on every case without calling it a second time
            level: divergence.action === 'undetermined' ? 'warn' : 'info',
            message: 'residual-protection sweep divergence',
            payload: { ...divergence },
          });
        }
        for (const key of lastSweepAction.keys()) {
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

      // Runs AFTER the ingest+sweep in the same `finally` — even when the
      // poll failed, since the lots it reports are exactly the ones a failed
      // poll did not retire. Its own failure is contained to a log line, same
      // posture as the sweep's
      try {
        await deps.reportCarriedLots?.();
      } catch (carriedLotError) {
        deps.logger.log({
          trace_id: deps.fillSyncTraceId,
          stage: 'execution',
          event: 'carried_lot_report_failed',
          level: 'error',
          message: 'carried-lot report failed',
          payload: { error: describeThrownSafely(carriedLotError) },
        });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    // Belt-and-braces against re-entry: `schedule()` already re-arms only
    // after the previous pass settles, but the guard keeps that invariant
    // local to the thing it protects rather than resting on the caller
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
      // failure signal
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
      // `runOnce` swallows its own errors, so this only ever waits
      await inFlight;
    },
  };
}
