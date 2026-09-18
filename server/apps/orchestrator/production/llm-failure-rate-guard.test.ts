import { describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../../../shared/index.js';
import {
  CHECK_FAILURE_LOG_EVERY,
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
    expect(monitor.observe(LLM_FAILURE_RATE_THRESHOLD, true, 5)).toEqual({ alert: true });
  });

  it('does not fire again on the next tick while still elevated (edge-triggered)', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: true });
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: false });
    expect(monitor.observe(0.6, true, 3)).toEqual({ alert: false });
  });

  it('re-arms once the rate drops back below the threshold, then fires again', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: true });
    expect(monitor.observe(0.1, true, 1)).toEqual({ alert: false });
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: true });
  });

  it('never fires below the sample floor, and does not clear a latch on ambiguous (nonzero-count) evidence either', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: true });
    expect(monitor.observe(0.9, false, 1)).toEqual({ alert: false });
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: false });
  });

  it('does not fire below the threshold', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(LLM_FAILURE_RATE_THRESHOLD - 0.01, true, 1)).toEqual({ alert: false });
  });

  it('never fires on zero failures, whatever the rate argument claims', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.9, true, 0)).toEqual({ alert: false });
  });

  it(
    'walks a failure storm through the trailing window and shows the latch re-arms ' +
      'once the storm ages fully out, even while the window stays below the sample floor ' +
      '(review round 2 finding 1)',
    () => {
      const monitor = new LlmFailureRateMonitor();

      expect(monitor.observe(0.75, true, 3)).toEqual({ alert: true });

      expect(monitor.observe(0.75, true, 3)).toEqual({ alert: false });

      expect(monitor.observe(0, false, 0)).toEqual({ alert: false });

      expect(monitor.observe(0.6, true, 3)).toEqual({ alert: true });
    },
  );
});

describe('checkLlmFailureRate', () => {
  it('fires and posts the alert when the rate crosses the threshold', async () => {
    const { channel, posted } = capturingChannel();
    const monitor = new LlmFailureRateMonitor();
    await checkLlmFailureRate(
      {
        windowSource: fixedSource({ llm_failure: 3, total: 6 }),
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
        windowSource: fixedSource({ llm_failure: 1, total: 10 }),
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
        windowSource: fixedSource({ llm_failure: 1, total: 1 }),
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

  it('logs at error and never throws when the (sync, SQLite-backed) window source throws (review round 1 F1)', async () => {
    const { logger, entries } = captureLogger();
    const throwingSource: LlmFailureRateWindowSource = {
      getTerminationCauseWindowCounts: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    const { channel, posted } = capturingChannel();

    await expect(
      checkLlmFailureRate(
        {
          windowSource: throwingSource,
          monitor: new LlmFailureRateMonitor(),
          alertChannel: channel,
          logger,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(posted).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', event: 'llm_failure_rate_check_failed' });
  });

  it('throttles llm_failure_rate_check_failed to the first failure and every Nth (review round 2 finding 8)', async () => {
    const { logger, entries } = captureLogger();
    const throwingSource: LlmFailureRateWindowSource = {
      getTerminationCauseWindowCounts: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    const monitor = new LlmFailureRateMonitor();

    for (let i = 0; i < CHECK_FAILURE_LOG_EVERY + 1; i += 1) {
      await checkLlmFailureRate(
        { windowSource: throwingSource, monitor, alertChannel: undefined, logger },
        NOW,
      );
    }

    expect(entries).toHaveLength(2);
  });

  it('resets the check-failure streak on a successful read, so a later outage logs its own first occurrence', async () => {
    const { logger, entries } = captureLogger();
    const monitor = new LlmFailureRateMonitor();
    const throwingSource: LlmFailureRateWindowSource = {
      getTerminationCauseWindowCounts: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    const healthySource = fixedSource({ llm_failure: 0, total: 0 });

    await checkLlmFailureRate(
      { windowSource: throwingSource, monitor, alertChannel: undefined, logger },
      NOW,
    );
    await checkLlmFailureRate(
      { windowSource: healthySource, monitor, alertChannel: undefined, logger },
      NOW,
    );
    await checkLlmFailureRate(
      { windowSource: throwingSource, monitor, alertChannel: undefined, logger },
      NOW,
    );

    const failures = entries.filter((entry) => entry.event === 'llm_failure_rate_check_failed');
    expect(failures).toHaveLength(2);
  });
});
