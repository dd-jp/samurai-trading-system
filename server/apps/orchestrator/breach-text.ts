import type { BreachAlert } from '../../pipeline/feedback-loop/index.js';

export const LLM_SPEND_CAP_BREACH = 'llm_spend_cap';

export function breachStage(alert: BreachAlert): string {
  return alert.breaches.every((breach) => breach === LLM_SPEND_CAP_BREACH)
    ? 'debate'
    : 'feedback-loop';
}

type BreachKind = 'kill-line' | 'spend-cap' | 'both' | 'none';

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

export function breachLabel(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].label;
}

export function breachLogMessage(breaches: readonly string[]): string {
  return BREACH_TEXT[classifyBreach(breaches)].logMessage;
}

export function formatBreachAlert(alert: BreachAlert): string {
  const text = BREACH_TEXT[classifyBreach(alert.breaches)];
  const ids = alert.breaches.length > 0 ? alert.breaches.join(', ') : 'none';
  return (
    `Samurai ${text.headline} (${alert.breaches.length}): ${ids}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    text.outcome
  );
}
