import type {
  SpendCap,
  SpendCapRefusalKind,
  SpendCapVerdict,
} from '../../pipeline/debate-engine/index.js';
import { DEBATE_SLEEVE_ID, SPEND_CAP_REASON_PREFIX } from './signal/index.js';

const REFUSAL_KINDS: readonly string[] = [
  'budget',
  'corrupt_ledger',
  'read_fault',
] satisfies readonly SpendCapRefusalKind[];

export interface JournalledCheck {
  readonly sleeve_id: string;
  readonly instrument: string;
  readonly reason: string;
}

const ADMITTED: SpendCapVerdict = {
  admitted: true,
  spent_usd: 0,
  budget_usd: Number.POSITIVE_INFINITY,
};

function verdictOf(row: JournalledCheck): SpendCapVerdict {
  const kind = row.reason.startsWith(SPEND_CAP_REASON_PREFIX)
    ? row.reason.slice(SPEND_CAP_REASON_PREFIX.length)
    : undefined;
  if (kind === undefined || !REFUSAL_KINDS.includes(kind)) return ADMITTED;
  return {
    admitted: false,
    spent_usd: Number.NaN,
    budget_usd: Number.NaN,
    kind: kind as SpendCapRefusalKind,
  };
}

// The sleeve checks the cap once per name before any book sees the decision, and journals a
// refused name with its llm_spend_cap: reason in every book. Keyed by name, not by journal order,
// because a book journals its sit-outs before the rest of its decisions
export function journalledSpendCap(rows: readonly JournalledCheck[]): SpendCap {
  const refused = new Map<string, SpendCapVerdict>();
  for (const row of rows) {
    const verdict = verdictOf(row);
    if (row.sleeve_id === DEBATE_SLEEVE_ID && !verdict.admitted)
      refused.set(row.instrument, verdict);
  }
  return { check: (instrument) => refused.get(instrument ?? '') ?? ADMITTED };
}
