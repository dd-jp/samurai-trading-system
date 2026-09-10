/**
 * Trade-channel adapter for the LSE table coverage-horizon alert (#1378).
 *
 * Same shape as `TradeChannelCalendarFallbackAlert`: wrap the
 * already-provisioned Telegram client, post to the ESCALATION chat (never
 * the heartbeat chat, #342), fire-and-forget since the port is synchronous.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type {
  LseCalendarCoverageAlert,
  LseCalendarCoverageAlertChannel,
} from './production/lse-calendar-coverage-alert.js';
import { TradeChannelAlert } from './trade-channel.js';
import type { Logger } from './types.js';

function formatLseCalendarCoverageAlert(alert: LseCalendarCoverageAlert): string {
  return (
    'Samurai LSE CALENDAR COVERAGE ENDING SOON: the LIVE equity leg runs on ' +
    `LseRegularHoursCalendar's hand-entered tables, checked through ${alert.coverage_end}.\n` +
    `${alert.days_remaining} day(s) remaining as of ${alert.reported_at.toISOString()}.\n` +
    'Extend LSE_HOLIDAYS/LSE_HALF_DAYS (trading-calendar.ts) before that date — boot will ' +
    'REFUSE to start the live leg once it passes, naming the date and what to extend.'
  );
}

export class TradeChannelLseCalendarCoverageAlert
  extends TradeChannelAlert
  implements LseCalendarCoverageAlertChannel
{
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    super(telegram, chatId);
    this.#logger = logger;
  }

  postLseCalendarCoverageAlert(alert: LseCalendarCoverageAlert): void {
    const text = formatLseCalendarCoverageAlert(alert);
    this.sendDetached(text, (error: unknown) => {
      // The one alert whose failure to send must itself stay visible — see
      // `TradeChannelCalendarFallbackAlert`'s identical reasoning.
      this.#logger.log({
        trace_id: 'lse-calendar-coverage',
        stage: 'orchestrator',
        event: 'lse_calendar_coverage_alert_send_failed',
        level: 'error',
        message: 'LSE calendar coverage-horizon alert failed to send — the horizon still stands',
        payload: {
          coverage_end: alert.coverage_end,
          days_remaining: alert.days_remaining,
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
