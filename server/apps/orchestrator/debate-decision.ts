/**
 * The `audit_log` decision word for a resolved debate (#1080).
 *
 * Before this, `tick-runner.ts` recorded `debate.direction` verbatim. Every
 * degraded path the Debate Engine has — a fired latency budget, a rate-limit
 * refusal, a spend-cap refusal — resolves to a `DebateResult` carrying
 * `direction: 'neutral', confidence: 0`, so all three were recorded as the
 * single word `neutral`: the same word a converged three-round debate writes
 * when the analysts genuinely disagree into a wash. The Trader then
 * short-circuits on the zero confidence and records `no_trade`, and the
 * resulting two-line trace is indistinguishable from a healthy quiet-market
 * tick in the log, in `audit_log`, and on the dashboard, which renders that
 * column. In the 2026-09-03 session that covered 22 of 26 timed-out debates.
 *
 * The discriminators were already on the result — `timed_out` (#374) and
 * `rate_limited` (#388/ADR-0008) — and simply had no reader at this seam. This
 * function is that reader, and nothing else: it invents no state, and a debate
 * that resolved normally still records its direction exactly as before.
 *
 * `rounds_completed` is what separates the two timeout cases, and the
 * separation is the point rather than a nicety. A budget that fires mid-debate
 * still hands the Trader a real synthesis from the last round that finished
 * (`enforceLatencyBudget`'s partial path), which is a truncated answer; a
 * budget that fires before ANY round completed hands back
 * `LOW_CONFIDENCE_FALLBACK`, which is not an answer at all. Only the second
 * guarantees a no-trade.
 *
 * The control arm reaches this too — `buildControlDebateStep` is a `debate`
 * step like any other and its results run through the same `record` call — and
 * that is exactly why the arms stay comparable: a control result is computed by
 * `controlArmDecision` from relayed views with no client and no I/O, so it can
 * carry neither `timed_out` nor `rate_limited`, and every control row keeps
 * writing its bare direction. A degraded word appearing on a `control:` trace
 * would mean the falsifier arm had acquired an LLM.
 */
import { type DegradedDecision, isDegradedDecision } from '../../../contracts/pipeline.js';
import type { DebateResult } from '../../pipeline/debate-engine/index.js';

export type { DegradedDecision };
export { isDegradedDecision };

/**
 * Reads the decision word off a resolved debate. Checks `rate_limited` first:
 * a debate that was never admitted has no latency budget to have exceeded, so
 * the two conditions cannot both hold, and ordering them makes that explicit
 * rather than relying on it.
 */
export function debateDecisionWord(debate: DebateResult): string {
  if (debate.rate_limited !== undefined) {
    return 'not_admitted';
  }
  if (debate.timed_out !== undefined) {
    return debate.rounds_completed === 0 ? 'budget_exhausted' : 'timed_out_partial';
  }
  return debate.direction;
}
