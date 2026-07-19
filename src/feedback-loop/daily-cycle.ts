/**
 * The Feedback Loop's daily batch cycle (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Feedback Loop Core").
 *
 * Scheduled, bounded, deterministic — not online, not a black box. Once a
 * day it reads the window's closed trades, attributes their realized R back
 * to the analysts who debated them, and steps each dial a capped amount
 * toward what its record implies, inside human-set hard bounds. Risk
 * thresholds may auto-tighten; loosening one is queued for a human instead.
 *
 * Deterministic given the clock: every read is scoped to `(now − window,
 * now]` and time is only ever read through the injected `Clock`, so a
 * backtest replays the same trajectory point-in-time — never
 * global-fit-and-apply-retroactively (spec story 14).
 *
 * `onTradeClose` (setup-store R-labelling) is #92 and `computeMetrics` is
 * #93; neither is implemented here.
 */
import type { ClosedTrade } from '../shared/types.js';
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

/**
 * A param name may not appear as both a strategy param and a risk threshold:
 * `DailyCycleResult.param_updates` is one flat map keyed by name, so a
 * collision would silently drop one of the two — and if the dropped one were
 * the gated threshold, a loosening could be reported as an applied param
 * tune. Fail loudly at config-read time instead.
 */
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

/** The window's trades: `(now − attribution_window_ms, now]`. */
function tradesInWindow(input: DailyCycleInput, now: Date): ClosedTrade[] {
  const from = new Date(now.getTime() - input.config.attribution_window_ms);
  return input.trades.getClosedTradesBetween(from, now);
}

export function runDailyCycle(input: DailyCycleInput): DailyCycleResult {
  const { clock, config, tuning, adjustments, approvals, mode } = input;
  assertNoNameCollision(config);

  const now = clock.now();
  const result: DailyCycleResult = {
    weight_updates: {},
    param_updates: {},
    loosen_pending_approval: [],
    applied: false,
  };

  const record = (entry: Adjustment): void => {
    adjustments.append(entry);
    result.applied = true;
  };

  // --- Dial 1: analyst weights, from attribution. Never gated. ---
  const credits = accumulateCredit(tradesInWindow(input, now), input.debate_log, config);
  const weights = tuning.getAnalystWeights();

  for (const credit of credits.values()) {
    // An analyst with a debate record but no weight row yet has nothing to
    // step from; seeding it is the weight store's job, not a tuning cycle's.
    const from = weights[credit.analyst_id];
    if (from === undefined) {
      continue;
    }

    const target = impliedWeight(credit, config.weights);
    // Never gated: weights tune freely inside their bounds (spec — only risk
    // thresholds are asymmetric).
    const { to, direction } = applyGuardrail(from, target, config.weights, false);
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
      // Descriptive only — a weight carries no safety semantics, so
      // `weights.tighten_is` just labels the audit trail.
      direction,
      applied_at: now,
      reason: 'attribution',
    });
  }

  // --- Dials 2 & 3: strategy params (free) and risk thresholds (asymmetric). ---
  const params = tuning.getStrategyParams();
  const thresholds = tuning.getRiskThresholds();

  for (const proposal of input.proposals) {
    const dial = dialFor(proposal, config);
    // An undeclared dial has no floor/ceiling/step cap, so there is no
    // bounded move to make. Refusing is the guardrail: an unbounded tune is
    // exactly what the hard bounds exist to prevent.
    if (dial === undefined) {
      throw new Error(
        `Tuning proposal for '${proposal.name}' has no ${proposal.kind} dial declared in ` +
          'FeedbackConfig — an unbounded dial cannot be tuned.',
      );
    }

    const isThreshold = proposal.kind === 'risk_threshold';
    const current = isThreshold ? thresholds[proposal.name] : params[proposal.name];
    if (current === undefined) {
      continue;
    }

    // Backtest auto-handles loosening approvals (like Verdict's HITL bypass)
    // so replay exercises the same code path as live — and records it.
    const gate = isThreshold && mode === 'live';
    const { to, direction, gated } = applyGuardrail(current, proposal.target, dial, gate);

    if (gated) {
      // Queued, NOT written: the cycle that proposes a loosening never
      // applies it. Acting on the human's answer is a later cycle's job.
      result.loosen_pending_approval.push(proposal.name);
      approvals.requestLoosenApproval({
        name: proposal.name,
        from: current,
        to,
        requested_at: now,
      });
      continue;
    }

    if (to === current) {
      continue;
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
      reason:
        isThreshold && direction === 'loosen' ? 'proposal:backtest_auto_approved' : 'proposal',
    });
  }

  return result;
}
