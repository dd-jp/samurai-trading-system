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
  skip: 'skipped',
  none: 'none',
};

export function outcomeOf(decision: { readonly action: SleeveAction; readonly vetoed: boolean }) {
  return decision.vetoed ? 'vetoed' : OUTCOMES[decision.action];
}
