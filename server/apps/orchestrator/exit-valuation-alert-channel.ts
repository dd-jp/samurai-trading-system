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
import { currentTraceId, describeThrownSafely } from '../../shared/index.js';
import type {
  ExitValuationDegradedAlert,
  ExitValuationDegradedAlertChannel,
} from './production/exit-valuation-alert.js';
import type { Logger } from './types.js';

const SEAM_LABEL: Record<ExitValuationDegradedAlert['seam'], string> = {
  risk: 'the Risk stage (sizing and recording the exit)',
  verdict: "the Verdict stage (gate 5's fire-time breaker re-check)",
  // #826 — the exit's OWN mark, one stage earlier than the other two.
  trader: 'the Trader stage (the exited instrument had no mark at all)',
};

/**
 * The headline and the consequence line, per seam.
 *
 * Varied rather than shared because the two conditions cost different things
 * and imply different reading of the record: #841's seams leave `risk_log`'s
 * portfolio figures understated, while #826's leaves the INTENT's own price
 * fields meaningless. One combined sentence would be wrong for whichever seam
 * fired.
 */
const SEAM_COPY: Record<
  ExitValuationDegradedAlert['seam'],
  { headline: string; namesLabel: string; consequence: string }
> = {
  risk: {
    headline: 'EXIT PRICED ON A PARTLY-VALUED BOOK',
    namesLabel: 'Held instruments that could NOT be valued',
    consequence:
      'The exit was NOT suppressed (#841, ADR-0014 flat-by-close) — it proceeded, and the ' +
      'portfolio figures in risk_log for this trace exclude the names above, so they understate ' +
      'exposure and drawdown. NEW ENTRIES are still refused while the book cannot be fully ' +
      'valued. Check the market-data feed for the named instruments.',
  },
  verdict: {
    headline: 'EXIT PRICED ON A PARTLY-VALUED BOOK',
    namesLabel: 'Held instruments that could NOT be valued',
    consequence:
      'The exit was NOT suppressed (#841, ADR-0014 flat-by-close) — it proceeded, and the ' +
      'portfolio figures in risk_log for this trace exclude the names above, so they understate ' +
      'exposure and drawdown. NEW ENTRIES are still refused while the book cannot be fully ' +
      'valued. Check the market-data feed for the named instruments.',
  },
  trader: {
    headline: 'MANDATORY FLATTEN SENT WITHOUT A MARK',
    namesLabel: 'Instrument whose mark could NOT be read',
    consequence:
      'The flat-by-close exit was NOT suppressed (#826, ADR-0014) — it proceeded as a market ' +
      'flatten sized to the held quantity, which needs no price. Its entry/stop/target are ' +
      'RECORDED AS ZERO and mean nothing; Verdict skipped its drift and stale-feed gates for ' +
      'this intent alone. Only the mandatory flatten degrades this way — every entry and every ' +
      'discretionary exit still fails loudly while the feed is down. Check the market-data feed ' +
      'for the named instrument.',
  },
};

function formatExitValuationDegradedAlert(alert: ExitValuationDegradedAlert): string {
  const copy = SEAM_COPY[alert.seam];
  return (
    `Samurai ${copy.headline}: ${alert.instrument} at ${SEAM_LABEL[alert.seam]}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    `${copy.namesLabel}: ${alert.unvalued_instruments.join(', ')}.\n` +
    `Why: ${alert.reason}\n` +
    copy.consequence
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
        // `reportExitValuationDegraded` (direct-bind.ts) already logs this
        // same failed exit under `context.trace_id`; this joins it instead of
        // a second, unjoinable taxonomy (#1183, #1280).
        trace_id: currentTraceId() ?? 'exit-valuation-degraded',
        // The seam that raised it, not a hardcoded `'risk'` — #826 added a
        // `trader` seam, and a line naming the wrong stage is worse than a
        // generic one when the operator is grepping for the feed fault.
        stage: alert.seam,
        event: 'exit_valuation_alert_send_failed',
        level: 'error',
        message:
          'exit-valuation-degraded alert failed to send — an exit was priced on a partly-' +
          'valued book (or, on the trader seam, sent with no mark at all) and nobody has ' +
          'been told',
        payload: {
          instrument: alert.instrument,
          seam: alert.seam,
          unvalued_instruments: alert.unvalued_instruments,
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
