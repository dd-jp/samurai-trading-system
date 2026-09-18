
import type { VerdictLogStore } from '../../shared/index.js';
import type { Verdict, VerdictDecision, VerdictInput } from './types.js';
import { buildVerdictLog } from './verdict-log-store.js';

export class LoggingVerdict implements Verdict {
  readonly #inner: Verdict;
  readonly #store: VerdictLogStore;

  constructor(inner: Verdict, store: VerdictLogStore) {
    this.#inner = inner;
    this.#store = store;
  }

  async decide(input: VerdictInput): Promise<VerdictDecision> {
    const decision = await this.#inner.decide(input);
    this.#store.writeLog(buildVerdictLog(input, decision));
    return decision;
  }
}
