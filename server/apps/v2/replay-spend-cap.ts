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
  readonly inputs_hash: string;
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

// The debate sleeve checks the cap once per name, right after hashing its inputs, so the names
// that reached the check are exactly the debate rows with a non-empty inputs_hash, in decision order
export function journalledSpendCap(rows: readonly JournalledCheck[]): SpendCap {
  const seen = new Set<string>();
  const verdicts: SpendCapVerdict[] = [];
  for (const row of rows) {
    if (row.sleeve_id !== DEBATE_SLEEVE_ID || seen.has(row.instrument)) continue;
    seen.add(row.instrument);
    if (row.inputs_hash !== '') verdicts.push(verdictOf(row));
  }
  return { check: () => verdicts.shift() ?? ADMITTED };
}
