/**
 * Decorator (ticket #81) that posts every `VerdictDecision` to the trade
 * channel exactly once, leaving #79's gate sequence (VerdictImpl) untouched.
 * See docs/specs/verdict-spec.md story 2 ("emit a VerdictDecision... so that
 * Execution and the audit log have a complete final record") and story 14
 * ("fills and no-gos also posted to the trade channel"). In backtest mode,
 * the composition root injects a no-op `TradeChannelNotifier` rather than
 * this decorator branching on `mode` itself.
 */

import { isNotableVerdict } from './notifications/notable-verdict.js';
import type { TradeChannelNotifier } from './notifications/types.js';
import type { Verdict, VerdictDecision, VerdictInput } from './types.js';

export class NotifyingVerdict implements Verdict {
  readonly #inner: Verdict;
  readonly #notifier: TradeChannelNotifier;

  constructor(inner: Verdict, notifier: TradeChannelNotifier) {
    this.#inner = inner;
    this.#notifier = notifier;
  }

  async decide(input: VerdictInput): Promise<VerdictDecision> {
    const decision = await this.#inner.decide(input);

    // FILTERED as of #465. Story 14's "fills and no-gos" predates ADR-0007
    // (no human in the loop) and ADR-0008 (the cadence that sets the volume);
    // together they make "every no-go" ~300 messages a day, which is alert
    // fatigue by construction. `isNotableVerdict` keeps the events an operator
    // would want to be interrupted for and drops the pipeline working
    // normally. Everything still lands in `verdict_log` via `LoggingVerdict`.
    if (isNotableVerdict(decision)) {
      await this.#notifier.notify(decision, input.risk_decision, input.trace_id);
    }
    return decision;
  }
}
