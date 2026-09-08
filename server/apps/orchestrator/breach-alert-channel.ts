/**
 * Trade-channel adapter for the Feedback Loop's kill-threshold breach alert
 * (#93, wired by #327) — the same move `TradeChannelUnpricedFillAlert` and
 * `TradeChannelHeartbeat` make: reuse Verdict's already-provisioned
 * Telegram transport rather than introduce a second integration, and
 * wrap the raw clients rather than route through `TradeChannelNotifier.notify`,
 * which is shaped for a `VerdictDecision` and not for a validation breach.
 *
 * This is what makes story 13's "alert the human" reachable during an
 * UNATTENDED soak (#238). `LoggingBreachAlertChannel` writes a line nobody is
 * tailing; this one reaches a phone.
 *
 * ## Why this one is fire-and-forget
 *
 * `BreachAlertChannel.postBreachAlert` returns `void`, not a promise — the
 * port is synchronous because `computeMetrics` is, and its own doc calls the
 * alert "fire-and-forget" (a breach expects no answer; the kill/rework call is
 * made later, out of band). So the send is started and not awaited, and its
 * rejection is caught here rather than left to surface as an unhandled
 * rejection that would take the process down mid-soak. A transport failure
 * must not undo the auto-tighten that already happened.
 *
 * The catch is deliberately best-effort and silent-to-the-caller, which is a
 * real limitation worth naming: if Telegram is down, the breach reaches
 * nobody. The mitigation is the log-line copy the orchestrator writes for
 * every cycle regardless (`daily metrics computed`), not a retry queue this
 * adapter does not have.
 */
import type { BreachAlert, BreachAlertChannel } from '../../pipeline/feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import { currentTraceId } from '../../shared/index.js';
import type { Logger } from './types.js';

/**
 * The breach id `SqliteSpendCap` posts through this port. Named rather than
 * repeated as a literal because `breachStage` and `classifyBreach`
 * discriminate on it.
 */
export const LLM_SPEND_CAP_BREACH = 'llm_spend_cap';

/**
 * The stage whichever caller raised the breach already logs under (#1280),
 * for the same reason `ThresholdClampAlert` gets a `WHERE_STAGE`: threading
 * the trace id made a single hardcoded stage wrong, because the two callers
 * sit in different stages. `SqliteSpendCap#refuse` (spend-cap.ts) logs its
 * sibling `llm_spend_cap_alert_send_failed` under `debate`; the daily
 * kill-line batch (`computeMetrics`) logs under `feedback-loop`.
 *
 * `breaches` discriminates soundly because the two producers are disjoint:
 * `detectBreaches` (metrics.ts) only ever pushes the four kill-line ids, and
 * the spend cap posts `[LLM_SPEND_CAP_BREACH]` alone (production.ts). `every`
 * rather than `includes` is the conservative read of a future mixed alert —
 * one kill-line breach in the list makes it the feedback cycle's.
 */
export function breachStage(alert: BreachAlert): string {
  return alert.breaches.every((breach) => breach === LLM_SPEND_CAP_BREACH)
    ? 'debate'
    : 'feedback-loop';
}

export type BreachKind = 'kill-line' | 'spend-cap' | 'both' | 'none';

/**
 * Total classification of what an alert actually reports (#1343) — the four
 * cases every alert-text surface must decide, rather than one caller's
 * wording leaking onto the other's alert the way "risk thresholds
 * auto-tightened" leaked onto the spend cap's.
 *
 * `'kill-line'`/`'spend-cap'` are the two production shapes: `detectBreaches`
 * (metrics.ts) pushes only kill-line ids, `SqliteSpendCap#refuse`
 * (production.ts) posts `LLM_SPEND_CAP_BREACH` alone. `'both'` and `'none'`
 * are unreachable from those two callers today but are real values of
 * `breaches` this function must still answer for — an empty array, or a
 * future caller that merges both kinds into one alert — rather than falling
 * through to either side's wording by omission.
 */
export function classifyBreach(breaches: readonly string[]): BreachKind {
  const killLine = breaches.some((breach) => breach !== LLM_SPEND_CAP_BREACH);
  const spendCap = breaches.includes(LLM_SPEND_CAP_BREACH);
  if (killLine && spendCap) return 'both';
  if (killLine) return 'kill-line';
  if (spendCap) return 'spend-cap';
  return 'none';
}

