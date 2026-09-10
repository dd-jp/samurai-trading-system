/**
 * Trade-channel adapter for the Feedback Loop's kill-threshold breach alert
 * and the LLM spend cap's refusal alert (#93, wired by #327) — the same move
 * `TradeChannelUnpricedFillAlert` and `TradeChannelHeartbeat` make: reuse
 * Verdict's already-provisioned Telegram transport rather than introduce a
 * second integration, and wrap the raw clients rather than route through
 * `TradeChannelNotifier.notify`, which is shaped for a `VerdictDecision` and
 * not for a validation breach.
 *
 * This is what makes story 13's "alert the human" reachable during an
 * UNATTENDED soak (#238). `LoggingBreachAlertChannel` writes a line nobody is
 * tailing; this one reaches a phone.
 *
 * ## Why this one is fire-and-forget
 *
 * `BreachAlertChannel.postBreachAlert` returns `void`, not a promise — the
 * port is synchronous because `computeMetrics` is, and its own doc calls the
 * alert "fire-and-forget" (a breach expects no answer, and there is no
 * kill/rework call to wait for — nobody owns one under full automation; the
 * mechanical response, auto-tighten, runs synchronously on this same call
 * path immediately after this port call returns). So the send is started
 * and not awaited, and its
 * rejection is caught here rather than left to surface as an unhandled
 * rejection that would take the process down mid-soak. A transport failure
 * must not undo the auto-tighten `computeMetrics` already applied on the
 * kill-line caller; the spend-cap caller has nothing analogous to undo, since
 * `SqliteSpendCap#refuse` (spend-cap.ts) never touches a risk threshold.
 *
 * The catch is deliberately best-effort and silent-to-the-caller, which is a
 * real limitation worth naming: if Telegram is down, the breach reaches
 * nobody. On the kill-line caller the mitigation is the log-line copy the
 * orchestrator writes for every daily cycle regardless (`daily metrics
 * computed`, production.ts); this adapter has no retry queue either way.
 */
import type { BreachAlert, BreachAlertChannel } from '../../pipeline/feedback-loop/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { currentTraceId, describeThrownSafely } from '../../shared/index.js';
import { TradeChannelAlert } from './trade-channel.js';
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

type BreachKind = 'kill-line' | 'spend-cap' | 'both' | 'none';

/**
 * Total classification of what an alert actually reports (#1343) — the four
 * cases every alert-text surface must decide, rather than one caller's
 * wording leaking onto the other's alert the way "risk thresholds
 * auto-tightened" leaked onto the spend cap's.
 *
 * `'kill-line'`/`'spend-cap'` are the two production shapes: `detectBreaches`
 * (metrics.ts) pushes only kill-line ids; `SqliteSpendCap#refuse`
 * (spend-cap.ts, wired in production.ts) posts `LLM_SPEND_CAP_BREACH` alone.
 * `'both'` and `'none'` are unreachable from those two callers today but are
 * real values of `breaches` this function must still answer for — an empty
 * array, or a future caller that merges both kinds into one alert — rather
 * than falling through to either side's wording by omission.
 */
export function classifyBreach(breaches: readonly string[]): BreachKind {
  const killLine = breaches.some((breach) => breach !== LLM_SPEND_CAP_BREACH);
  const spendCap = breaches.includes(LLM_SPEND_CAP_BREACH);
  if (killLine && spendCap) return 'both';
  if (killLine) return 'kill-line';
  if (spendCap) return 'spend-cap';
  return 'none';
}

interface BreachText {
  headline: string;
  outcome: string;
  label: string;
  logMessage: string;
}

const KILL_LINE_OUTCOME =
  'Every risk threshold has been defensively auto-tightened. No kill has been applied ' +
  'and none will be — kill or rework is your decision. Review the strategy before the ' +
  'next session.';

const SPEND_CAP_OUTCOME =
  'The LLM spend cap has refused further LLM calls — debates, market-intelligence ' +
  'refreshes and risk-critic checks alike. No risk threshold has changed — a spend-cap ' +
  'refusal is not a kill-line breach and no kill decision applies. The refusal stands ' +
  'until whatever triggered it is resolved; the refusal log line, where one was ' +
  'written, names which.';

const KILL_LINE_LOG_MESSAGE =
  'kill-threshold breach — risk thresholds auto-tightened; review the strategy and ' +
  'decide kill or rework (no automatic kill is ever applied)';

const SPEND_CAP_LOG_MESSAGE =
  'LLM spend-cap breach — further LLM calls refused (debates, market-intelligence ' +
  'refreshes, risk-critic checks); no risk threshold changed. The refusal stands until ' +
  'whatever triggered it is resolved; the refusal log line, where one was written, ' +
  'names which';

