/**
 * Trade-channel adapter for the calendar-fetch-fallback alert (#684) — the
 * sixteenth outbound operator escalation.
 *
 * Same shape as `TradeChannelThresholdClampAlert`: wrap the
 * already-provisioned Telegram client, post to the ESCALATION chat (never
 * the heartbeat chat, #342), fire-and-forget since the port is synchronous.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type {
  CalendarFallbackAlert,
  CalendarFallbackAlertChannel,
} from './production/calendar-fallback-alert.js';
import type { Logger } from './types.js';

function formatCalendarFallbackAlert(alert: CalendarFallbackAlert): string {
  return (
    `Samurai CALENDAR FETCH FAILED: the paper equity leg could not fetch Alpaca's ` +
    `GET /v2/calendar at boot, and fell back to the hand-entered session table.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    `Fetch error: ${alert.reason}\n` +
    `Fallback table is checked through ${alert.fallback_coverage_end} — a date past that will ` +
    'THROW rather than silently assume a normal close (#684). Verify Alpaca connectivity; ' +
    'the run continues on the hand table until a restart re-fetches the live one.'
  );
}

export class TradeChannelCalendarFallbackAlert implements CalendarFallbackAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    this.#telegram = telegram;
    this.#chatId = chatId;
    this.#logger = logger;
  }

  postCalendarFallbackAlert(alert: CalendarFallbackAlert): void {
    const text = formatCalendarFallbackAlert(alert);
    void this.#telegram.sendMessage(this.#chatId, text).catch((error: unknown) => {
      // The one alert whose failure to send must itself stay visible — see
      // `TradeChannelThresholdClampAlert`'s identical reasoning.
      this.#logger.log({
        trace_id: 'calendar-fallback',
        stage: 'orchestrator',
        event: 'calendar_fallback_alert_send_failed',
        level: 'error',
        message: 'calendar-fallback alert failed to send — the fallback still stands',
        payload: {
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
