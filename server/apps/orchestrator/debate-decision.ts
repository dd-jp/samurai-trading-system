/**
 * The `audit_log` decision word for a resolved debate (#1080).
 *
 * Before this, `tick-runner.ts` recorded `debate.direction` verbatim, so every
 * degraded path the Debate Engine has — a fired latency budget, a rate-limit
 * refusal, a spend-cap refusal — was written as the single word `neutral`, the
 * same word a converged debate writes when the analysts disagree into a wash.
 * `DEGRADED_DECISIONS` (contracts/pipeline.ts) carries what that conflation
 * cost and why an operator acts on the two differently; this module is the
 * reader that makes the distinction exist at all.
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
import { isDegradedDecision } from '../../../contracts/pipeline.js';
import type { DebateResult } from '../../pipeline/debate-engine/index.js';

export { isDegradedDecision };

/**
 * Reads the decision word off a resolved debate. Checks `rate_limited` first:
 * a debate that was never admitted has no latency budget to have exceeded, so
 * the two conditions cannot both hold, and ordering them makes that explicit
 * rather than relying on it.
 *
 * `!debate.read` is checked last, after the two named failures, and covers
 * what neither of them can (#1393): a future fallback that hands back a
 * neutral result for a reason that is not a budget and not an admission
 * refusal. Without this the bare `debate.direction` fallthrough below would
 * write `neutral`, indistinguishable from a genuine wash — the exact
 * `debateWasDegraded` (trader/decide.ts) reads to classify the same result,
 * so the two stay in agreement.
 */
export function debateDecisionWord(debate: DebateResult): string {
  if (debate.rate_limited !== undefined) {
    return 'not_admitted';
  }
  if (debate.timed_out !== undefined) {
    return debate.rounds_completed === 0 ? 'budget_exhausted' : 'timed_out_partial';
  }
  if (!debate.read) {
    return 'unread';
  }
  return debate.direction;
}
