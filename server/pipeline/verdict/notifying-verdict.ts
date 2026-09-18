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

    if (isNotableVerdict(decision)) {
      await this.#notifier.notify(decision, input.risk_decision, input.trace_id);
    }
    return decision;
  }
}
