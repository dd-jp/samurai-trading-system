import { describe, expect, it } from 'vitest';
import {
  bothVenuesClosed,
  entryCutoff,
  exchangeOf,
  sessionDay,
  TABLE_VENUE_SESSIONS,
} from './venue-sessions.js';

const THANKSGIVING = '2026-11-26';
const UK_BANK_HOLIDAY = '2026-08-31';
const CHRISTMAS = '2026-12-25';
const SATURDAY = '2026-09-26';
const ORDINARY = '2026-09-30';

describe('exchangeOf', () => {
  it('maps each venue to the exchange whose hours it trades', () => {
    expect(exchangeOf('alpaca')).toBe('us');
    expect(exchangeOf('saxo_cfd_usd')).toBe('us');
    expect(exchangeOf('saxo')).toBe('lse');
    expect(exchangeOf('saxo_cfd_gbp')).toBe('lse');
  });
});

describe('sessionDay', () => {
  it.each([
    [THANKSGIVING, 'closed', 'open'],
    [UK_BANK_HOLIDAY, 'open', 'closed'],
    [CHRISTMAS, 'closed', 'closed'],
    [SATURDAY, 'closed', 'closed'],
    [ORDINARY, 'open', 'open'],
  ] as const)('%s: US %s, LSE %s', (date, us, lse) => {
    expect(sessionDay('us', date)).toBe(us);
    expect(sessionDay('lse', date)).toBe(lse);
  });

  it('reads a weekday past a hand table as uncovered, never open or closed', () => {
    expect(sessionDay('us', '2027-12-31')).toBe('open');
    expect(sessionDay('us', '2028-01-04')).toBe('uncovered');
    expect(sessionDay('lse', '2028-01-04')).toBe('open');
    expect(sessionDay('lse', '2028-12-29')).toBe('open');
    expect(sessionDay('lse', '2029-01-02')).toBe('uncovered');
  });

  it('still reads a weekend past both tables as closed', () => {
    expect(sessionDay('us', '2029-01-06')).toBe('closed');
    expect(sessionDay('lse', '2029-01-07')).toBe('closed');
  });
});

describe('bothVenuesClosed', () => {
  it.each([
    [THANKSGIVING, false],
    [UK_BANK_HOLIDAY, false],
    [CHRISTMAS, true],
    [SATURDAY, true],
    [ORDINARY, false],
    ['2028-01-04', false],
  ])('%s: %s', (date, closed) => {
    expect(bothVenuesClosed(date)).toBe(closed);
  });
});

const londonClock = (instant: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

describe('entryCutoff', () => {
  it('is the LSE open at 08:00 London and the NY open at 09:30 New York, in summer and winter', () => {
    expect(entryCutoff('lse', ORDINARY).toISOString()).toBe('2026-09-30T07:00:00.000Z');
    expect(entryCutoff('us', ORDINARY).toISOString()).toBe('2026-09-30T13:30:00.000Z');
    expect(entryCutoff('lse', '2026-12-01').toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(entryCutoff('us', '2026-12-01').toISOString()).toBe('2026-12-01T14:30:00.000Z');
  });

  it.each([
    ['2026-10-23', '14:30'],
    ['2026-10-26', '13:30'],
    ['2026-10-30', '13:30'],
    ['2026-11-02', '14:30'],
    ['2027-03-12', '14:30'],
    ['2027-03-15', '13:30'],
    ['2027-03-26', '13:30'],
    ['2027-03-29', '14:30'],
  ])('puts the US cutoff on %s at the NY open, %s London', (date, london) => {
    expect(londonClock(entryCutoff('us', date))).toBe(london);
    expect(londonClock(entryCutoff('lse', date))).toBe('08:00');
  });
});

describe('TABLE_VENUE_SESSIONS.entrySitOut', () => {
  const at = (iso: string) => new Date(iso);

  it('sits out a closed venue whatever the hour', () => {
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('alpaca', THANKSGIVING, at('2026-11-26T06:00:00Z')),
    ).toBe('venue_closed');
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('saxo_cfd_usd', THANKSGIVING, at('2026-11-26T06:00:00Z')),
    ).toBe('venue_closed');
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('saxo', THANKSGIVING, at('2026-11-26T06:00:00Z')),
    ).toBeUndefined();
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('saxo_cfd_gbp', UK_BANK_HOLIDAY, at('2026-08-31T06:00:00Z')),
    ).toBe('venue_closed');
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('alpaca', UK_BANK_HOLIDAY, at('2026-08-31T06:00:00Z')),
    ).toBeUndefined();
  });

  it('refuses entries on a date past the table rather than guessing it open', () => {
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('alpaca', '2028-01-04', at('2028-01-04T06:00:00Z')),
    ).toBe('venue_calendar_uncovered');
    expect(
      TABLE_VENUE_SESSIONS.entrySitOut('saxo', '2028-01-04', at('2028-01-04T06:00:00Z')),
    ).toBeUndefined();
  });

  it.each([
    ['saxo', '2026-09-30T06:59:59.999Z', undefined],
    ['saxo', '2026-09-30T07:00:00.000Z', 'late_wake_entry_cutoff'],
    ['saxo_cfd_gbp', '2026-09-30T07:00:00.000Z', 'late_wake_entry_cutoff'],
    ['alpaca', '2026-09-30T07:00:00.000Z', undefined],
    ['alpaca', '2026-09-30T13:29:59.999Z', undefined],
    ['alpaca', '2026-09-30T13:30:00.000Z', 'late_wake_entry_cutoff'],
    ['saxo_cfd_usd', '2026-09-30T13:30:00.000Z', 'late_wake_entry_cutoff'],
    ['saxo', '2026-12-01T07:59:59.999Z', undefined],
    ['saxo', '2026-12-01T08:00:00.000Z', 'late_wake_entry_cutoff'],
    ['alpaca', '2026-12-01T14:29:59.999Z', undefined],
    ['alpaca', '2026-12-01T14:30:00.000Z', 'late_wake_entry_cutoff'],
    ['alpaca', '2026-10-27T13:29:59.999Z', undefined],
    ['alpaca', '2026-10-27T13:30:00.000Z', 'late_wake_entry_cutoff'],
    ['saxo_cfd_usd', '2027-03-25T13:30:00.000Z', 'late_wake_entry_cutoff'],
    ['alpaca', '2027-03-25T13:29:59.999Z', undefined],
    ['saxo', '2027-03-25T07:59:59.999Z', undefined],
  ] as const)('%s at %s: %s', (venue, now, code) => {
    expect(TABLE_VENUE_SESSIONS.entrySitOut(venue, now.slice(0, 10), at(now))).toBe(code);
  });

  it('refuses entries for a past trading date run the next day', () => {
    expect(TABLE_VENUE_SESSIONS.entrySitOut('alpaca', ORDINARY, at('2026-10-01T06:30:00Z'))).toBe(
      'late_wake_entry_cutoff',
    );
  });
});

describe('TABLE_VENUE_SESSIONS.timeStopPausedVenues', () => {
  it.each([
    [THANKSGIVING, ['alpaca', 'saxo_cfd_usd']],
    [UK_BANK_HOLIDAY, ['saxo', 'saxo_cfd_gbp']],
    [CHRISTMAS, ['alpaca', 'saxo', 'saxo_cfd_gbp', 'saxo_cfd_usd']],
    [ORDINARY, []],
    ['2028-01-04', []],
  ])('%s pauses %j', (date, venues) => {
    expect(TABLE_VENUE_SESSIONS.timeStopPausedVenues(date)).toEqual(venues);
  });
});
