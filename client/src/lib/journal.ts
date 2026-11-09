import type { JournalActionFilterWire, SleeveAction } from '@contracts';

const JOURNAL_URL = '/api/v2/journal';

export interface JournalFilters {
  readonly from: string;
  readonly to: string;
  readonly book: string;
  readonly instrument: string;
  readonly action: JournalActionFilterWire | '';
  readonly veto: string;
}

export const NO_FILTERS: JournalFilters = {
  from: '',
  to: '',
  book: '',
  instrument: '',
  action: '',
  veto: '',
};

export function journalUrl(filters: JournalFilters, before: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const trimmed = value.trim();
    if (trimmed !== '') params.set(key, trimmed);
  }
  if (before !== null) params.set('before', before);
  const query = params.toString();
  return query === '' ? JOURNAL_URL : `${JOURNAL_URL}?${query}`;
}

const OUTCOMES: Readonly<Record<SleeveAction, string>> = {
  enter_long: 'entered long',
  enter_short: 'entered short',
  exit: 'exited',
  skip: 'skipped',
  none: 'none',
};

export function enteredNothing(decision: {
  readonly action: SleeveAction;
  readonly size_shares: number;
}): boolean {
  return decision.action.startsWith('enter_') && decision.size_shares === 0;
}

export function outcomeOf(decision: {
  readonly action: SleeveAction;
  readonly vetoed: boolean;
  readonly size_shares: number;
}) {
  if (decision.vetoed) return 'vetoed';
  return enteredNothing(decision) ? 'not entered (size 0)' : OUTCOMES[decision.action];
}
