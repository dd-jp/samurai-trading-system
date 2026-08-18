/**
 * Trade-channel adapter for the degraded-exit-valuation alert (#841) — the
 * fifteenth outbound operator escalation.
 *
 * Same shape as `TradeChannelThresholdClampAlert`: wrap the
 * already-provisioned Telegram client rather than introduce a second
 * integration, post to the ESCALATION chat (never the heartbeat chat, #342),
 * and fire-and-forget since the port is synchronous — the page must not be
 * able to block the exit it was raised beside, which is the whole point of
 * degrading rather than refusing.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import type {
  ExitValuationDegradedAlert,
  ExitValuationDegradedAlertChannel,
} from './production/exit-valuation-alert.js';
import type { Logger } from './types.js';

const SEAM_LABEL: Record<ExitValuationDegradedAlert['seam'], string> = {
  risk: 'the Risk stage (sizing and recording the exit)',
  verdict: "the Verdict stage (gate 5's fire-time breaker re-check)",
};

function formatExitValuationDegradedAlert(alert: ExitValuationDegradedAlert): string {
  return (
    `Samurai EXIT PRICED ON A PARTLY-VALUED BOOK: ${alert.instrument} at ` +
    `${SEAM_LABEL[alert.seam]}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    `Held instruments that could NOT be valued: ${alert.unvalued_instruments.join(', ')}.\n` +
    `Why: ${alert.reason}\n` +
    'The exit was NOT suppressed (#841, ADR-0014 flat-by-close) — it proceeded, and the ' +
    'portfolio figures in risk_log for this trace exclude the names above, so they understate ' +
    'exposure and drawdown. NEW ENTRIES are still refused while the book cannot be fully ' +
    'valued. Check the market-data feed for the named instruments.'
  );
}

export class TradeChannelExitValuationDegradedAlert implements ExitValuationDegradedAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    this.#telegram = telegram;
    this.#chatId = chatId;
    this.#logger = logger;
  }

  postExitValuationDegradedAlert(alert: ExitValuationDegradedAlert): void {
    const text = formatExitValuationDegradedAlert(alert);
    void this.#telegram.sendMessage(this.#chatId, text).catch((error: unknown) => {
      // A failed send must itself stay visible — see `TradeChannelBreachAlert`
      // and `TradeChannelThresholdClampAlert` for the identical reasoning.
      this.#logger.log({
        trace_id: 'exit-valuation-degraded',
        stage: 'risk',
        level: 'error',
        message:
          'exit-valuation-degraded alert failed to send — an exit was priced on a partly-' +
          'valued book and nobody has been told',
        payload: {
          instrument: alert.instrument,
          seam: alert.seam,
          unvalued_instruments: alert.unvalued_instruments,
          reported_at: alert.reported_at.toISOString(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }
}
