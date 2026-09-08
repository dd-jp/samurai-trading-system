/**
 * Trade-channel adapter for the threshold-clamp trip alert (#766) — the
 * thirteenth outbound operator escalation.
 *
 * Same shape as `TradeChannelTraderDiagnosticAlert`: wrap the
 * already-provisioned Telegram client rather than introduce a second
 * integration, post to the ESCALATION chat (never the heartbeat chat, #342),
 * and fire-and-forget since the port is synchronous — mirroring
 * `TradeChannelBreachAlert`'s reasoning, this is a rare, severe event and the
 * page must not be able to block the catch it was raised from.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type {
  ThresholdClampAlert,
  ThresholdClampAlertChannel,
} from './production/threshold-clamp-alert.js';
import type { Logger } from './types.js';

const WHERE_LABEL: Record<ThresholdClampAlert['where'], string> = {
  'live-read':
    'the live risk_thresholds read (RiskManagerImpl.evaluate, every tick) — new entries are ' +
    'refused; exits and the flat-by-close flatten do not consult this table and are unaffected',
  'daily-kill-line-check':
    "the daily feedback cycle's kill-line check (computeMetrics) — the cycle stopped " +
    'completing; the four kill-lines are unevaluated until the offending row is fixed',
};

/**
 * The stage each seam's own lines already carry, so the failed-send line files
 * beside them (#1280). Mirrors `WHERE_LABEL` rather than hardcoding `'risk'`:
 * the daily seam runs in `runFeedbackCycle`, whose `feedback_cycle_failed`
 * catch — the very catch that raises this alert — logs `stage: 'feedback-loop'`.
 * Same reasoning `TradeChannelExitValuationAlert` records for its `alert.seam`.
 */
const WHERE_STAGE: Record<ThresholdClampAlert['where'], string> = {
  'live-read': 'risk',
  'daily-kill-line-check': 'feedback-loop',
};

function formatThresholdClampAlert(alert: ThresholdClampAlert): string {
  return (
    `Samurai THRESHOLD CLAMP TRIPPED: ${WHERE_LABEL[alert.where]}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    `Refusal: ${alert.message}\n` +
    'An out-of-bound risk threshold was REFUSED rather than applied (#638) — this is fail-' +
    'closed on trading, not a live risk exposure. Fix the offending risk_thresholds row.'
  );
}

export class TradeChannelThresholdClampAlert implements ThresholdClampAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    this.#telegram = telegram;
    this.#chatId = chatId;
    this.#logger = logger;
  }

  postThresholdClampAlert(alert: ThresholdClampAlert): void {
    const text = formatThresholdClampAlert(alert);
    void this.#telegram.sendMessage(this.#chatId, text).catch((error: unknown) => {
      // The one alert whose failure to send must itself stay visible — see
      // `TradeChannelBreachAlert`'s identical reasoning.
      this.#logger.log({
        // The seam's own id, threaded on the alert (#1280), so this line joins
        // whichever catch raised it — the tick's `risk_log` row on the
        // live-read seam, the `feedback-cycle` lines on the daily one — rather
        // than a third taxonomy joining neither.
        trace_id: alert.trace_id,
        stage: WHERE_STAGE[alert.where],
        event: 'threshold_clamp_alert_send_failed',
        level: 'error',
        message: 'threshold-clamp alert failed to send — the clamp trip still stands',
        payload: {
          where: alert.where,
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
