/**
 * Trade-channel adapter for the orphaned go-verdict alert (#209) — the third
 * of the three outbound operator alerts, and the one that had no reachable
 * implementation until #322.
 *
 * `TradeChannelHeartbeat` (heartbeat-channel.ts) and
 * `TradeChannelUnpricedFillAlert` (unpriced-fill-channel.ts) already made this
 * exact move for their own alert types: reuse Verdict's already-provisioned
 * Telegram transport rather than introduce a second integration, and
 * wrap the raw clients rather than route through `TradeChannelNotifier.notify`,
 * which is shaped for a `VerdictDecision` and not for an operational anomaly.
 * This file exists because the composition root needed all three to wire a
 * genuinely unattended run (#238) and only two of them existed.
 *
 * What it replaces on that path is `LoggingOrphanAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `error` —
 * fine for a supervised run, and not an alert at all at 3am.
 *
 * Discord is optional and mirrors the other two adapters' shape: both are
 * attempted together, so a Telegram outage does not silence the Discord copy.
 *
 * A failed post rejects rather than being swallowed. `OrphanVerdictScanner.scan`
 * catches per orphan and logs the failure (orphan-verdict-scan.ts), so the
 * scan still reports the rest — swallowing here would delete that record and
 * leave an orphan that looks alerted-on when it was not.
 */
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import type { OrphanAlertChannel, OrphanGoVerdict } from './orphan-verdict-scan.js';

/**
 * Composed from the orphan's own four fields, all of which the recipient needs:
 * `idempotency_key` is the client order id the venue knows the trade by (the
 * reason `OrphanGoVerdict` carries it at all — the scan matches on `trace_id`),
 * and `trace_id` is what finds the pass in `audit_log`/`verdict_log`.
 */
function formatOrphanAlert(orphan: OrphanGoVerdict): string {
  return (
    `Samurai ORPHANED GO VERDICT: a 'go' for ${orphan.instrument} was recorded at ` +
    `${orphan.verdict_timestamp.toISOString()} with no matching execution record — this ` +
    'process died between Verdict and Execution.\n' +
    `Client order id ${orphan.idempotency_key}, trace ${orphan.trace_id}.\n` +
    'An order may or may not have reached the venue, and nothing resubmits or cancels it ' +
    'automatically. Check the venue for that client order id and reconcile it by hand.'
  );
}

export class TradeChannelOrphanAlert implements OrphanAlertChannel {
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

  async postOrphanAlert(orphan: OrphanGoVerdict): Promise<void> {
    const text = formatOrphanAlert(orphan);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
