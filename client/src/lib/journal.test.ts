import { describe, expect, it } from 'vitest';
import { journalUrl, NO_FILTERS, outcomeOf } from './journal.ts';

describe('journalUrl', () => {
  it('asks for the newest page when nothing is filtered', () => {
    expect(journalUrl(NO_FILTERS, null)).toBe('/api/v2/journal');
  });

  it('sends only the filters that are set, trimmed, and the page cursor', () => {
    expect(
      journalUrl(
        { ...NO_FILTERS, book: ' debate/primary ', action: 'vetoed', instrument: '  ' },
        '2026-10-01',
      ),
    ).toBe('/api/v2/journal?book=debate%2Fprimary&action=vetoed&before=2026-10-01');
  });
});

describe('outcomeOf', () => {
  it.each([
    ['enter_long', false, 'entered long'],
    ['enter_short', false, 'entered short'],
    ['skip', false, 'skipped'],
    ['none', false, 'none'],
    ['skip', true, 'vetoed'],
  ] as const)('reads %s (vetoed %s) as %s', (action, vetoed, label) => {
    expect(outcomeOf({ action, vetoed, size_shares: 1 })).toBe(label);
  });

  it('does not call an entry sized zero entered, and leaves an exit of size zero alone', () => {
    expect(outcomeOf({ action: 'enter_long', vetoed: false, size_shares: 0 })).toBe(
      'not entered (size 0)',
    );
    expect(outcomeOf({ action: 'enter_short', vetoed: false, size_shares: 0 })).toBe(
      'not entered (size 0)',
    );
    expect(outcomeOf({ action: 'enter_long', vetoed: true, size_shares: 0 })).toBe('vetoed');
    expect(outcomeOf({ action: 'exit', vetoed: false, size_shares: 0 })).toBe('exited');
  });
});
