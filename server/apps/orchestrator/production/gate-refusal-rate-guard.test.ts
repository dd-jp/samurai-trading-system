import { describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../../../shared/index.js';
import {
  checkGateRefusalRate,
  GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY,
  GATE_REFUSAL_RATE_THRESHOLD,
  GATE_REFUSAL_RATE_WINDOW_MS,
  type GateRefusalRateAlert,
  type GateRefusalRateAlertChannel,
  GateRefusalRateMonitor,
  type GateRefusalWindowCounts,
  type GateRefusalWindowSource,
  MIN_DECISIONS_FOR_GATE_REFUSAL_RATE,
} from './gate-refusal-rate-guard.js';

const NOW = new Date('2026-09-15T12:00:00Z');

function fixedSource(counts: GateRefusalWindowCounts): GateRefusalWindowSource {
  return { getGateRefusalWindowCounts: () => counts };
}

function capturingChannel(): {
  channel: GateRefusalRateAlertChannel;
  posted: GateRefusalRateAlert[];
} {
  const posted: GateRefusalRateAlert[] = [];
  return {
    channel: {
      postGateRefusalRateAlert: (alert) => {
        posted.push(alert);
      },
    },
    posted,
  };
}

function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('GATE_REFUSAL_RATE_THRESHOLD', () => {
  it.each([
    { instruments: 6, baseline: 4 / 6 },
    { instruments: 20, baseline: 18 / 20 },
  ])('sits above the designed $instruments-instrument baseline', ({ baseline }) => {
    expect(GATE_REFUSAL_RATE_THRESHOLD).toBeGreaterThan(baseline);
  });
});

describe('GateRefusalRateMonitor', () => {
  it('fires the first time the ratio crosses the threshold with enough samples', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.observe(GATE_REFUSAL_RATE_THRESHOLD, true, 40)).toEqual({ alert: true });
  });

  it('does not fire again while still elevated (edge-triggered)', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
    expect(monitor.observe(1, true, 41)).toEqual({ alert: false });
  });

  it('re-arms once the ratio drops back below the threshold, then fires again', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
    expect(monitor.observe(2 / 3, true, 40)).toEqual({ alert: false });
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
  });

  it('neither fires nor clears through the rate branch below the sample floor', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
    expect(monitor.observe(0.1, false, 1)).toEqual({ alert: false });
    expect(monitor.observe(1, true, 40)).toEqual({ alert: false });
  });

  it('re-arms on zero refusals regardless of the sample floor', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
    expect(monitor.observe(0, false, 0)).toEqual({ alert: false });
    expect(monitor.observe(1, true, 40)).toEqual({ alert: true });
  });

  it('logs the first check failure and then every Nth', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.recordCheckFailure()).toBe(true);
    for (let i = 2; i < GATE_REFUSAL_CHECK_FAILURE_LOG_EVERY; i += 1) {
      expect(monitor.recordCheckFailure()).toBe(false);
    }
    expect(monitor.recordCheckFailure()).toBe(true);
  });

  it('resets the streak on a successful check', () => {
    const monitor = new GateRefusalRateMonitor();
    expect(monitor.recordCheckFailure()).toBe(true);
    expect(monitor.recordCheckFailure()).toBe(false);
    monitor.recordCheckSuccess();
    expect(monitor.recordCheckFailure()).toBe(true);
  });
});

describe('checkGateRefusalRate', () => {
  it('posts on a window that is entirely refusals, with debate_log empty', async () => {
    const { channel, posted } = capturingChannel();
    await checkGateRefusalRate(
      {
        windowSource: fixedSource({ gate_refused: 40, debates_logged: 0 }),
        monitor: new GateRefusalRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toEqual([
      {
        rate: 1,
        gate_refused_count: 40,
        decision_count: 40,
        window_ms: GATE_REFUSAL_RATE_WINDOW_MS,
        reported_at: NOW,
      },
    ]);
  });

  it('stays silent at the designed four-of-six ratio at soak volume', async () => {
    const { channel, posted } = capturingChannel();
    await checkGateRefusalRate(
      {
        windowSource: fixedSource({ gate_refused: 384, debates_logged: 192 }),
        monitor: new GateRefusalRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('does not fire below the decision floor even at a 100% ratio', async () => {
    const { channel, posted } = capturingChannel();
    await checkGateRefusalRate(
      {
        windowSource: fixedSource({
          gate_refused: MIN_DECISIONS_FOR_GATE_REFUSAL_RATE - 1,
          debates_logged: 0,
        }),
        monitor: new GateRefusalRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('does not fire, and does not divide by zero, on an empty window', async () => {
    const { channel, posted } = capturingChannel();
    await checkGateRefusalRate(
      {
        windowSource: fixedSource({ gate_refused: 0, debates_logged: 0 }),
        monitor: new GateRefusalRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('reads a trailing window of exactly GATE_REFUSAL_RATE_WINDOW_MS', async () => {
    const reads: Array<{ from: Date; to: Date }> = [];
    await checkGateRefusalRate(
      {
        windowSource: {
          getGateRefusalWindowCounts: (from, to) => {
            reads.push({ from, to });
            return { gate_refused: 0, debates_logged: 0 };
          },
        },
        monitor: new GateRefusalRateMonitor(),
        alertChannel: undefined,
        logger: undefined,
      },
      NOW,
    );

    expect(reads).toEqual([
      { from: new Date(NOW.getTime() - GATE_REFUSAL_RATE_WINDOW_MS), to: NOW },
    ]);
  });

  it('logs and swallows a throwing window read rather than rejecting', async () => {
    const { logger, entries } = captureLogger();
    await expect(
      checkGateRefusalRate(
        {
          windowSource: {
            getGateRefusalWindowCounts: () => {
              throw new Error('SQLITE_BUSY');
            },
          },
          monitor: new GateRefusalRateMonitor(),
          alertChannel: undefined,
          logger,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(entries.map((entry) => entry.event)).toContain('gate_refusal_rate_check_failed');
  });

  it('logs and swallows a rejecting alert POST rather than rejecting', async () => {
    const { logger, entries } = captureLogger();
    await expect(
      checkGateRefusalRate(
        {
          windowSource: fixedSource({ gate_refused: 40, debates_logged: 0 }),
          monitor: new GateRefusalRateMonitor(),
          alertChannel: {
            postGateRefusalRateAlert: () => Promise.reject(new Error('telegram 502')),
          },
          logger,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(entries.map((entry) => entry.event)).toContain('gate_refusal_rate_alert_send_failed');
  });
});
