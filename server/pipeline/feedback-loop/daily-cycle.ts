/**
 * The Feedback Loop's daily batch cycle (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Feedback Loop Core").
 *
 * Scheduled, bounded, deterministic — not online, not a black box. Once a
 * day it reads the window's closed trades, attributes their realized R back
 * to the analysts who debated them, and steps each dial a capped amount
 * toward what its record implies, inside human-set hard bounds.
 *
 * Every dial move applies, in every mode, tighten or loosen
 * ([ADR-0013](../../../docs/adr/0013-no-human-gate-anywhere.md) Decision 2,
 * #736). A loosening used to be queued for a human in paper and live and
 * applied only in backtest; nothing could deliver the human's answer, so the
 * queue drained never and the thresholds ratcheted one way. What survives is
 * the bounds, not the gate: `[floor, ceiling]` per dial here, and the in-code
 * clamp on the guarded thresholds (`server/shared/threshold-bounds.ts`, #638)
 * at the tuning store's write door, which THROWS on a crossing rather than
 * coercing it. A throw there aborts the rest of the cycle — moves already
 * written stand, later proposals are not attempted — and surfaces to the
 * composition root's `daily feedback cycle failed` line.
 *
 * Deterministic given the clock: every read is scoped to `(now − window,
 * now]` and time is only ever read through the injected `Clock`, so a
 * backtest replays the same trajectory point-in-time — never
 * global-fit-and-apply-retroactively (spec story 14).
 *
 * `onTradeClose` (setup-store R-labelling) is #92 and `computeMetrics` is
 * #93; neither is implemented here.
 */
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

/**
 * A param name may not appear as both a strategy param and a risk threshold:
 * `DailyCycleResult.param_updates` is one flat map keyed by name, so a
 * collision would silently drop one of the two — and if the dropped one were
 * the risk threshold, a threshold move could be reported as a strategy-param
 * tune, and its loosening notice never sent. Fail loudly at config-read time
 * instead.
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

/** The window's trades: `(now − attribution_window_ms, now]` */
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

/** Dial 1: analyst weights, from attribution. Bounded, and nothing else. */
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
    // An analyst with a debate record but no weight row yet has nothing to
    // step from; seeding it is the weight store's job, not a tuning cycle's
    // That job has an owner since #371 — `seedAnalystWeights`, called by the
    // composition root at startup — so this skip is now the "an analyst the
    // root does not build appeared in a debate log" case, not the everyday
    // one it used to be
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
      // Descriptive only — a weight carries no safety semantics, so
      // `weights.tighten_is` just labels the audit trail
      direction,
      applied_at: now,
      reason: 'attribution',
    });
  }
}

/**
 * Dials 2 & 3: strategy params and risk thresholds. One path for both, and
 * one path for all three modes — the only asymmetry left is that a threshold
 * LOOSENING is announced, and that a guarded threshold's clamp can refuse it
 * outright at the store's write door.
 */
function applyTuningProposals(
  input: DailyCycleInput,
  now: Date,
  result: DailyCycleResult,
  record: (entry: Adjustment) => void,
): void {
  const { config, tuning, loosen_notices } = input;
  const params = tuning.getStrategyParams();
  const thresholds = tuning.getRiskThresholds();

  for (const proposal of input.proposals) {
    const dial = dialFor(proposal, config);
    // An undeclared dial has no floor/ceiling/step cap, so there is no
    // bounded move to make. Refusing is the guardrail: an unbounded tune is
    // exactly what the hard bounds exist to prevent
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

    const { to, direction } = applyGuardrail(current, proposal.target, dial);

    if (to === current) {
      continue;
    }

    // The write comes first and can still refuse: `setRiskThreshold` runs the
    // in-code clamp (#638) and THROWS on a guarded threshold whose bounded
    // value would cross its research-mandated line. Nothing below runs in that
    // case — no `param_updates` entry, no `AdjustmentLog` row, no notice —
    // which is the point: a refused move must leave no trace that reads as an
    // applied one
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

    // Announced AFTER the write, and only for a relaxation of a safety dial:
    // the operator has no other way to learn that a limit widened without
    // anyone asking them (ADR-0013 Decision 2). Tightenings are not
    // announced — they narrow what the system may lose. The send is
    // fire-and-forget; a failed notice does not unwind the applied move
    if (isThreshold && direction === 'loosen') {
      loosen_notices.notifyLoosenApplied({
        name: proposal.name,
        from: current,
        to,
        applied_at: now,
      });
    }
  }
}
