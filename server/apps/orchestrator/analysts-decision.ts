import type { QUORUM_SKIP_DECISIONS } from '../../../contracts/index.js';
import type { AnalystFailure } from '../../pipeline/analysts/index.js';

type QuorumSkipDecision = (typeof QUORUM_SKIP_DECISIONS)[number];

export type AnalystSkipKind = 'timeout' | 'fault';

const MAX_RETAINED_SKIPS = 64;

export class AnalystSkipKindRelay {
  readonly #kinds = new Map<string, AnalystSkipKind>();

  set(trace_id: string, kind: AnalystSkipKind): void {
    if (this.#kinds.size >= MAX_RETAINED_SKIPS) {
      const oldest = this.#kinds.keys().next();
      if (!oldest.done) this.#kinds.delete(oldest.value);
    }
    this.#kinds.set(trace_id, kind);
  }

  take(trace_id: string): AnalystSkipKind | undefined {
    const kind = this.#kinds.get(trace_id);
    this.#kinds.delete(trace_id);
    return kind;
  }
}

export function skipKindOf(
  skipped: boolean,
  failures: readonly AnalystFailure[],
): AnalystSkipKind | undefined {
  if (!skipped) return undefined;
  const mandatory = failures.filter((failure) => failure.role === 'mandatory');
  return mandatory.some((failure) => failure.kind === 'timeout') ? 'timeout' : 'fault';
}

export function analystsSkipDecisionWord(kind: AnalystSkipKind | undefined): QuorumSkipDecision {
  if (kind === 'timeout') return 'quorum_skip_timeout';
  if (kind === 'fault') return 'quorum_skip_fault';
  return 'quorum_skip';
}
