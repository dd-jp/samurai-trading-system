/**
 * Trade-channel adapter for the flatten-reconcile-unresolved alert (#519) —
 * the same move `TradeChannelResidualExposureAlert` makes
 * (residual-exposure-alert-channel.ts): reuse Verdict's already-provisioned
 * Telegram transport rather than introduce a second integration,
 * and wrap the raw clients rather than route through
 * `TradeChannelNotifier.notify`, which is shaped for a `VerdictDecision` and
 * not for an operational anomaly.
 *
 * This is the implementation that makes #519's escalation reachable during
 * an UNATTENDED soak (#238): `LoggingFlattenReconcileAlertChannel` writes a
 * line nobody is tailing at 3am, whereas this one reaches a phone.
 * `SAMURAI_ALERTS=telegram` builds it over a `TelegramBotApiClient` at the
 * entrypoint (alert-transport.ts), and posts to the ESCALATION chat, never
 * the heartbeat chat (#342) — a flatten stuck in genuine ambiguity about
 * whether it is still held is a decision waiting on the operator, not a beat.
 *
 * Discord is optional and mirrors the shape every other adapter here takes:
 * both are attempted together, so a Telegram outage does not silence the
 * Discord copy.
 *
 * Control-arm alerts are dropped before either transport is touched
 * (#1349, `isControlArmTraceId` below) — reconcile() itself still logs every
 * arm's divergence unconditionally, so this only removes the page.
 */
import type {
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
} from '../../pipeline/execution/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';

/**
 * Composed only from the alert's own curated fields — see
 * `FlattenReconcileAlert`'s CREDENTIALS note for why that boundary is hard.
 *
 * Labelled with `trace_id` (#1349) — reading it to gate the page (see
 * `isControlArmTraceId` below) makes the surface it fires on available here
 * for free, and `FlattenReconcileAlert.trace_id`'s own "correlating two
 * lines" note is exactly the case this closes: the poll's `reconcile`/
 * `fill-sync` split otherwise has no operator-visible marker on the page
 * itself.
 */
function formatFlattenReconcileAlert(alert: FlattenReconcileAlert): string {
  return (
    `Samurai UNRESOLVED FLATTEN [${alert.trace_id}]: ${alert.instrument} (flatten ` +
    `${alert.idempotency_key}) could not be settled against the venue as of ` +
    `${alert.observed_at.toISOString()}.\n` +
    `${alert.reason}\n` +
    'Whether this position is still held is genuinely unknown. Check the order and the position ' +
    'on the venue by hand.'
  );
}

/**
 * `FlattenReconcileAlert.trace_id`'s documented contract: the control arm's
 * surfaces are the live arm's own id with this prefix, never a distinct
 * value set. DECISION (David, 2026-09-08, #1349): the control arm's broker
 * is `SimulatedBrokerAdapter`, which never throws and holds no venue — this
 * page's one instruction, "check the order on the venue by hand", cannot be
 * carried out for it, so every control-arm page is a false, unactionable
 * one that trains an operator to discount the live arm's real escalations.
 * The reconcile pass itself still logs unconditionally (fill-sync.ts's
 * `reconcile_divergence` line) — only the phone page is gated here.
 */
function isControlArmTraceId(traceId: string): boolean {
  return traceId.startsWith('control-arm-');
}

export class TradeChannelFlattenReconcileAlert implements FlattenReconcileAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;

  constructor(
    telegram: TelegramClient,
    telegramChatId: string,
    discord?: DiscordClient,
    discordChannelId?: string,
  ) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
    this.#discord = discord;
    this.#discordChannelId = discordChannelId;
  }

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    if (isControlArmTraceId(alert.trace_id)) return;

    const text = formatFlattenReconcileAlert(alert);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
