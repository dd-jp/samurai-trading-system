/**
 * Decorator (#206) that writes one `verdict_log` row per `VerdictDecision`,
 * leaving #79's gate sequence (VerdictImpl) untouched. Mirrors
 * src/verdict/notifying-verdict.ts's `NotifyingVerdict` shape. See
 * docs/specs/verdict-spec.md story 17 ("every VerdictDecision logged with
 * full context, so that every final decision is auditable") and
 * docs/specs/shared-sqlite-store-spec.md ("Verdict" — `verdict_log`).
 */

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
