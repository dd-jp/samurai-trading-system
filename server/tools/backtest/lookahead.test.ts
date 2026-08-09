import { SimulatedClock } from '../../shared/index.js';
import { LookaheadAuditor, LookaheadViolationError } from './lookahead.js';

const T = new Date('2024-01-02T12:00:00.000Z');

describe('LookaheadAuditor', () => {
  it('passes a row timestamped before clock.now()', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));

    expect(() => auditor.auditRead('bars', new Date('2024-01-02T11:59:00.000Z'))).not.toThrow();
  });

  it('passes a row timestamped exactly at clock.now() (the current bar)', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));

    expect(() => auditor.auditRead('bars', new Date(T))).not.toThrow();
  });

  it('throws on a row timestamped after clock.now()', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));

    expect(() => auditor.auditRead('bars', new Date('2024-01-02T12:00:00.001Z'))).toThrow(
      LookaheadViolationError,
    );
  });

  it('carries the offending source, row timestamp and T on the error', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));
    const future = new Date('2024-01-03T00:00:00.000Z');

    try {
      auditor.auditRead('latest_mark', future);
      expect.unreachable('audit should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LookaheadViolationError);
      expect((error as LookaheadViolationError).violation).toEqual({
        source: 'latest_mark',
        row_timestamp: future,
        clock_now: T,
      });
    }
  });

  it('stops rejecting a future row once the clock steps up to it', () => {
    const clock = new SimulatedClock(T);
    const auditor = new LookaheadAuditor(clock);
    const nextBar = new Date('2024-01-02T13:00:00.000Z');

    expect(() => auditor.auditRead('bars', nextBar)).toThrow(LookaheadViolationError);

    clock.advanceTo(nextBar);

    expect(() => auditor.auditRead('bars', nextBar)).not.toThrow();
  });

  it('returns audited rows unchanged so it can wrap a read inline', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));
    const rows = [
      { timestamp: new Date('2024-01-02T11:00:00.000Z'), close: 1 },
      { timestamp: new Date('2024-01-02T11:30:00.000Z'), close: 2 },
    ];

    expect(auditor.auditRows('bars', rows)).toEqual(rows);
  });

  it('names the first offending row when auditing a batch', () => {
    const auditor = new LookaheadAuditor(new SimulatedClock(T));
    const rows = [
      { timestamp: new Date('2024-01-02T11:00:00.000Z') },
      { timestamp: new Date('2024-01-02T13:00:00.000Z') },
      { timestamp: new Date('2024-01-02T14:00:00.000Z') },
    ];

    try {
      auditor.auditRows('bars', rows);
      expect.unreachable('audit should have thrown');
    } catch (error) {
      expect((error as LookaheadViolationError).violation.row_timestamp).toEqual(
        new Date('2024-01-02T13:00:00.000Z'),
      );
    }
  });
});