const KILL_LINE_HEADLINE = 'KILL-THRESHOLD BREACH';
const SPEND_CAP_HEADLINE = 'LLM SPEND-CAP BREACH';

/**
 * `formatBreachAlert`'s Telegram body — what actually happened, per breach
 * kind. `breachLogMessage` below states the same four facts in its own
 * shorter prose for the log line; kept as two functions rather than one
 * shared string because the audiences differ (a push notification vs. a log
 * line read back after the fact), not because the underlying facts do.
 *
 * The kill-line sentence's TEXT is unchanged from before #1343. Its claim is
 * true whenever `autoTighten` has room to move at least one dial; on a repeat
 * breach with every risk threshold already at its bound, `applyGuardrail`
 * makes every step a no-op (see `autoTighten`'s doc in metrics.ts) and
 * "every risk threshold has been ... auto-tightened" overclaims. That gap
 * predates #1343, which is scoped to the caller-discrimination defect (one
 * sentence claimed for both callers, true on only one) — not to this
 * per-dial edge case, left as a known, recorded limitation rather than
 * silently inherited.
 *
 * The spend-cap sentence is new: `SqliteSpendCap#refuse` touches no risk
 * threshold, whichever refusal kind fired it. The wiring in production.ts
 * discards `SpendCapVerdict`, so this text cannot say which kind fired —
 * only that a budget refusal stays refused until an operator raises it,
 * while a ledger-read refusal (`kind: 'fault'`) can clear on its own on a
 * later tick (see the `#budgetAnnounced`/`#faultAnnounced` doc in
 * spend-cap.ts). Promising a fix an operator does not need to make is the
 * same class of defect #1343 exists to remove.
 */
function breachOutcome(breaches: readonly string[]): string {
  switch (classifyBreach(breaches)) {
    case 'kill-line':
      return (
        'Every risk threshold has been defensively auto-tightened. No kill has been applied ' +
        'and none will be — kill or rework is your decision. Review the strategy before the ' +
        'next session.'
      );
    case 'spend-cap':
      return (
        'The LLM spend cap has refused further LLM debates. No risk threshold has changed — ' +
        'a spend-cap refusal is not a kill-line breach and no kill decision applies. This is ' +
        'either the budget being reached (stays refused until an operator raises it) or the ' +
        'spend ledger being unreadable (can clear on its own on a later tick) — the ' +
        'surrounding log names which.'
      );
    case 'both':
      return (
        'Every risk threshold has been defensively auto-tightened for the kill-line breach. ' +
        'No kill has been applied and none will be — kill or rework is your decision. ' +
        'Separately, the LLM spend cap has also refused further LLM debates — either the ' +
        'budget has been reached (stays refused until an operator raises it) or the spend ' +
        'ledger is unreadable (can clear on its own on a later tick); the surrounding log ' +
        'names which.'
      );
    case 'none':
      return (
        'No recognized breach id was reported. No risk threshold has changed and no LLM ' +
        'debates have been refused as a result of this alert.'
      );
  }
}

function breachHeadline(breaches: readonly string[]): string {
  switch (classifyBreach(breaches)) {
    case 'kill-line':
      return KILL_LINE_HEADLINE;
    case 'spend-cap':
      return SPEND_CAP_HEADLINE;
    case 'both':
      return `${KILL_LINE_HEADLINE} + ${SPEND_CAP_HEADLINE}`;
    case 'none':
      return 'BREACH';
  }
}

/**
 * Short noun phrase for "an alert about ___ failed to send" — used by
 * `breach_alert_send_failed`, which names what could not be delivered rather
 * than restating the full outcome text.
 */
function breachLabel(breaches: readonly string[]): string {
  switch (classifyBreach(breaches)) {
    case 'kill-line':
      return 'kill-threshold breach';
    case 'spend-cap':
      return 'LLM spend-cap breach';
    case 'both':
      return 'kill-threshold and LLM spend-cap breach';
    case 'none':
      return 'breach';
  }
}

/**
 * `LoggingBreachAlertChannel`'s `kill_threshold_breach` log message
 * (console-channels.ts) — exported so that surface shares this discrimination
 * rather than keeping a second, driftable copy of "what happened" in prose.
 * Shorter than `breachOutcome` (no Telegram-audience framing) but decides the
 * same four cases, on the same evidence: `#refuse` touches no risk threshold
 * on either refusal kind, and — since the wiring discards `SpendCapVerdict`
 * (production.ts) — this text cannot say which kind fired, only that a
 * budget refusal stays refused until raised while a ledger-read refusal can
 * clear on its own (see `breachOutcome`'s doc above for the full reasoning).
 */
