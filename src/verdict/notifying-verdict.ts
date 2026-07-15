/**
 * Decorator (ticket #81) that posts every `VerdictDecision` to the trade
 * channel exactly once, leaving #79's gate sequence (VerdictImpl) untouched.
 * See docs/specs/verdict-spec.md story 2 ("emit a VerdictDecision... so that
 * Execution and the audit log have a complete final record") and story 14
 * ("fills and no-gos also posted to the trade channel"). In backtest mode,
 * inject a no-op `TradeChannelNotifier` (same pattern as `ApprovalChannel`'s
 * no-op auto-approve there) rather than branching on `mode` here.
 */

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
    await this.#notifier.notify(decision, input.risk_decision, input.trace_id);
    return decision;
  }
}
