import type { ClosedTrade } from '../../shared/index.js';
import { accumulateCredit, impliedWeight } from './attribution.js';
import { applyGuardrail } from './guardrails.js';
import type {
  Adjustment,
  DailyCycleInput,
  DailyCycleResult,
  FeedbackConfig,
  TunableDial,
  TuningProposal,
} from './types.js';

function assertNoNameCollision(config: FeedbackConfig): void {
  for (const name of Object.keys(config.strategy_params)) {
    if (name in config.risk_thresholds) {
      throw new Error(
        `FeedbackConfig: '${name}' is declared as both a strategy_param and a risk_threshold — ` +
          'param_updates is keyed by name and cannot hold both.',
      );
    }
  }
}

function dialFor(proposal: TuningProposal, config: FeedbackConfig): TunableDial | undefined {
  return proposal.kind === 'risk_threshold'
    ? config.risk_thresholds[proposal.name]
    : config.strategy_params[proposal.name];
}

function tradesInWindow(input: DailyCycleInput, now: Date): ClosedTrade[] {
  const from = new Date(now.getTime() - input.config.attribution_window_ms);
  return input.trades.getClosedTradesBetween(from, now);
}

export function runDailyCycle(input: DailyCycleInput): DailyCycleResult {
  assertNoNameCollision(input.config);

  const now = input.clock.now();
  const result: DailyCycleResult = {
    weight_updates: {},
    param_updates: {},
    applied: false,
  };

  const record = (entry: Adjustment): void => {
    input.adjustments.append(entry);
    result.applied = true;
  };

  tuneAnalystWeights(input, now, result, record);
  applyTuningProposals(input, now, result, record);

  return result;
}

function tuneAnalystWeights(
  input: DailyCycleInput,
  now: Date,
  result: DailyCycleResult,
  record: (entry: Adjustment) => void,
): void {
  const { config, tuning } = input;
  const credits = accumulateCredit(tradesInWindow(input, now), input.debate_log);
  const weights = tuning.getAnalystWeights();

  for (const credit of credits.values()) {
    const from = weights[credit.analyst_id];
    if (from === undefined) {
      continue;
    }

    const target = impliedWeight(credit, config.weights);
    const { to, direction } = applyGuardrail(from, target, config.weights);
    if (to === from) {
      continue;
    }

    tuning.setAnalystWeight(credit.analyst_id, to);
    result.weight_updates[credit.analyst_id] = { from, to };
    record({
      dial: 'analyst_weight',
      name: credit.analyst_id,
      from,
      to,
      direction,
      applied_at: now,
      reason: 'attribution',
    });
  }
}

function applyTuningProposal(
  proposal: TuningProposal,
  input: DailyCycleInput,
  params: Record<string, number>,
  thresholds: Record<string, number>,
  now: Date,
  result: DailyCycleResult,
  record: (entry: Adjustment) => void,
): void {
  const { config, tuning, loosen_notices } = input;
  const dial = dialFor(proposal, config);
  if (dial === undefined) {
    throw new Error(
      `Tuning proposal for '${proposal.name}' has no ${proposal.kind} dial declared in ` +
        'FeedbackConfig — an unbounded dial cannot be tuned.',
    );
  }

  const isThreshold = proposal.kind === 'risk_threshold';
  const current = isThreshold ? thresholds[proposal.name] : params[proposal.name];
  if (current === undefined) {
    return;
  }

  const { to, direction } = applyGuardrail(current, proposal.target, dial);

  if (to === current) {
    return;
  }

  if (isThreshold) {
    tuning.setRiskThreshold(proposal.name, to);
  } else {
    tuning.setStrategyParam(proposal.name, to);
  }
  result.param_updates[proposal.name] = { from: current, to, direction };
  record({
    dial: isThreshold ? 'risk_threshold' : 'strategy_param',
    name: proposal.name,
    from: current,
    to,
    direction,
    applied_at: now,
    reason: 'proposal',
  });

  if (isThreshold && direction === 'loosen') {
    loosen_notices.notifyLoosenApplied({
      name: proposal.name,
      from: current,
      to,
      applied_at: now,
    });
  }
}

function applyTuningProposals(
  input: DailyCycleInput,
  now: Date,
  result: DailyCycleResult,
  record: (entry: Adjustment) => void,
): void {
  const params = input.tuning.getStrategyParams();
  const thresholds = input.tuning.getRiskThresholds();

  for (const proposal of input.proposals) {
    applyTuningProposal(proposal, input, params, thresholds, now, result, record);
  }
}
