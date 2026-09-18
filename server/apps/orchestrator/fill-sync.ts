import type {
  ReconcileDivergence,
  ReconcileReport,
  ResidualProtectionSweepResult,
} from '../../pipeline/execution/index.js';
import type { Clock, LogLevel } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { Logger } from './types.js';

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

function reconcileDedupState(divergence: ReconcileDivergence): string {
  return divergence.escalation
    ? `${divergence.action}:${divergence.escalation}`
    : divergence.action;
}

export const FILL_SYNC_RECONCILE_FAILED = 'periodic reconcile failed' as const;
export const FILL_SYNC_SWEEP_FAILED = 'residual-protection sweep failed' as const;
export const FILL_SYNC_POLL_FAILED = 'fill poll failed' as const;

export interface FillSyncSurface {
  reconcile(): Promise<ReconcileReport>;
  ingestFills(): Promise<void>;
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}

export interface FillSyncDeps {
  execution: FillSyncSurface;
  clock: Clock;
  logger: Logger;
  fillPollIntervalMs: number;
  reconcileTraceId: string;
  fillSyncTraceId: string;
  reportCarriedLots?: () => Promise<void>;
}

export const FILL_SYNC_TRACE_ID = 'fill-sync';
export const RECONCILE_TRACE_ID = 'reconcile';

export async function runStartupReconcile(deps: {
  execution: FillSyncSurface;
  logger: Logger;
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

export function startFillSync(deps: FillSyncDeps): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let handle: NodeJS.Timeout | undefined;
  const lastSweepAction = new Map<string, string>();
  const lastReconcileAction = new Map<string, string>();

  function logDedupedDivergences(
    divergences: readonly ReconcileDivergence[],
    lastAction: Map<string, string>,
    dedupKey: (divergence: ReconcileDivergence) => string,
    logDivergence: (divergence: ReconcileDivergence) => void,
  ): void {
    const reportedThisPass = new Set<string>();
    for (const divergence of divergences) {
      const key = dedupKey(divergence);
      reportedThisPass.add(key);
      const dedupState = reconcileDedupState(divergence);
      if (lastAction.get(key) === dedupState) continue;
      lastAction.set(key, dedupState);
      logDivergence(divergence);
    }
    for (const key of lastAction.keys()) {
      if (!reportedThisPass.has(key)) lastAction.delete(key);
    }
  }

  const runPoll = async (): Promise<void> => {
    try {
      const report = await deps.execution.reconcile();
      logDedupedDivergences(
        report.divergences,
        lastReconcileAction,
        (divergence) => divergence.idempotency_key || divergence.instrument,
        (divergence) => {
          deps.logger.log({
            trace_id: deps.reconcileTraceId,
            stage: 'execution',
            event: 'reconcile_divergence',
            level: reconcileDivergenceLevel(divergence),
            message: 'reconcile divergence',
            payload: { ...divergence },
          });
        },
      );
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
        logDedupedDivergences(
          sweep.divergences,
          lastSweepAction,
          (divergence) => divergence.idempotency_key,
          (divergence) => {
            deps.logger.log({
              trace_id: deps.fillSyncTraceId,
              stage: 'execution',
              event: 'residual_sweep_divergence',
              level: divergence.action === 'undetermined' ? 'warn' : 'info',
              message: 'residual-protection sweep divergence',
              payload: { ...divergence },
            });
          },
        );
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
      await inFlight;
    },
  };
}