/**
 * One entry per `BreachKind` (#1343) — the four cases every alert-text
 * surface must decide, rather than one caller's wording leaking onto the
 * other's alert the way "risk thresholds auto-tightened" leaked onto the
 * spend cap's before this table existed. `formatBreachAlert` (Telegram body),
 * `breachLogMessage` (the `kill_threshold_breach` log line), and
 * `breachLabel` (the failed-send label) all read from this one place, so the
 * four cases cannot drift apart between surfaces.
 *
 * `'kill-line'`'s prose is BYTE-IDENTICAL to the pre-#1343 original (tested
 * with an exact `toBe`). Its "every ... auto-tightened" claim is true
 * whenever `autoTighten` (metrics.ts) has room to move at least one dial; on
 * a repeat breach with every threshold already at its bound, `applyGuardrail`
 * makes every step a no-op and the claim overclaims. That gap predates #1343
 * and is a different, already-recorded limitation (a per-dial edge case, not
 * caller-discrimination) — left as-is here rather than silently inherited.
 *
 * `'spend-cap'`'s prose cannot say WHICH refusal kind fired: the wiring in
 * production.ts discards `SpendCapVerdict`, and `SqliteSpendCap#refuse`
 * (spend-cap.ts) covers three distinct sites behind that one boolean — a
 * transient `llm_spend` read failure, a corrupt (non-finite) `cost_usd` sum
 * that does NOT clear on its own, and the budget itself being spent (which
 * stays spent until an operator raises it). So the text promises neither a
 * specific cause nor that anything will clear unassisted — and "further LLM
 * calls" is deliberately broader than "debates": the same cap also gates
 * market-intelligence refreshes and risk-critic checks.
 */
const BREACH_TEXT: Record<BreachKind, BreachText> = {
  'kill-line': {
    headline: 'KILL-THRESHOLD BREACH',
    outcome: KILL_LINE_OUTCOME,
    label: 'kill-threshold breach',
    logMessage: KILL_LINE_LOG_MESSAGE,
  },
  'spend-cap': {
    headline: 'LLM SPEND-CAP BREACH',
    outcome: SPEND_CAP_OUTCOME,
    label: 'LLM spend-cap breach',
    logMessage: SPEND_CAP_LOG_MESSAGE,
  },
  both: {
    headline: 'KILL-THRESHOLD BREACH + LLM SPEND-CAP BREACH',
    outcome:
      'Every risk threshold has been defensively auto-tightened for the kill-line breach. ' +
      'No kill has been applied and none will be — kill or rework is your decision. ' +
      'Separately, the LLM spend cap has also refused further LLM calls — debates, ' +
      'market-intelligence refreshes and risk-critic checks alike. The refusal stands ' +
      'until whatever triggered it is resolved; the refusal log line, where one was ' +
      'written, names which.',
    label: 'kill-threshold and LLM spend-cap breach',
    logMessage:
      'kill-threshold and LLM spend-cap breach — risk thresholds auto-tightened for the ' +
      'kill-line breach and no automatic kill is ever applied; separately, LLM calls ' +
      '(debates, market-intelligence refreshes, risk-critic checks) are refused until ' +
      'whatever triggered the refusal is resolved; the refusal log line, where one was ' +
      'written, names which',
  },
  none: {
    headline: 'BREACH',
    outcome:
      'No recognized breach id was reported. No risk threshold has changed and no LLM ' +
      'calls have been refused as a result of this alert.',
    label: 'breach',
    logMessage:
      'breach alert with no recognized breach id — no risk threshold changed and no LLM ' +
      'calls were refused',
  },
};

function breachOutcome(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].outcome;
}

function breachHeadline(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].headline;
}

/**
 * Short noun phrase for "an alert about ___ failed to send" — used by
 * `breach_alert_send_failed`, which names what could not be delivered rather
 * than restating the full outcome text.
 */
function breachLabel(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].label;
}

/**
 * `LoggingBreachAlertChannel`'s `kill_threshold_breach` log message
 * (console-channels.ts) — exported so that surface shares this discrimination
 * rather than keeping a second, driftable copy of "what happened" in prose.
 * The `event` name itself stays `kill_threshold_breach` for both callers,
 * deliberately: no production code reads it (only a test filters on it),
 * and renaming it is a different, out-of-scope change from the wording this
 * ticket fixes.
 */
export function breachLogMessage(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].logMessage;
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

export class TradeChannelBreachAlert extends TradeChannelAlert implements BreachAlertChannel {
  readonly #logger: Logger;

  /**
   * `logger` is REQUIRED. The only alternative to logging a failed send is
   * silence on the one alert that matters most — a breach whose push failed
   * would otherwise vanish entirely — so this is not a dependency a caller
   * may decline.
   */
  constructor(telegram: TelegramClient, telegramChatId: string, logger: Logger) {
    super(telegram, telegramChatId);
    this.#logger = logger;
  }

  postBreachAlert(alert: BreachAlert): void {
    const text = formatBreachAlert(alert);
    this.sendDetached(text, (error: unknown) => {
      // A breach that could not be delivered is itself an operator-visible
      // event — otherwise the one alert that matters most fails silently.
      this.#logger.log({
        // Same mixed-caller shape as `LoggingBreachAlertChannel` (#1280), via
        // `breachStage`. A third provenance — a boot-time refusal from
        // `startingTotal()`, which has no ambient trace id — lands on the
        // `feedback-cycle` fallback below and is indistinguishable from the
        // daily cycle at this site; `BreachAlert` carries no field to resolve
        // it, and adding one is out of this ticket's scope (see
        // `classifyBreach`'s doc above for what #1343 does fix: the wording).
        trace_id: currentTraceId() ?? 'feedback-cycle',
        stage: breachStage(alert),
        event: 'breach_alert_send_failed',
        level: 'error',
        message: `${breachLabel(alert.breaches)} alert failed to send — the breach still stands`,
        payload: {
          breaches: alert.breaches,
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
