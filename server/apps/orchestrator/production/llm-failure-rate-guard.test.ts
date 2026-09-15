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
    // A quiet window (too few samples) that STILL holds a failure is "no
    // evidence either way" for a rate, not "recovered" — the latch must stay
    // set so a real recovery still re-arms cleanly. (A quiet window holding
    // ZERO failures is a different case — see the re-arm-below-the-floor
    // test below, round 2 finding 1.)
    expect(monitor.observe(0.9, false, 1)).toEqual({ alert: false });
    expect(monitor.observe(0.5, true, 3)).toEqual({ alert: false });
  });

  it('does not fire below the threshold', () => {
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(LLM_FAILURE_RATE_THRESHOLD - 0.01, true, 1)).toEqual({ alert: false });
  });

  it('never fires on zero failures, whatever the rate argument claims', () => {
    // Defensive: total===0 makes the real call site pass rate=0, but the
    // latch's own zero-count re-arm must not accidentally treat a stale or
    // malformed nonzero `rate` as a crossing when the count backing it is 0.
    const monitor = new LlmFailureRateMonitor();
    expect(monitor.observe(0.9, true, 0)).toEqual({ alert: false });
  });

  it(
    'walks a failure storm through the trailing window and shows the latch re-arms ' +
      'once the storm ages fully out, even while the window stays below the sample floor ' +
      '(review round 2 finding 1)',
    () => {
      const monitor = new LlmFailureRateMonitor();

      // t0: the storm hits. 3 llm_failure of 4 truncations, well over the
      // floor and threshold — fires once.
      expect(monitor.observe(0.75, true, 3)).toEqual({ alert: true });

      // t1: still elevated, same window shape — edge-triggered, stays silent.
      expect(monitor.observe(0.75, true, 3)).toEqual({ alert: false });

      // t2: the storm has mostly aged out of the trailing window. Only 1
      // clean (budget) truncation is left inside it — BELOW the floor, so no
      // rate can be trusted. Before the fix this returned `alert: false`
      // WITHOUT touching `#firing`, leaving the latch held forever once the
      // window never again holds >= MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE
      // llm_failure rows at once. llm_failure count in-window is already 0
      // here (the storm's failing rows aged out ahead of its clean ones) —
      // the fix clears on that alone, ignoring the sample floor.
      expect(monitor.observe(0, false, 0)).toEqual({ alert: false });

      // t3: a second, independent storm arrives. Without the t2 clear this
      // would stay silent (latch already held) — proving the re-arm, not
      // just the clear, is what the fix delivers.
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

  describe('gate refusals (#1533)', () => {
    it('fires on a window that is 100% gate-refused with debate_log itself reporting nothing (AC1)', async () => {
      // The scenario the acceptance criterion names verbatim: every debate in
      // the window was gate-refused. `debate_log` has zero rows for any of
      // them (`gateRefusedDebateResult` writes none), so `llm_failure`/`total`
      // read 0/0 — without folding `gate_refused` in, this window would look
      // like NO EVIDENCE rather than a 100%-refused outage.
      const { channel, posted } = capturingChannel();
      await checkLlmFailureRate(
        {
          windowSource: fixedSource({ llm_failure: 0, total: 0, gate_refused: 6 }),
          monitor: new LlmFailureRateMonitor(),
          alertChannel: channel,
          logger: undefined,
        },
        NOW,
      );

      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        rate: 1,
        llm_failure_count: 6,
        total_count: 6,
      });
    });

    it('blends gate refusals with genuine llm_failure rows in both numerator and denominator', async () => {
      const { channel, posted } = capturingChannel();
      await checkLlmFailureRate(
        {
          // 2 llm_failure + 3 gate_refused = 5 failure-like of (4 total + 3
          // gate_refused) = 7 sample -> ~0.714, over threshold.
          windowSource: fixedSource({ llm_failure: 2, total: 4, gate_refused: 3 }),
          monitor: new LlmFailureRateMonitor(),
          alertChannel: channel,
          logger: undefined,
        },
        NOW,
      );

      expect(posted).toHaveLength(1);
      expect(posted[0]?.rate).toBeCloseTo(5 / 7);
      expect(posted[0]).toMatchObject({ llm_failure_count: 5, total_count: 7 });
    });

    it('treats an absent gate_refused field as zero — a source that never reports refusals behaves exactly as before', async () => {
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

    it('does not fire below the sample floor even when gate refusals alone would read 100%', async () => {
      const { channel, posted } = capturingChannel();
      await checkLlmFailureRate(
        {
          // 3 gate_refused, 0 truncations -> sampleSize 3 < floor of 5.
          windowSource: fixedSource({ llm_failure: 0, total: 0, gate_refused: 3 }),
          monitor: new LlmFailureRateMonitor(),
          alertChannel: channel,
          logger: undefined,
        },
        NOW,
      );

      expect(posted).toHaveLength(0);
    });
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

    // `void checkLlmFailureRate(...)` is the real call site
    // (debate-adapter.ts) — its returned promise is never awaited, so if
    // this rejected it would become an unhandled rejection, which
    // `installFaultHandlers` (index.ts) treats as fatal and exits the
    // process. A transient DB error in this alerting side channel must
    // never do that to a process holding open positions.
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

    // First failure, then the CHECK_FAILURE_LOG_EVERY-th — two lines out of
    // CHECK_FAILURE_LOG_EVERY + 1 calls, not one per call.
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

    // Without the reset, the second outage's failure would land at streak
    // count 2 (neither `=== 1` nor a multiple of CHECK_FAILURE_LOG_EVERY) and
    // stay silent — one line total, not two.
    const failures = entries.filter((entry) => entry.event === 'llm_failure_rate_check_failed');
    expect(failures).toHaveLength(2);
  });
});
