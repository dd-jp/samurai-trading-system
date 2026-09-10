/**
 * Trade-channel adapter for a Trader diagnostic (#698) — the eleventh outbound
 * operator escalation.
 *
 * Same shape as `TradeChannelAnalystSkipAlert`: wrap the already-provisioned
 * Telegram client rather than introduce a second integration, and post to the
 * ESCALATION chat, never the heartbeat chat (#342). A Trader that has stopped
 * being able to trust its calendar is a decision waiting on the operator, not a
 * beat.
 *
 * Unlike the other ten channels this one has NO `Logging…Channel` counterpart,
 * and must not grow one: `postTraderDiagnosticAlert` (direct-bind.ts) writes
 * every diagnostic to the log at `error` BEFORE it consults this port at all,
 * so a log-only implementation would emit each condition twice. The port's own
 * docblock (production/trader-diagnostic-alert.ts) is where that decision is
 * recorded. What an absent channel costs is the audible copy — the thing that
 * reaches somebody at 3am on day 9 of a fourteen-day soak — never the record.
 *
 * A failed post rejects rather than being swallowed; `buildTraderStep` catches
 * and logs it, so the tick still returns its decision and the undelivered alert
 * is on the record.
 */
import type {
  TraderDiagnosticAlert,
  TraderDiagnosticAlertChannel,
} from './production/trader-diagnostic-alert.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * What each kind means in one line, and what it costs while it persists.
 *
 * Spelled out per kind rather than left to the `detail` string because the
 * operator's first question is "do I have to do something about this tonight",
 * and the answer differs sharply: a stale calendar means the book is parked and
 * nothing will trade until it is fixed, while a non-finite ATR means one
 * instrument is skipping on bad data while the rest of the run continues.
 */
const CONSEQUENCE: Record<TraderDiagnosticAlert['diagnostic']['kind'], string> = {
  session_end_in_past:
    'The calendar resolved a close that has already passed, so the book is being parked FLAT ' +
    'and no new position will be opened for this leg while that persists. A run in this state ' +
    'looks identical to a quiet market.',
  session_end_absent_on_non_crypto:
    'A non-crypto calendar returned no session end at all, so flat-by-close (ADR-0014) cannot ' +
    'be enforced for this leg — a position opened on it may be carried overnight.',
  atr_not_finite:
    'ATR was not finite on a FULL bar window, which means corrupt market data rather than a ' +
    'warm-up gap. This instrument cannot price a stop and is skipping every tick.',
  control_arm_valuation_refused:
    'The control arm (#753 falsifier arm 2) could not value its shadow book and skipped this ' +
    'pass instead of crashing it. The live arm is unaffected, but a control that keeps skipping ' +
    'cannot answer the debate-beats-indicators question at the end of the soak (#1089).',
};

function formatTraderDiagnosticAlert(alert: TraderDiagnosticAlert): string {
  const { diagnostic } = alert;
  // `asset_class` is `undefined` for exactly `control_arm_valuation_refused`
  // (see `TraderDiagnostic.asset_class`'s own doc) — it fires before the mark
  // read that would otherwise resolve one, so the parenthetical is omitted
  // rather than rendering the literal string "undefined".
  const assetClassSuffix =
    diagnostic.asset_class === undefined ? '' : ` (${diagnostic.asset_class})`;
  return (
    `Samurai TRADER DEGRADED: ${alert.instrument}${assetClassSuffix} reported ` +
    `${diagnostic.kind} on ${alert.consecutive_ticks} consecutive tick(s) as of ` +
    `${alert.reported_at.toISOString()}.\n` +
    `${CONSEQUENCE[diagnostic.kind]}\n` +
    `Detail: ${diagnostic.detail}\n` +
    'The Trader is still running and still returning decisions, so this will not show up as ' +
    'downtime and the heartbeat will keep beating.'
  );
}

export class TradeChannelTraderDiagnosticAlert
  extends TradeChannelAlert
  implements TraderDiagnosticAlertChannel
{
  async postTraderDiagnosticAlert(alert: TraderDiagnosticAlert): Promise<void> {
    await this.send(formatTraderDiagnosticAlert(alert));
  }
}
