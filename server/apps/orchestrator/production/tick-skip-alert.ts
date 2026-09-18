import {
  describeThrownSafely,
  escalatesAt,
  type Logger,
  sanitizeLogText,
} from '../../../shared/index.js';

export interface TickSkipAlert {
  skipped: number;
  planned: number;
  skipped_instruments: readonly string[];
  consecutive_ticks: number;
  reported_at: Date;
}

export interface TickSkipAlertChannel {
  postTickSkipAlert(alert: TickSkipAlert): Promise<void>;
}

export const TICK_SKIP_ALERT_MIN_INSTRUMENTS = 3;

export const TICK_SKIP_ALERT_FRACTION = 0.5;

export function isMateriallyDegraded(skipped: number, planned: number): boolean {
  if (planned <= 0) return false;
  return (
    skipped >= TICK_SKIP_ALERT_MIN_INSTRUMENTS && skipped >= planned * TICK_SKIP_ALERT_FRACTION
  );
}

export const ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS = 1;

export const ALERT_REPEAT_EVERY_DEGRADED_TICKS = 8;

const DEGRADED_TICK_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS,
  every: ALERT_REPEAT_EVERY_DEGRADED_TICKS,
};

function shouldAlertAt(consecutive: number): boolean {
  return escalatesAt(consecutive, DEGRADED_TICK_CADENCE);
}

export class TickSkipThrottle {
  #consecutive = 0;

  observe(degraded: boolean): { alert: boolean; consecutive: number } {
    if (!degraded) {
      this.#consecutive = 0;
      return { alert: false, consecutive: 0 };
    }
    this.#consecutive += 1;
    return { alert: shouldAlertAt(this.#consecutive), consecutive: this.#consecutive };
  }
}

export interface ReportTickSkipParams {
  skipped: readonly string[];
  planned: number;
  reportedAt: Date;
}

export async function reportTickSkip(
  throttle: TickSkipThrottle,
  channel: TickSkipAlertChannel | undefined,
  logger: Logger | undefined,
  params: ReportTickSkipParams,
): Promise<void> {
  const degraded = isMateriallyDegraded(params.skipped.length, params.planned);
  const { alert, consecutive } = throttle.observe(degraded);
  if (!alert || channel === undefined) return;

  const tickSkipAlert: TickSkipAlert = {
    skipped: params.skipped.length,
    planned: params.planned,
    skipped_instruments: params.skipped,
    consecutive_ticks: consecutive,
    reported_at: params.reportedAt,
  };

  try {
    await channel.postTickSkipAlert(tickSkipAlert);
  } catch (error) {
    logger?.log({
      trace_id: 'tick-skip',
      stage: 'tick-loop',
      event: 'tick_skip_alert_send_failed',
      level: 'error',
      message:
        'tick-skip alert could not be delivered — a materially degraded pass is still ' +
        'happening and nobody has been told',
      payload: {
        skipped: tickSkipAlert.skipped,
        planned: tickSkipAlert.planned,
        consecutive_ticks: consecutive,
        error: sanitizeLogText(describeThrownSafely(error)),
      },
    });
  }
}
