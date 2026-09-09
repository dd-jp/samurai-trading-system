import { describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../../../shared/index.js';
import {
  checkLlmFailureRate,
  LLM_FAILURE_RATE_THRESHOLD,
  LLM_FAILURE_RATE_WINDOW_MS,
  type LlmFailureRateAlert,
  type LlmFailureRateAlertChannel,
  LlmFailureRateMonitor,
  type LlmFailureRateWindowCounts,
  type LlmFailureRateWindowSource,
} from './llm-failure-rate-guard.js';

const NOW = new Date('2026-09-09T12:00:00Z');

function fixedSource(counts: LlmFailureRateWindowCounts): LlmFailureRateWindowSource {
  return { getTerminationCauseWindowCounts: () => counts };
}

function capturingChannel(): {
  channel: LlmFailureRateAlertChannel;
  posted: LlmFailureRateAlert[];
} {
  const posted: LlmFailureRateAlert[] = [];
  return {
    channel: {
      postLlmFailureRateAlert: (alert) => {
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

describe('LlmFailureRateMonitor', () => {
  it('fires the first time the rate crosses the threshold with enough samples', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(LLM_FAILURE_RATE_THRESHOLD, true)).toEqual({ alert: true });
  });

  it('does not fire again on the next tick while still elevated (edge-triggered)', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true)).toEqual({ alert: true });
    expect(monitor.observe(0.5, true)).toEqual({ alert: false });
    expect(monitor.observe(0.6, true)).toEqual({ alert: false });
  });

  it('re-arms once the rate drops back below the threshold, then fires again', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true)).toEqual({ alert: true });
    expect(monitor.observe(0.1, true)).toEqual({ alert: false });
    expect(monitor.observe(0.5, true)).toEqual({ alert: true });
  });

  it('never fires below the sample floor, and does not clear a latch either', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true)).toEqual({ alert: true });
    // A quiet window (too few samples) is "no evidence", not "recovered" —
    // the latch must stay set so a real recovery still re-arms cleanly.
    expect(monitor.observe(0.9, false)).toEqual({ alert: false });
    expect(monitor.observe(0.5, true)).toEqual({ alert: false });
  });

  it('does not fire below the threshold', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(LLM_FAILURE_RATE_THRESHOLD - 0.01, true)).toEqual({ alert: false });
  });
});

describe('checkLlmFailureRate', () => {
  it('fires and posts the alert when the rate crosses the threshold', async () => {
    const { channel, posted } = capturingChannel();
    const monitor = new LlmFailureRateMonitor();
    await checkLlmFailureRate(
      {
        windowSource: fixedSource({ llm_failure: 3, total: 6 }), // 0.5
        monitor,
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      rate: 0.5,
      llm_failure_count: 3,
      total_count: 6,
      window_ms: LLM_FAILURE_RATE_WINDOW_MS,
      reported_at: NOW,
    });
  });

  it('does not fire when the rate is under the threshold', async () => {
    const { channel, posted } = capturingChannel();
    await checkLlmFailureRate(
      {
        windowSource: fixedSource({ llm_failure: 1, total: 10 }), // 0.1
        monitor: new LlmFailureRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('does not fire below the minimum-sample floor even at a 100% rate', async () => {
    const { channel, posted } = capturingChannel();
    await checkLlmFailureRate(
      {
        windowSource: fixedSource({ llm_failure: 1, total: 1 }), // 1.0, but n=1
        monitor: new LlmFailureRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('does not fire, and does not divide by zero, on an empty window', async () => {
    const { channel, posted } = capturingChannel();
    await checkLlmFailureRate(
      {
        windowSource: fixedSource({ llm_failure: 0, total: 0 }),
        monitor: new LlmFailureRateMonitor(),
        alertChannel: channel,
        logger: undefined,
      },
      NOW,
    );

    expect(posted).toHaveLength(0);
  });

  it('logs at error and never throws when the alert channel rejects', async () => {
    const { logger, entries } = captureLogger();
    const failing: LlmFailureRateAlertChannel = {
      postLlmFailureRateAlert: () => {
        throw new Error('telegram down');
      },
    };

    await expect(
      checkLlmFailureRate(
        {
          windowSource: fixedSource({ llm_failure: 5, total: 5 }),
          monitor: new LlmFailureRateMonitor(),
          alertChannel: failing,
          logger,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      event: 'llm_failure_rate_alert_send_failed',
    });
  });

  it('does not throw and posts nothing when no alert channel is configured', async () => {
    await expect(
      checkLlmFailureRate(
        {
          windowSource: fixedSource({ llm_failure: 5, total: 5 }),
          monitor: new LlmFailureRateMonitor(),
          alertChannel: undefined,
          logger: undefined,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();
  });
});
