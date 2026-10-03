import { describe, expect, it } from 'vitest';
import { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import { classifySignalWindow } from './window.js';

const calendar = new UsEquityRegularHoursCalendar();

describe('classifySignalWindow', () => {
  it('processes a signal received in the regular session at once', () => {
    const receivedAt = new Date('2026-09-30T15:00:00.000Z');
    expect(classifySignalWindow(receivedAt, calendar)).toEqual({
      session: 'in_session',
      processAfter: receivedAt,
    });
  });

  it('queues a pre-market signal for the same morning open', () => {
    expect(classifySignalWindow(new Date('2026-09-30T12:00:00.000Z'), calendar)).toEqual({
      session: 'out_of_session',
      processAfter: new Date('2026-09-30T13:30:00.000Z'),
    });
  });

  it('queues a signal at the closing bell for the next session', () => {
    expect(classifySignalWindow(new Date('2026-09-30T20:00:00.000Z'), calendar)).toEqual({
      session: 'out_of_session',
      processAfter: new Date('2026-10-01T13:30:00.000Z'),
    });
  });

  it('queues a Saturday signal to Monday', () => {
    expect(
      classifySignalWindow(new Date('2026-10-03T15:00:00.000Z'), calendar).processAfter,
    ).toEqual(new Date('2026-10-05T13:30:00.000Z'));
  });

  it('treats the half-day afternoon as out of session', () => {
    expect(classifySignalWindow(new Date('2026-11-27T19:00:00.000Z'), calendar)).toEqual({
      session: 'out_of_session',
      processAfter: new Date('2026-11-30T14:30:00.000Z'),
    });
  });
});
