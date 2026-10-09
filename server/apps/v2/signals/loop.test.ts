import { describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import type { SignalPass, SignalProcessorStore } from '../index.js';
import { SignalLoop, type SignalLoopDeps } from './loop.js';

const NOW = new Date('2026-09-30T14:00:00.000Z');

function harness(overrides: Partial<SignalLoopDeps> = {}, pass?: () => Promise<SignalPass>) {
  const logs: LogEntry[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const signals: SignalProcessorStore = {
    due: () => [{ signal_id: 's1' } as never],
    appendEvent: () => {},
    vetoVerdicts: () => [],
    recordVeto: () => {},
    vetoFor: () => undefined,
  };
  const processSignals = vi.fn(
    pass ?? (() => Promise.resolve<SignalPass>({ ran: true, outcomes: [] })),
  );
  const deps: SignalLoopDeps = {
    signals,
    calendar: { isOpen: () => true },
    clock: { now: () => NOW },
    logger: { log: (entry) => logs.push(entry) },
    openRoot: (tradingDate) => {
      opened.push(tradingDate);
      return { processSignals, close: () => closed.push(tradingDate) };
    },
    ...overrides,
  };
  return { loop: new SignalLoop(deps), logs, opened, closed, processSignals };
}

describe('SignalLoop', () => {
  it('opens a root for the ET session date, processes, reports and closes it', async () => {
    const { loop, logs, opened, closed, processSignals } = harness();
    await loop.tick();
    expect(opened).toEqual(['2026-09-30']);
    expect(closed).toEqual(['2026-09-30']);
    expect(processSignals).toHaveBeenCalledWith(expect.anything(), NOW);
    expect(logs.map((entry) => entry.event)).toEqual(['v2_signal_pass']);
  });

  it('never opens a root while the market is closed or nothing is due', async () => {
    const closedMarket = harness({ calendar: { isOpen: () => false } });
    await closedMarket.loop.tick();
    expect(closedMarket.opened).toEqual([]);
    const idle = harness({
      signals: {
        due: () => [],
        appendEvent: () => {},
        vetoVerdicts: () => [],
        recordVeto: () => {},
        vetoFor: () => undefined,
      },
    });
    await idle.loop.tick();
    expect(idle.opened).toEqual([]);
  });

  it('logs a calendar that throws past its coverage instead of rejecting the tick', async () => {
    const { loop, logs, opened } = harness({
      calendar: {
        isOpen: () => {
          throw new Error('calendar ends 2027-12-31');
        },
      },
    });
    await expect(loop.tick()).resolves.toBeUndefined();
    expect(opened).toEqual([]);
    expect(logs).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'v2_signal_pass_failed',
        message: 'calendar ends 2027-12-31',
      }),
    ]);
  });

  it('logs a skipped pass', async () => {
    const { loop, logs } = harness({}, () =>
      Promise.resolve({ ran: false, reason: 'lease_held', detail: 'cycle (pid 7)' }),
    );
    await loop.tick();
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'v2_signal_pass_skipped',
        message: 'lease_held: cycle (pid 7)',
      }),
    ]);
  });

  it('logs a failed pass and still closes the root', async () => {
    const { loop, logs, closed } = harness({}, () => Promise.reject(new Error('boom')));
    await loop.tick();
    expect(logs).toEqual([
      expect.objectContaining({ level: 'error', event: 'v2_signal_pass_failed', message: 'boom' }),
    ]);
    expect(closed).toEqual(['2026-09-30']);
  });

  it('logs a root that fails to open', async () => {
    const { loop, logs } = harness({
      openRoot: () => {
        throw new Error('no keys');
      },
    });
    await loop.tick();
    expect(logs.map((entry) => entry.message)).toEqual(['no keys']);
  });

  it('serialises ticks: one arriving mid-pass runs one more pass after it, never beside it', async () => {
    let release: () => void = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    const { loop, processSignals } = harness({}, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (processSignals.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      inFlight -= 1;
      return { ran: true, outcomes: [] };
    });
    const first = loop.tick();
    const second = loop.tick();
    const third = loop.tick();
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;
    expect(processSignals).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    await loop.tick();
    expect(processSignals).toHaveBeenCalledTimes(3);
  });

  it('reports a settled pass as ok and a thrown one as not ok, and nothing when no pass is due', async () => {
    const onPass = vi.fn();
    await harness({ onPass }).loop.tick();
    expect(onPass.mock.calls).toEqual([[true]]);
    onPass.mockClear();
    await harness({ onPass }, () => Promise.reject(new Error('boom'))).loop.tick();
    expect(onPass.mock.calls).toEqual([[false]]);
    onPass.mockClear();
    await harness({ onPass, calendar: { isOpen: () => false } }).loop.tick();
    expect(onPass).not.toHaveBeenCalled();
  });

  it('reports a root that fails to open as a failed pass', async () => {
    const onPass = vi.fn();
    await harness({
      onPass,
      openRoot: () => {
        throw new Error('no keys');
      },
    }).loop.tick();
    expect(onPass.mock.calls).toEqual([[false]]);
  });

  it('reports the age of the pass in flight and none when idle or after it ends', async () => {
    let nowMs = NOW.getTime();
    let release: () => void = () => {};
    const { loop } = harness(
      { clock: { now: () => new Date(nowMs) } },
      () =>
        new Promise<SignalPass>((resolve) => {
          release = () => resolve({ ran: true, outcomes: [] });
        }),
    );
    expect(loop.passAgeMs()).toBeUndefined();
    const running = loop.tick();
    nowMs += 90_000;
    expect(loop.passAgeMs()).toBe(90_000);
    release();
    await running;
    expect(loop.passAgeMs()).toBeUndefined();
  });

  it('has no pass age while nothing is due', async () => {
    const idle = harness({
      signals: {
        due: () => [],
        appendEvent: () => {},
        vetoVerdicts: () => [],
        recordVeto: () => {},
        vetoFor: () => undefined,
      },
    });
    await idle.loop.tick();
    expect(idle.loop.passAgeMs()).toBeUndefined();
  });

  it('clears the pass age when the pass throws', async () => {
    const { loop } = harness({}, () => Promise.reject(new Error('boom')));
    await loop.tick();
    expect(loop.passAgeMs()).toBeUndefined();
  });
});
