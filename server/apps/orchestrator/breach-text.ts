/**
 * What a `BreachAlert` says, at every surface that says it: the Telegram body
 * (`formatBreachAlert`), the `kill_threshold_breach` log line
 * (`breachLogMessage`), the failed-send label (`breachLabel`) and the stage
 * both log lines file under (`breachStage`). One table, so the four cases of
 * `classifyBreach` cannot drift apart between surfaces (#1343).
 */
import type { BreachAlert } from '../../pipeline/feedback-loop/index.js';

/**
 * The breach id `SqliteSpendCap` posts through `BreachAlertChannel`. Named
 * rather than repeated as a literal because `breachStage` and
 * `classifyBreach` discriminate on it.
 */
export const LLM_SPEND_CAP_BREACH = 'llm_spend_cap';

/**
 * The stage whichever caller raised the breach already logs under (#1280):
 * `SqliteSpendCap#refuse` (spend-cap.ts) logs its sibling
 * `llm_spend_cap_alert_send_failed` under `debate`; the daily kill-line batch
 * (`computeMetrics`) logs under `feedback-loop`.
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
 * Total classification of what an alert actually reports (#1343).
 * `'kill-line'`/`'spend-cap'` are the two production shapes; `'both'` and
 * `'none'` are unreachable from those callers today but are real values of
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
 * `'kill-line'`'s "every ... auto-tightened" claim is true whenever
 * `autoTighten` (metrics.ts) has room to move at least one dial; on a repeat
 * breach with every threshold already at its bound, `applyGuardrail` makes
 * every step a no-op and the claim overclaims — a per-dial edge case
 * recorded before #1343, left as-is.
 *
 * `'spend-cap'`'s prose cannot say WHICH refusal kind fired: the wiring in
 * production.ts discards `SpendCapVerdict`, and `SqliteSpendCap#refuse`
 * covers three distinct sites behind that one boolean (a transient
 * `llm_spend` read failure, a corrupt `cost_usd` sum that does NOT clear on
 * its own, and the budget itself being spent). So the text promises neither
 * a specific cause nor that anything will clear unassisted — and "further
 * LLM calls" is deliberately broader than "debates": the same cap also gates
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

/** Short noun phrase for "an alert about ___ failed to send". */
export function breachLabel(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].label;
}

/**
 * The `kill_threshold_breach` log line's message. The `event` name itself
 * stays `kill_threshold_breach` for both callers, deliberately: no production
 * code reads it (only a test filters on it).
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
  const text = BREACH_TEXT[classifyBreach(alert.breaches)];
  const ids = alert.breaches.length > 0 ? alert.breaches.join(', ') : 'none';
  return (
    `Samurai ${text.headline} (${alert.breaches.length}): ${ids}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    text.outcome
  );
}
