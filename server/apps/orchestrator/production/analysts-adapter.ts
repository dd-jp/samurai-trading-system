import type {
  AnalystFailure,
  AnalystOrchestrator,
  AssetClass,
} from '../../../pipeline/analysts/index.js';
import {
  describeThrownSafely,
  escalatesAt,
  type Logger,
  sanitizeLogText,
} from '../../../shared/index.js';
import { type AnalystSkipKindRelay, skipKindOf } from '../analysts-decision.js';
import type { TickSteps } from '../types.js';
import { type CheckMiCoverageDeps, checkMiCoverage } from './mi-coverage.js';

export interface AnalystSkipAlert {
  instrument: string;
  consecutive_skips: number;
  failures: AnalystFailure[];
  reported_at: Date;
}

export interface AnalystSkipAlertChannel {
  postAnalystSkipAlert(alert: AnalystSkipAlert): Promise<void>;
}

export const ALERT_AFTER_CONSECUTIVE_SKIPS = 2;

export const ALERT_REPEAT_EVERY_SKIPS = 8;

export interface AnalystsStepOptions {
  skipAlerts?: AnalystSkipAlertChannel;
  marketIntelligence?: MarketIntelligenceRefresh;
  coverage?: CheckMiCoverageDeps;
  skipKinds?: AnalystSkipKindRelay;
}

export interface MarketIntelligenceRefresh {
  refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean>;
}

export function composeMarketIntelligence(
  agents: readonly (MarketIntelligenceRefresh | undefined)[],
): MarketIntelligenceRefresh | undefined {
  const present = agents.filter((agent): agent is MarketIntelligenceRefresh => agent !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  return {
    async refresh(trace_id, instrument, assetClass) {
      let refreshed = false;
      for (const agent of present) {
        try {
          if (await agent.refresh(trace_id, instrument, assetClass)) refreshed = true;
        } catch {
        }
      }
      return refreshed;
    },
  };
}

export function buildAnalystsStep(
  orchestrator: AnalystOrchestrator,
  logger?: Logger,
  options: AnalystsStepOptions = {},
): TickSteps['analysts'] {
  const consecutiveSkips = new Map<string, number>();

  return async ({ trace_id, signal, clock, bar }) => {
    await options.marketIntelligence?.refresh(trace_id, signal.asset, signal.asset_class);

    if (options.coverage !== undefined) {
      await checkMiCoverage(options.coverage, {
        trace_id,
        instrument: signal.asset,
        assetClass: signal.asset_class,
        reportedAt: clock.now(),
      });
    }

    const result = await orchestrator.runAnalysts(trace_id, signal, clock, bar);

    logAnalystFailures(logger, trace_id, signal.asset, result.failures);

    const skipKind = skipKindOf(result.skipped, result.failures);
    if (skipKind !== undefined) {
      options.skipKinds?.set(trace_id, skipKind);
    }

    await recordSkipOutcome(
      consecutiveSkips,
      options,
      logger,
      trace_id,
      signal.asset,
      result,
      clock,
    );

    return result.views;
  };
}

function logAnalystFailures(
  logger: Logger | undefined,
  trace_id: string,
  instrument: string,
  failures: readonly AnalystFailure[],
): void {
  if (logger === undefined || failures.length === 0) return;

  const mandatoryFailed = failures.some((failure) => failure.role === 'mandatory');
  const safe = failures.map((failure) => ({
    analyst_type: failure.analyst_type,
    role: failure.role,
    reason: sanitizeLogText(failure.reason),
    kind: failure.kind,
  }));
  const detail = safe
    .map((failure) => `${failure.analyst_type} (${failure.role}): ${failure.reason}`)
    .join('; ');
  logger.log({
    trace_id,
    stage: 'analysts',
    event: 'analyst_panel_degraded',
    level: mandatoryFailed ? 'error' : 'warn',
    message: mandatoryFailed
      ? `analysts: ${instrument} quorum NOT met — mandatory analyst failed, no trade is ` +
        `possible this tick: ${detail}`
      : `analysts: ${instrument} optional analyst failed, tick continues on a smaller ` +
        `panel: ${detail}`,
    payload: { instrument, failures: safe },
  });
}

async function recordSkipOutcome(
  consecutiveSkips: Map<string, number>,
  options: AnalystsStepOptions,
  logger: Logger | undefined,
  trace_id: string,
  instrument: string,
  result: { skipped: boolean; failures: readonly AnalystFailure[] },
  clock: { now(): Date },
): Promise<void> {
  if (!result.skipped) {
    consecutiveSkips.delete(instrument);
    return;
  }

  const count = (consecutiveSkips.get(instrument) ?? 0) + 1;
  consecutiveSkips.set(instrument, count);
  if (!shouldAlertAt(count)) return;

  await postSkipAlert(options.skipAlerts, logger, trace_id, {
    instrument,
    consecutive_skips: count,
    failures: result.failures.map((failure) => ({
      analyst_type: failure.analyst_type,
      role: failure.role,
      reason: sanitizeLogText(failure.reason),
      kind: failure.kind,
    })),
    reported_at: clock.now(),
  });
}

const SKIP_CADENCE = { after: ALERT_AFTER_CONSECUTIVE_SKIPS, every: ALERT_REPEAT_EVERY_SKIPS };

function shouldAlertAt(consecutiveSkips: number): boolean {
  return escalatesAt(consecutiveSkips, SKIP_CADENCE);
}

async function postSkipAlert(
  channel: AnalystSkipAlertChannel | undefined,
  logger: Logger | undefined,
  trace_id: string,
  alert: AnalystSkipAlert,
): Promise<void> {
  if (channel === undefined) return;
  try {
    await channel.postAnalystSkipAlert(alert);
  } catch (error) {
    logger?.log({
      trace_id,
      stage: 'analysts',
      event: 'analyst_skip_alert_send_failed',
      level: 'error',
      message:
        'analyst consecutive-skip alert could not be delivered — the analyst stage is still ' +
        'skipping and nobody has been told',
      payload: {
        instrument: alert.instrument,
        consecutive_skips: alert.consecutive_skips,
        error: sanitizeLogText(describeThrownSafely(error)),
      },
    });
  }
}