export function breachLogMessage(breaches: readonly string[]): string {
  switch (classifyBreach(breaches)) {
    case 'kill-line':
      return (
        'kill-threshold breach — risk thresholds auto-tightened; review the strategy and ' +
        'decide kill or rework (no automatic kill is ever applied)'
      );
    case 'spend-cap':
      return (
        'LLM spend-cap breach — further LLM debates refused; no risk threshold changed. ' +
        'Either the budget has been reached (stays refused until an operator raises it) or ' +
        'the spend ledger is unreadable (may clear on its own) — see the surrounding log for ' +
        'which'
      );
    case 'both':
      return (
        'kill-threshold and LLM spend-cap breach — risk thresholds auto-tightened for the ' +
        'kill-line breach and no automatic kill is ever applied; separately, LLM debates are ' +
        'refused either because the budget is reached (stays refused until raised) or the ' +
        'spend ledger is unreadable (may clear on its own) — see the surrounding log for which'
      );
    case 'none':
      return (
        'breach alert with no recognized breach id — no risk threshold changed and no LLM ' +
        'debates were refused'
      );
  }
}

/**
 * Composed only from the alert's own fields. Deliberately does NOT include the
 * metrics suite: `MetricsSuite` is ten floats whose meaning needs the report
 * beside it, and a push notification's job here is to get a human to go look.
 */
export function formatBreachAlert(alert: BreachAlert): string {
  const ids = alert.breaches.length > 0 ? alert.breaches.join(', ') : 'none';
  return (
    `Samurai ${breachHeadline(alert.breaches)} (${alert.breaches.length}): ${ids}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    breachOutcome(alert.breaches)
  );
}

export class TradeChannelBreachAlert implements BreachAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;
  readonly #logger: Logger;

  /**
   * `logger` is REQUIRED and sits ahead of the optional Discord pair for that
   * reason. The only alternative to logging a failed send is silence on the
   * one alert that matters most — a breach whose push failed would otherwise
   * vanish entirely — so this is not a dependency a caller may decline.
   */
  constructor(
    telegram: TelegramClient,
    telegramChatId: string,
    logger: Logger,
    discord?: DiscordClient,
    discordChannelId?: string,
  ) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
    this.#logger = logger;
    this.#discord = discord;
    this.#discordChannelId = discordChannelId;
  }

  postBreachAlert(alert: BreachAlert): void {
    const text = formatBreachAlert(alert);
    // Both attempted together, mirroring the heartbeat's shape, so a Telegram
    // outage does not silence the Discord copy.
    void Promise.allSettled([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === 0) {
        return;
      }
      // A breach that could not be delivered is itself an operator-visible
      // event — otherwise the one alert that matters most fails silently.
      this.#logger.log({
        // Same mixed shape as `LoggingBreachAlertChannel` (#1280): the daily
        // kill-line batch runs outside any tick, but an `llm_spend_cap` breach
        // is raised inside one by `SqliteSpendCap#refuse`, so the undelivered
        // alert must join whichever raised it rather than always naming the
        // daily cycle. The same third provenance `LoggingBreachAlertChannel`
        // records applies: a boot-time refusal from `startingTotal()` has no
        // ambient id and is mislabelled `feedback-cycle`. That case is
        // distinguishable (no ambient id plus an all-`llm_spend_cap` list) and
        // deliberately left underived for the reason that channel's comment
        // gives — a provenance field on `BreachAlert` would resolve it, not a
        // second inference here. #1343 fixed the WORDING drift on this path
        // (this message no longer claims "kill-threshold" for a spend-cap
        // send failure) with `classifyBreach`, which needs no such field
        // because `breaches` alone answers it; the trace_id ambiguity above
        // is a different question and is unresolved by that fix.
        trace_id: currentTraceId() ?? 'feedback-cycle',
        stage: breachStage(alert),
        event: 'breach_alert_send_failed',
        level: 'error',
        message: `${breachLabel(alert.breaches)} alert failed to send — the breach still stands`,
        payload: {
          breaches: alert.breaches,
          reported_at: alert.reported_at.toISOString(),
          failures: failed.length,
        },
      });
    });
  }
}
