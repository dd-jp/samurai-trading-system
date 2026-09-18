import {
  LIVE_MONEY_GATES,
  LIVE_MONEY_GATES_RECHECK_COMMAND,
} from '../apps/orchestrator/live-money-gates.js';

import {
  checkLiveMoneyGates,
  formatGateReport,
  type GateState,
  type IssueStateLookup,
} from './check-live-money-gates.js';

const GATES = [
  { issue: 111, gap: 'the first thing that gates a live boot and is long enough to be a claim' },
  { issue: 222, gap: 'the second thing that gates a live boot and is long enough to be a claim' },
] as const;

const lookupReturning = (states: Record<number, GateState>): IssueStateLookup =>
  vi.fn(async (issue: number) => states[issue] ?? 'UNKNOWN');

describe('checkLiveMoneyGates', () => {
  it('reports no staleness while every cited issue is open', async () => {
    const report = await checkLiveMoneyGates(
      lookupReturning({ 111: 'OPEN', 222: 'OPEN' }),
      GATES,
      '2026-08-18',
    );

    expect(report.stale).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(formatGateReport(report)).toContain('All cited issues are still OPEN');
  });

  it('names every cited issue that has closed — the property that decayed in #868', async () => {
    const report = await checkLiveMoneyGates(
      lookupReturning({ 111: 'CLOSED', 222: 'OPEN' }),
      GATES,
      '2026-08-07',
    );

    expect(report.stale.map((v) => v.issue)).toEqual([111]);
    const text = formatGateReport(report);
    expect(text).toContain('STALE: 1 cited issue(s) have closed: #111');
    expect(text).toContain('LIVE_MONEY_GATES_VERIFIED_ON');
  });

  it('treats a failed lookup as UNKNOWN, never as a cleared gate', async () => {
    const lookup: IssueStateLookup = vi.fn(async () => {
      throw new Error('gh: not authenticated');
    });

    const report = await checkLiveMoneyGates(lookup, GATES, '2026-08-18');

    expect(report.stale).toEqual([]);
    expect(report.unknown.map((v) => v.issue)).toEqual([111, 222]);
    expect(formatGateReport(report)).toContain('This is NOT a clearance');
  });

  it('defaults to the real gate list, so the command checks what the operator is shown', async () => {
    const lookup = lookupReturning({});

    const report = await checkLiveMoneyGates(lookup);

    expect(report.verdicts.map((v) => v.issue)).toEqual(LIVE_MONEY_GATES.map((g) => g.issue));
    expect(lookup).toHaveBeenCalledTimes(LIVE_MONEY_GATES.length);
  });

  it('is the command the live-boot warning tells the operator to run', () => {
    expect(LIVE_MONEY_GATES_RECHECK_COMMAND).toBe('npm run check:live-gates');
  });
});
