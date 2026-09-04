/**
 * Trade-channel adapter for the market-intelligence degraded-coverage alert
 * (#752) — the twelfth outbound operator escalation. Same shape as
 * `TradeChannelAnalystSkipAlert`: wrap the already-provisioned Telegram (and
 * optional Discord) client, and post to the ESCALATION chat, never the
 * heartbeat chat (#342) — a coverage gap is a decision waiting on the
 * operator (does GDELT need to land sooner than planned?), not a beat.
 *
 * What it replaces on that path is `LoggingMiCoverageAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `warn` —
 * fine for a supervised run, and not reachable from a phone, which is exactly
 * what criterion 6 of #752 requires this channel NOT be.
 *
 * A failed post rejects rather than being swallowed; `checkMiCoverage`
 * (production/mi-coverage.ts) catches and logs it, so the tick still returns
 * its answer and the undelivered alert is on the record.
 */
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import type { MiCoverageAlert, MiCoverageAlertChannel } from './production/mi-coverage.js';

function formatMiCoverageAlert(alert: MiCoverageAlert): string {
  return (
    `Samurai MARKET-INTELLIGENCE COVERAGE DEGRADED: ${alert.instrument} ` +
    `(${alert.asset_class}, subclass=${alert.subclass}) has no scored intelligence item inside ` +
    `the staleness window as of ${alert.reported_at.toISOString()}.\n` +
    'The debate is still running on this name — coverage is measured, never gated (ADR-0016 ' +
    "D2) — but the desk is narrowed by one analyst's worth of evidence until this clears. " +
    'This is a PER-TICKER gap: the macro layers (GDELT, Polymarket) file class-wide items ' +
    'under macro series names on purpose, so they never clear it. See the coverage section of ' +
    'docs/specs/market-intelligence-spec.md for which sources can cover a ticker and what to ' +
    'check when one stops.'
  );
}

export class TradeChannelMiCoverageAlert implements MiCoverageAlertChannel {
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

  async postCoverageAlert(alert: MiCoverageAlert): Promise<void> {
    const text = formatMiCoverageAlert(alert);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
