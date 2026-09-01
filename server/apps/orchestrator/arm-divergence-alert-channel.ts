/**
 * Trade-channel adapter for the arm-divergence alert (#971, #913) — the
 * seventeenth outbound operator escalation.
 *
 * Same shape as `TradeChannelCalendarFallbackAlert`: wrap the already-provisioned
 * Telegram client, post to the ESCALATION chat (never the heartbeat chat, #342),
 * fire-and-forget since the port is synchronous. #913 asked for the divergence
 * alert to reach "the existing trade channel" — this is that channel, reached
 * through the compiler-enforced `AlertChannelSlots`/`ALERT_CHANNEL_FIELDS`
 * mechanism rather than bolted on beside it. No new transport is introduced: the
 * destination is the same escalation chat every other alert on that list uses.
 *
 * It is a slot of its own rather than a reuse of `breachAlerts` for the reason
 * `ArmDivergenceAlertChannel`'s own doc gives: the breach formatter states
 * "KILL-THRESHOLD BREACH … thresholds auto-tightened", and routing divergence
 * through `MetricsReport.breaches` would ALSO auto-tighten every risk threshold —
 * a live-arm-only sizing change that degrades the very matching the comparison
 * rests on.
 */
import type {
  ArmDivergenceAlert,
  ArmDivergenceAlertChannel,
} from '../../pipeline/feedback-loop/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import type { Logger } from './types.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Both arms, both columns, on one line each — the same D4 discipline
 * `formatArmComparison` holds at the CLI surface: there is no branch here that
 * prints a return without the drawdown beside it.
 *
 * The convergence caveat travels with the alert, not only with the dashboard
 * panel and the spec. The control arm is always treated as decided
 * (`converged: true`), so on a non-converging stretch the live arm takes a size
 * haircut the control does not — which can itself PRODUCE this alert. An
 * operator acting on a phone notification has to see that in the same message.
 */
export function formatArmDivergenceAlert(alert: ArmDivergenceAlert): string {
  const { live, control } = alert.comparison;
  return (
    'Samurai ARM DIVERGENCE: the matched control (falsifier arm 2) is out-performing the ' +
    'debate-driven live arm.\n' +
    `Window ${alert.comparison.from.toISOString()} → ${alert.comparison.to.toISOString()}, ` +
    `basis £${alert.comparison.basis.toFixed(2)} (the same denominator for both arms).\n` +
    `live:    ${live.trade_count} trade(s), return ${pct(live.return_pct)}, ` +
    `max drawdown ${pct(live.max_drawdown_pct)}\n` +
    `control: ${control.trade_count} trade(s), return ${pct(control.return_pct)}, ` +
    `max drawdown ${pct(control.max_drawdown_pct)}\n` +
    `Why this fired: ${alert.reason}.\n` +
    'Read both columns together — doc 12 D4 rules out a return-only reading against a ' +
    'risk-targeted stream.\n' +
    'ONE KNOWN ASYMMETRY: the control has no debate rounds, so it is always treated as ' +
    'converged. On bars where the live debate did not converge, the live arm takes a size ' +
    'haircut and refuses a scale-in and the control takes neither — a non-converging stretch ' +
    'can produce this reading on its own.\n' +
    `Detected ${alert.reported_at.toISOString()}. Nothing was auto-tightened: this is a ` +
    'measurement, not a kill-line breach.'
  );
}

export class TradeChannelArmDivergenceAlert implements ArmDivergenceAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    this.#telegram = telegram;
    this.#chatId = chatId;
    this.#logger = logger;
  }

  postArmDivergenceAlert(alert: ArmDivergenceAlert): void {
    const text = formatArmDivergenceAlert(alert);
    void this.#telegram.sendMessage(this.#chatId, text).catch((error: unknown) => {
      // Same reasoning as `TradeChannelCalendarFallbackAlert`: an escalation
      // that failed to send must itself stay visible in the log stream.
      this.#logger.log({
        trace_id: 'arm-divergence',
        stage: 'feedback-loop',
        level: 'error',
        message: 'arm-divergence alert failed to send — the divergence still stands',
        payload: {
          reported_at: alert.reported_at.toISOString(),
          reason: alert.reason,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }
}
