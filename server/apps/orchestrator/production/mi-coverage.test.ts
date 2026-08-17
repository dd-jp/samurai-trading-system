import { describe, expect, it, vi } from 'vitest';

import type { MarketContext } from '../../../providers/market-intelligence/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import {
  checkMiCoverage,
  hasCoverageFor,
  type MiCoverageAlert,
  type MiCoverageAlertChannel,
  type MiCoverageContextSource,
  type MiCoverageEvent,
  MiCoverageMonitor,
  type MiCoverageTelemetry,
  subclassFor,
  UNCLASSIFIED_SUBCLASS,
} from './mi-coverage.js';

const NOW = new Date('2026-08-17T09:00:00Z');

function emptyContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    timestamp: NOW,
    asset_class: 'stocks',
    news: [],
    social: [],
    conflicts: [],
    stale: true,
    last_updated: null,
    ...overrides,
  };
}

function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('hasCoverageFor — presence, never direction', () => {
  it('is false when neither news nor social carries the instrument', () => {
    const context = emptyContext({
      news: [
        {
          id: '1',
          source: 'reuters',
          type: 'news',
          timestamp: NOW,
          entity: 'AAPL',
          headline: 'unrelated',
          sentiment: 1,
          confidence: 0.5,
        },
      ],
    });

    expect(hasCoverageFor(context, '3USL')).toBe(false);
  });

  it('is true from a news item matching the entity, regardless of sentiment', () => {
    const context = emptyContext({
      news: [
        {
          id: '1',
          source: 'reuters',
          type: 'news',
          timestamp: NOW,
          entity: '3USL',
          headline: 'bad news',
          sentiment: -1,
          confidence: 0.9,
        },
      ],
    });

    expect(hasCoverageFor(context, '3USL')).toBe(true);
  });

  it('is true from a social item matching the entity', () => {
    const context = emptyContext({
      social: [
        {
          id: '1',
          source: 'twitter',
          type: 'sentiment',
          timestamp: NOW,
          entity: 'BTC-USD',
          headline: 'chatter',
          sentiment: 0,
          confidence: 0.3,
        },
      ],
    });

    expect(hasCoverageFor(context, 'BTC-USD')).toBe(true);
  });

  /**
   * #752 acceptance criterion: "a pool of uniformly bearish items does not
   * raise it." Every item below is bearish; coverage must still read true —
   * the signal asks whether evidence EXISTS, never whether it agrees with a
   * direction (ADR-0016 D2 rules out catalyst-gating).
   */
  it('reads a uniformly bearish pool as covered, not as absent', () => {
    const context = emptyContext({
      news: [
        {
          id: '1',
          source: 'reuters',
          type: 'news',
          timestamp: NOW,
          entity: '3USL',
          headline: 'bearish 1',
          sentiment: -1,
          confidence: 0.8,
        },
        {
          id: '2',
          source: 'bloomberg',
          type: 'news',
          timestamp: NOW,
          entity: '3USL',
          headline: 'bearish 2',
          sentiment: -1,
          confidence: 0.9,
        },
      ],
      social: [
        {
          id: '3',
          source: 'twitter',
          type: 'sentiment',
          timestamp: NOW,
          entity: '3USL',
          headline: 'bearish 3',
          sentiment: -1,
          confidence: 0.7,
        },
      ],
    });

    expect(hasCoverageFor(context, '3USL')).toBe(true);
  });
});

describe('subclassFor', () => {
  it('reports the declared subclass', () => {
    expect(subclassFor('3USL', { '3USL': 'index_etp_3x' })).toBe('index_etp_3x');
  });

  /**
   * #752's dispatch note 1: `DEFAULT_UNIVERSE` declares no subclasses until
   * #749's pool file lands, so `subclassOfUniverse(DEFAULT_UNIVERSE)` is
   * `{}`. An unclassified name must bucket EXPLICITLY, not vanish — an empty
   * per-subclass report that reads as "full coverage" is exactly the failure
   * this ticket exists to prevent.
   */
  it('buckets an unclassified instrument under UNCLASSIFIED_SUBCLASS rather than dropping it', () => {
    expect(subclassFor('SPY', {})).toBe(UNCLASSIFIED_SUBCLASS);
  });
});

describe('MiCoverageMonitor', () => {
  it('is not degraded before anything is observed', () => {
    const monitor = new MiCoverageMonitor();
    expect(monitor.degraded).toBe(false);
  });

  it('flips degraded on the first miss and clears it on the next hit', () => {
    const monitor = new MiCoverageMonitor();

    const first = monitor.observe('3USL', false);
    expect(first).toEqual({ alert: true, consecutive: 1 });
    expect(monitor.degraded).toBe(true);
    expect(monitor.missingInstruments).toEqual(['3USL']);

    const recovered = monitor.observe('3USL', true);
    expect(recovered).toEqual({ alert: false, consecutive: 0 });
    expect(monitor.degraded).toBe(false);
    expect(monitor.missingInstruments).toEqual([]);
  });

  it('does not re-alert every consecutive miss, only at the bounded repeat', () => {
    const monitor = new MiCoverageMonitor();
    const results = Array.from({ length: 9 }, () => monitor.observe('3USL', false));

    // Alerts at consecutive=1, then again at consecutive=9 (1 + 8) — every
    // tick in between stays quiet, matching the analyst-skip/trader-diagnostic
    // bounded-repeat convention this module reuses.
    expect(results.map((r) => r.alert)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('tracks instruments independently', () => {
    const monitor = new MiCoverageMonitor();
    monitor.observe('3USL', false);
    monitor.observe('SPY', true);

    expect(monitor.degraded).toBe(true);
    expect(monitor.missingInstruments).toEqual(['3USL']);
  });

  /**
   * `degraded` is a live read and clears on recovery (by design, matching the
   * fail-open posture). `everDegraded` answers the different question an
   * end-of-run report needs: a coverage hole that opened and fully recovered
   * before anything inspected the monitor must still be visible in a
   * post-run summary, or a soak with hours of degraded coverage reports
   * "never degraded" the moment the gap happens to have closed by teardown.
   */
  it('everDegraded latches true on the first miss and never clears, unlike the live degraded flag', () => {
    const monitor = new MiCoverageMonitor();
    expect(monitor.everDegraded).toBe(false);

    monitor.observe('3USL', false);
    expect(monitor.everDegraded).toBe(true);
    expect(monitor.degraded).toBe(true);

    monitor.observe('3USL', true);
    expect(monitor.degraded).toBe(false);
    expect(monitor.everDegraded).toBe(true);
  });
});

function buildDeps(overrides: {
  covered?: boolean;
  subclassOf?: Record<string, 'index_etp_3x' | 'single_stock_etp_3x' | 'crypto'>;
  alertChannel?: MiCoverageAlertChannel;
  logger?: Logger;
  monitor?: MiCoverageMonitor;
}) {
  const contextSource: MiCoverageContextSource = {
    getContext: vi.fn(() =>
      emptyContext(
        overrides.covered
          ? {
              news: [
                {
                  id: '1',
                  source: 'alpaca',
                  type: 'news',
                  timestamp: NOW,
                  entity: '3USL',
                  headline: 'x',
                  sentiment: 1,
                  confidence: 0.5,
                },
              ],
            }
          : {},
      ),
    ),
  };
  const noDataEvents: MiCoverageEvent[] = [];
  const telemetry: MiCoverageTelemetry = {
    noDataObserved: (event) => noDataEvents.push(event),
  };
  const alertsPosted: MiCoverageAlert[] = [];
  const alertChannel: MiCoverageAlertChannel = overrides.alertChannel ?? {
    postCoverageAlert: async (alert) => {
      alertsPosted.push(alert);
    },
  };

  return {
    contextSource,
    telemetry,
    noDataEvents,
    alertsPosted,
    deps: {
      contextSource,
      subclassOf: overrides.subclassOf ?? {},
      telemetry,
      monitor: overrides.monitor ?? new MiCoverageMonitor(),
      alertChannel,
      logger: overrides.logger,
    },
  };
}

describe('checkMiCoverage', () => {
  it('records a per-name/per-subclass NO_DATA event and posts an alert naming the instrument on a miss', async () => {
    const { deps, noDataEvents, alertsPosted } = buildDeps({
      covered: false,
      subclassOf: { '3USL': 'index_etp_3x' },
    });

    await checkMiCoverage(deps, {
      trace_id: 'trace-1',
      instrument: '3USL',
      assetClass: 'stocks',
      reportedAt: NOW,
    });

    expect(noDataEvents).toHaveLength(1);
    expect(noDataEvents[0]).toMatchObject({
      instrument: '3USL',
      subclass: 'index_etp_3x',
      asset_class: 'stocks',
    });

    expect(alertsPosted).toHaveLength(1);
    expect(alertsPosted[0]).toMatchObject({
      instrument: '3USL',
      subclass: 'index_etp_3x',
      asset_class: 'stocks',
    });
  });

  it('bucketes the counter under UNCLASSIFIED_SUBCLASS when the universe declares no subclass', async () => {
    const { deps, noDataEvents } = buildDeps({ covered: false, subclassOf: {} });

    await checkMiCoverage(deps, {
      trace_id: 'trace-1',
      instrument: 'SPY',
      assetClass: 'stocks',
      reportedAt: NOW,
    });

    expect(noDataEvents[0]?.subclass).toBe(UNCLASSIFIED_SUBCLASS);
  });

  it('records nothing and posts no alert when the instrument is covered', async () => {
    const { deps, noDataEvents, alertsPosted } = buildDeps({ covered: true });

    await checkMiCoverage(deps, {
      trace_id: 'trace-1',
      instrument: '3USL',
      assetClass: 'stocks',
      reportedAt: NOW,
    });

    expect(noDataEvents).toHaveLength(0);
    expect(alertsPosted).toHaveLength(0);
  });

  it('sets the degraded-coverage flag on the monitor when coverage is missing', async () => {
    const monitor = new MiCoverageMonitor();
    const { deps } = buildDeps({ covered: false, monitor });

    expect(monitor.degraded).toBe(false);

    await checkMiCoverage(deps, {
      trace_id: 'trace-1',
      instrument: '3USL',
      assetClass: 'stocks',
      reportedAt: NOW,
    });

    expect(monitor.degraded).toBe(true);
    expect(monitor.missingInstruments).toContain('3USL');
  });

  /**
   * #752 acceptance criterion: "the run still starts... a test asserts the
   * degraded path does not refuse, block or halt the pipeline." This is the
   * test — `checkMiCoverage` resolves normally (does not throw, does not
   * return a value the caller could interpret as "stop") on every miss,
   * consecutive or not.
   */
  it('never throws on a coverage miss, including a long run of consecutive misses', async () => {
    const { deps } = buildDeps({ covered: false });

    for (let i = 0; i < 20; i += 1) {
      await expect(
        checkMiCoverage(deps, {
          trace_id: `trace-${i}`,
          instrument: '3USL',
          assetClass: 'stocks',
          reportedAt: NOW,
        }),
      ).resolves.toBeUndefined();
    }
  });

  /**
   * A failed alert transport must not become a failed tick — same posture as
   * `postSkipAlert` (analysts-adapter.ts). The tick has already produced its
   * answer by the time this runs.
   */
  it('never throws when the alert channel itself rejects, and logs the failure instead', async () => {
    const { logger, entries } = captureLogger();
    const failingChannel: MiCoverageAlertChannel = {
      postCoverageAlert: async () => {
        throw new Error('telegram is down');
      },
    };
    const { deps } = buildDeps({ covered: false, alertChannel: failingChannel, logger });

    await expect(
      checkMiCoverage(deps, {
        trace_id: 'trace-1',
        instrument: '3USL',
        assetClass: 'stocks',
        reportedAt: NOW,
      }),
    ).resolves.toBeUndefined();

    expect(entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('never throws when no alert channel is configured at all', async () => {
    const { deps } = buildDeps({ covered: false });
    // Simulate the "absent channel" composition-root state directly.
    (deps as { alertChannel: MiCoverageAlertChannel | undefined }).alertChannel = undefined;

    await expect(
      checkMiCoverage(deps, {
        trace_id: 'trace-1',
        instrument: '3USL',
        assetClass: 'stocks',
        reportedAt: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});
