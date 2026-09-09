import type { AnalystFailureKind, AnalystOrchestrator } from '../../../pipeline/analysts/index.js';
import type { AnalystView } from '../../../pipeline/debate-engine/index.js';
import type { Clock, LogEntry, Logger } from '../../../shared/index.js';
import { AnalystSkipKindRelay } from '../analysts-decision.js';
import type { TickSteps } from '../types.js';
import {
  type AnalystSkipAlert,
  buildAnalystsStep,
  composeMarketIntelligence,
} from './analysts-adapter.js';
import { MiCoverageMonitor } from './mi-coverage.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const BAR = new Date('2026-07-28T14:00:00Z');

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

describe('buildAnalystsStep', () => {
  it('narrows AnalystRunResult to bare AnalystView[] and passes the 4-arg call through unmodified (#811: bar)', async () => {
    const views = [makeView()];
    const runAnalysts = vi.fn(async () => ({
      views,
      analyst_count: 1,
      skipped: false,
      failures: [],
    }));
    const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

    const step = buildAnalystsStep(orchestrator);
    const result = await step({
      trace_id: 'trace-1',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock: CLOCK,
      bar: BAR,
    });

    expect(result).toBe(views);
    expect(runAnalysts).toHaveBeenCalledWith(
      'trace-1',
      { asset: 'AAPL', asset_class: 'stocks' },
      CLOCK,
      BAR,
    );
  });

  describe('skip kinds (#1080)', () => {
    function skippingOrchestrator(kind: AnalystFailureKind): AnalystOrchestrator {
      const runAnalysts = vi.fn(async () => ({
        views: [],
        analyst_count: 2,
        skipped: true,
        failures: [
          {
            analyst_type: 'technical',
            role: 'mandatory' as const,
            reason: 'technical did not answer within 10000ms (after 2 attempts)',
            kind,
          },
        ],
      }));
      return { runAnalysts } as unknown as AnalystOrchestrator;
    }

    async function run(step: TickSteps['analysts'], trace_id = 'trace-1') {
      await step({
        trace_id,
        signal: { asset: 'AAPL', asset_class: 'stocks' },
        clock: CLOCK,
        bar: BAR,
      });
    }

    it('hands the runner the cause of the skip it just returned', async () => {
      // The narrowing to `views` is what threw the reasons away; this carries
      // back the one bit the audit row needs, keyed on the pass that produced
      // it so concurrent instruments cannot read each other's.
      const skipKinds = new AnalystSkipKindRelay();
      await run(buildAnalystsStep(skippingOrchestrator('timeout'), undefined, { skipKinds }));

      expect(skipKinds.take('trace-1')).toBe('timeout');
    });

    it('distinguishes a fault from a deadline', async () => {
      const skipKinds = new AnalystSkipKindRelay();
      await run(buildAnalystsStep(skippingOrchestrator('transport'), undefined, { skipKinds }));

      expect(skipKinds.take('trace-1')).toBe('fault');
    });

    it('records nothing for a pass that produced views', async () => {
      const runAnalysts = vi.fn(async () => ({
        views: [makeView()],
        analyst_count: 1,
        skipped: false,
        failures: [],
      }));
      const skipKinds = new AnalystSkipKindRelay();
      await run(
        buildAnalystsStep({ runAnalysts } as unknown as AnalystOrchestrator, undefined, {
          skipKinds,
        }),
      );

      expect(skipKinds.take('trace-1')).toBeUndefined();
    });

    it('records the kind even when the alert transport throws', async () => {
      // The alert fires on the second consecutive skip and is deliberately
      // allowed to fail without taking the tick down. The audit row's reason
      // must not be collateral damage from that: the runner reads the relay
      // immediately after this step returns.
      const skipKinds = new AnalystSkipKindRelay();
      const step = buildAnalystsStep(skippingOrchestrator('timeout'), undefined, {
        skipKinds,
        skipAlerts: {
          postAnalystSkipAlert: async () => {
            throw new Error('telegram is down');
          },
        },
      });

      await run(step, 'trace-1');
      await run(step, 'trace-2');

      expect(skipKinds.take('trace-2')).toBe('timeout');
    });
  });

  it('preserves the empty-array quorum-skip contract', async () => {
    const runAnalysts = vi.fn(async () => ({
      views: [],
      analyst_count: 2,
      skipped: true,
      failures: [{ analyst_type: 'technical', role: 'mandatory', reason: 'timeout' }],
    }));
    const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

    const step = buildAnalystsStep(orchestrator);
    const result = await step({
      trace_id: 'trace-1',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock: CLOCK,
      bar: BAR,
    });

    expect(result).toEqual([]);
  });

  /**
   * Issue #358 item 4. The crypto-endpoint outage was invisible for exactly one
   * reason: `runAnalysts` collected a per-persona `failures` list and this
   * adapter threw it away, so the tick log showed `analysts: quorum_skip` at
   * `info` and nothing else — a hard, total data outage rendered
   * indistinguishable from a considered no-trade. The failure reasons have to
   * reach the operator's log.
   */
  describe('failure surfacing (issue #358)', () => {
    function captureLogger(): { logger: Logger; entries: LogEntry[] } {
      const entries: LogEntry[] = [];
      return { logger: { log: (entry) => entries.push(entry) }, entries };
    }

    it('logs a mandatory-analyst failure at error level with the reason and analyst', async () => {
      const { logger, entries } = captureLogger();
      const runAnalysts = vi.fn(async () => ({
        views: [],
        analyst_count: 2,
        skipped: true,
        failures: [
          { analyst_type: 'technical', role: 'mandatory', reason: 'Alpaca API error: http 404' },
        ],
      }));
      const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

      const step = buildAnalystsStep(orchestrator, logger);
      const result = await step({
        trace_id: 'trace-9',
        signal: { asset: 'BTC-USD', asset_class: 'crypto' },
        clock: CLOCK,
        bar: BAR,
      });

      expect(result).toEqual([]);
      expect(entries).toHaveLength(1);
      const [entry] = entries as [LogEntry];
      expect(entry.level).toBe('error');
      expect(entry.stage).toBe('analysts');
      expect(entry.trace_id).toBe('trace-9');
      // The operator has to be able to read the cause out of the line itself.
      expect(entry.message).toContain('BTC-USD');
      expect(entry.message).toContain('technical');
      expect(entry.message).toContain('http 404');
    });

    it('logs an optional-analyst failure at warn level even though the tick proceeds', async () => {
      const { logger, entries } = captureLogger();
      const runAnalysts = vi.fn(async () => ({
        views: [makeView()],
        analyst_count: 2,
        skipped: false,
        failures: [
          { analyst_type: 'sentiment', role: 'optional', reason: 'no intelligence items' },
        ],
      }));
      const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

      const step = buildAnalystsStep(orchestrator, logger);
      const result = await step({
        trace_id: 'trace-9',
        signal: { asset: 'BTC-USD', asset_class: 'crypto' },
        clock: CLOCK,
        bar: BAR,
      });

      expect(result).toHaveLength(1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as LogEntry).level).toBe('warn');
      expect((entries[0] as LogEntry).message).toContain('sentiment');
    });

    it('stays silent when every analyst succeeded', async () => {
      const { logger, entries } = captureLogger();
      const runAnalysts = vi.fn(async () => ({
        views: [makeView()],
        analyst_count: 1,
        skipped: false,
        failures: [],
      }));
      const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

      const step = buildAnalystsStep(orchestrator, logger);
      await step({
        trace_id: 'trace-9',
        signal: { asset: 'AAPL', asset_class: 'stocks' },
        clock: CLOCK,
        bar: BAR,
      });

      expect(entries).toEqual([]);
    });

    /**
     * PR #360 review thread. `failure.reason` is an upstream-controlled string:
     * `classifyAlpacaDataResponse` bakes the provider's RESPONSE BODY into the
     * message, and `classifyAlpacaDataNetworkError` bakes an arbitrary
     * `error.message` in with no cap at all. No live path puts a credential
     * there today (Alpaca authenticates by header, never by URL; the Telegram
     * token — the one credential this system carries IN a URL — is unreachable
     * from an analyst, which depends only on MarketDataService and the
     * in-memory MarketIntelligenceStore). But "no path today" is not a property
     * this log line should depend on, so the reason is bounded and known
     * credential-carrying syntaxes are masked before it is written.
     *
     * Mirrors the `TelegramBotApiClient` "never leaks the bot token" tests
     * rather than introducing a second convention.
     */
    describe('credential safety (PR #360 review)', () => {
      const FAKE_BOT_TOKEN = '1234567:test-fake-bot-token-AAHrandomlookingsuffix';

      it('masks a Telegram-shaped bot token in a failure reason', async () => {
        const { logger, entries } = captureLogger();
        const runAnalysts = vi.fn(async () => ({
          views: [],
          analyst_count: 1,
          skipped: true,
          failures: [
            {
              analyst_type: 'technical',
              role: 'mandatory',
              reason: `network error: request to https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage failed`,
            },
          ],
        }));
        const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

        const step = buildAnalystsStep(orchestrator, logger);
        await step({
          trace_id: 'trace-9',
          signal: { asset: 'BTC-USD', asset_class: 'crypto' },
          clock: CLOCK,
          bar: BAR,
        });

        const serialized = JSON.stringify(entries);
        expect(serialized).not.toContain(FAKE_BOT_TOKEN);
        expect(serialized).toContain('[REDACTED]');
        // Still says which analyst died and that it was a network error.
        expect(serialized).toContain('technical');
        expect(serialized).toContain('network error');
      });

      it('masks key=value and Bearer credential syntaxes', async () => {
        const { logger, entries } = captureLogger();
        const runAnalysts = vi.fn(async () => ({
          views: [],
          analyst_count: 1,
          skipped: true,
          failures: [
            {
              analyst_type: 'technical',
              role: 'mandatory',
              reason:
                'Alpaca API error: 403 {"apiKey":"sk-live-SUPERSECRET1","auth":"Bearer tok-SUPERSECRET2","api_secret=SUPERSECRET3"}',
            },
          ],
        }));
        const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

        const step = buildAnalystsStep(orchestrator, logger);
        await step({
          trace_id: 'trace-9',
          signal: { asset: 'BTC-USD', asset_class: 'crypto' },
          clock: CLOCK,
          bar: BAR,
        });

        const serialized = JSON.stringify(entries);
        expect(serialized).not.toContain('SUPERSECRET1');
        expect(serialized).not.toContain('SUPERSECRET2');
        expect(serialized).not.toContain('SUPERSECRET3');
        expect(serialized).toContain('403');
      });

      it('bounds an unbounded upstream reason instead of writing it whole', async () => {
        const { logger, entries } = captureLogger();
        const runAnalysts = vi.fn(async () => ({
          views: [],
          analyst_count: 1,
          skipped: true,
          failures: [
            { analyst_type: 'technical', role: 'mandatory', reason: `boom ${'x'.repeat(50_000)}` },
          ],
        }));
        const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

        const step = buildAnalystsStep(orchestrator, logger);
        await step({
          trace_id: 'trace-9',
          signal: { asset: 'BTC-USD', asset_class: 'crypto' },
          clock: CLOCK,
          bar: BAR,
        });

        const serialized = JSON.stringify(entries);
        expect(serialized.length).toBeLessThan(2_000);
        expect(serialized).toContain('truncated');
        expect(serialized).toContain('boom');
      });

      /**
       * The guard must not undo item 4. A real mandatory-analyst failure — the
       * exact string the live paper run produced — has to survive intact, or we
       * are back to a quorum skip with no stated cause.
       */
      it('leaves a real indicator-width failure completely untouched', async () => {
        const { logger, entries } = captureLogger();
        const realReason =
          'computeIndicator: sma(14) needs 14 bars but received 13. Computing it anyway would ' +
          'present a value derived from 13 bars as a 14-period one — a fabricated indicator, ' +
          'not a degraded one, and every stop sized from it is mispriced.';
        const runAnalysts = vi.fn(async () => ({
          views: [],
          analyst_count: 1,
          skipped: true,
          failures: [{ analyst_type: 'technical', role: 'mandatory', reason: realReason }],
        }));
        const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

        const step = buildAnalystsStep(orchestrator, logger);
        await step({
          trace_id: 'trace-9',
          signal: { asset: 'BTC-USD', asset_class: 'crypto' },
          clock: CLOCK,
          bar: BAR,
        });

        const [entry] = entries as [LogEntry];
        expect(entry.message).toContain(realReason);
        expect(entry.message).not.toContain('[REDACTED]');
      });
    });

    /**
     * #431, analysts-spec.md story 25. The retry absorbs a blip; this is what
     * catches the condition the retry cannot fix — a bad key, a data outage, a
     * rate-limit wall — where every tick skips and, before this, nothing said
     * so. The heartbeat keeps beating throughout, and at ADR-0008's 15-minute
     * cadence one skipped tick per beat looks like a working system.
     */
    describe('consecutive-skip alert (#431)', () => {
      function skipping() {
        return vi.fn(async () => ({
          views: [],
          analyst_count: 2,
          skipped: true,
          failures: [{ analyst_type: 'technical', role: 'mandatory' as const, reason: 'http 404' }],
        }));
      }

      function recordingChannel() {
        const posted: AnalystSkipAlert[] = [];
        return {
          posted,
          channel: {
            postAnalystSkipAlert: async (alert: AnalystSkipAlert) => {
              posted.push(alert);
            },
          },
        };
      }

      function tick(step: ReturnType<typeof buildAnalystsStep>, asset = 'BTC-USD') {
        return step({
          trace_id: 'trace-9',
          signal: { asset, asset_class: 'crypto' as const },
          clock: CLOCK,
          bar: BAR,
        });
      }

      it('stays quiet on a single isolated skip', async () => {
        const { posted, channel } = recordingChannel();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;

        await tick(buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel }));

        expect(posted).toEqual([]);
      });

      it('fires on the second consecutive skip, naming the instrument and the reasons', async () => {
        const { posted, channel } = recordingChannel();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel });

        await tick(step);
        await tick(step);

        expect(posted).toHaveLength(1);
        expect(posted[0]?.instrument).toBe('BTC-USD');
        expect(posted[0]?.consecutive_skips).toBe(2);
        expect(posted[0]?.reported_at).toEqual(NOW);
        expect(posted[0]?.failures[0]?.reason).toContain('http 404');
      });

      it('does not re-alert on every subsequent skip', async () => {
        const { posted, channel } = recordingChannel();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel });

        for (let i = 0; i < 5; i++) await tick(step);

        expect(posted).toHaveLength(1);
      });

      it('repeats while the stage stays broken, so a missed first alert is not the only one', async () => {
        const { posted, channel } = recordingChannel();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel });

        // 2 fires, then every ALERT_REPEAT_EVERY_SKIPS after: 2 and 10.
        for (let i = 0; i < 10; i++) await tick(step);

        expect(posted.map((alert) => alert.consecutive_skips)).toEqual([2, 10]);
      });

      it('resets the run on a healthy tick, so intermittent failures never accumulate', async () => {
        const { posted, channel } = recordingChannel();
        // ONE step, whose orchestrator's answer changes between calls — the
        // counter lives in the step's closure, so a second `buildAnalystsStep`
        // would start from zero and prove nothing about the reset.
        let skips = true;
        const runAnalysts = vi.fn(async () =>
          skips
            ? {
                views: [],
                analyst_count: 2,
                skipped: true,
                failures: [
                  { analyst_type: 'technical', role: 'mandatory' as const, reason: 'http 404' },
                ],
              }
            : { views: [makeView()], analyst_count: 2, skipped: false, failures: [] },
        );
        const step = buildAnalystsStep(
          { runAnalysts } as unknown as AnalystOrchestrator,
          undefined,
          {
            skipAlerts: channel,
          },
        );

        // skip, recover, skip, recover, skip — never two in a row, never an alert.
        for (const skipping of [true, false, true, false, true]) {
          skips = skipping;
          await tick(step);
        }

        expect(posted).toEqual([]);

        // And the counter really is back at zero: two in a row now alerts at 2,
        // not at some accumulated total.
        skips = true;
        await tick(step);
        expect(posted.map((alert) => alert.consecutive_skips)).toEqual([2]);
      });

      it('counts each instrument separately', async () => {
        const { posted, channel } = recordingChannel();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel });

        // One skip each: a fleet-wide blip is not two skips on one instrument.
        await tick(step, 'BTC-USD');
        await tick(step, 'ETH-USD');

        expect(posted).toEqual([]);

        await tick(step, 'BTC-USD');
        expect(posted.map((alert) => alert.instrument)).toEqual(['BTC-USD']);
      });

      it('masks credential syntaxes in the alerted reasons too', async () => {
        const { posted, channel } = recordingChannel();
        const runAnalysts = vi.fn(async () => ({
          views: [],
          analyst_count: 1,
          skipped: true,
          failures: [
            {
              analyst_type: 'technical',
              role: 'mandatory' as const,
              reason: 'Alpaca API error: 403 {"apiKey":"sk-live-SUPERSECRET1"}',
            },
          ],
        }));
        const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, undefined, { skipAlerts: channel });

        await tick(step);
        await tick(step);

        expect(JSON.stringify(posted)).not.toContain('SUPERSECRET1');
      });

      it('does not let a failed alert transport take the tick down', async () => {
        const { logger, entries } = captureLogger();
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator, logger, {
          skipAlerts: {
            postAnalystSkipAlert: async () => {
              throw new Error('Telegram 502');
            },
          },
        });

        await tick(step);
        await expect(tick(step)).resolves.toEqual([]);

        const undelivered = entries.filter((entry) =>
          entry.message.includes('could not be delivered'),
        );
        expect(undelivered).toHaveLength(1);
        expect(undelivered[0]?.level).toBe('error');
      });

      // #1280. The undelivered-alert line runs inside the analysts step, which
      // `TickRunner` wraps in `runWithTraceId` — and which holds `trace_id` as
      // a parameter besides. Pinned against the tick's OWN `analyst_panel_
      // degraded` line rather than a literal, so the assertion is that the two
      // join, which is the property the field is read for. Any constant in the
      // field breaks the equality on the first tick; a wrong-tick id breaks it
      // on the second, whose trace differs.
      it('logs an undelivered alert under the tick that raised it, not a category label', async () => {
        const failing = {
          postAnalystSkipAlert: async () => {
            throw new Error('Telegram 502');
          },
        };

        async function tracesOfSecondTick(traces: readonly [string, string]) {
          const { logger, entries } = captureLogger();
          const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
          const step = buildAnalystsStep(orchestrator, logger, { skipAlerts: failing });
          for (const trace_id of traces) {
            await step({
              trace_id,
              signal: { asset: 'BTC-USD', asset_class: 'crypto' as const },
              clock: CLOCK,
              bar: BAR,
            });
          }
          const traceOf = (event: string) =>
            entries.filter((entry) => entry.event === event).at(-1)?.trace_id;
          return {
            undelivered: traceOf('analyst_skip_alert_send_failed'),
            sibling: traceOf('analyst_panel_degraded'),
          };
        }

        const first = await tracesOfSecondTick(['trace-a1', 'trace-a2']);
        expect(first.undelivered).toBe(first.sibling);
        expect(first.undelivered).toBe('trace-a2');

        const second = await tracesOfSecondTick(['trace-b1', 'trace-b2']);
        expect(second.undelivered).toBe(second.sibling);
        expect(second.undelivered).toBe('trace-b2');
      });

      it('is optional — no channel means log-only, and no throw', async () => {
        const orchestrator = { runAnalysts: skipping() } as unknown as AnalystOrchestrator;
        const step = buildAnalystsStep(orchestrator);

        await tick(step);
        await expect(tick(step)).resolves.toEqual([]);
      });
    });

    it('is optional — an omitted logger keeps the pre-existing 1-arg call working', async () => {
      const runAnalysts = vi.fn(async () => ({
        views: [],
        analyst_count: 1,
        skipped: true,
        failures: [{ analyst_type: 'technical', role: 'mandatory', reason: 'boom' }],
      }));
      const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

      await expect(
        buildAnalystsStep(orchestrator)({
          trace_id: 'trace-9',
          signal: { asset: 'AAPL', asset_class: 'stocks' },
          clock: CLOCK,
          bar: BAR,
        }),
      ).resolves.toEqual([]);
    });
  });

  /**
   * #752: the coverage check is wired at the tick boundary, not merely
   * declared. Verifying by call, not by inspection — a `coverage` option
   * that this adapter never reached would be exactly this repo's dominant
   * defect class (a tested mechanism nothing calls).
   */
  describe('market-intelligence coverage (#752)', () => {
    function passingOrchestrator(): AnalystOrchestrator {
      const runAnalysts = vi.fn(async () => ({
        views: [makeView()],
        analyst_count: 1,
        skipped: false,
        failures: [],
      }));
      return { runAnalysts } as unknown as AnalystOrchestrator;
    }

    it('calls the coverage context source once per tick, for the ticking instrument', async () => {
      const getContext = vi.fn(() => ({
        timestamp: NOW,
        asset_class: 'stocks' as const,
        news: [],
        social: [],
        intel: [],
        stale: true,
        last_updated: null,
      }));
      const step = buildAnalystsStep(passingOrchestrator(), undefined, {
        coverage: {
          contextSource: { getContext },
          subclassOf: {},
          telemetry: { noDataObserved: vi.fn() },
          alertChannel: { postCoverageAlert: vi.fn(async () => undefined) },
          monitor: new MiCoverageMonitor(),
          logger: undefined,
        },
      });

      await step({
        trace_id: 'trace-1',
        signal: { asset: '3USL', asset_class: 'stocks' },
        clock: CLOCK,
        bar: BAR,
      });

      expect(getContext).toHaveBeenCalledTimes(1);
      expect(getContext).toHaveBeenCalledWith('stocks', expect.any(Number), 'trace-1');
    });

    it('does not gate the tick — the analysts still run and views still return when coverage is missing', async () => {
      const orchestrator = passingOrchestrator();
      const step = buildAnalystsStep(orchestrator, undefined, {
        coverage: {
          contextSource: {
            getContext: () => ({
              timestamp: NOW,
              asset_class: 'stocks' as const,
              news: [],
              social: [],
              intel: [],
              stale: true,
              last_updated: null,
            }),
          },
          subclassOf: {},
          telemetry: { noDataObserved: vi.fn() },
          alertChannel: { postCoverageAlert: vi.fn(async () => undefined) },
          monitor: new MiCoverageMonitor(),
          logger: undefined,
        },
      });

      const result = await step({
        trace_id: 'trace-1',
        signal: { asset: '3USL', asset_class: 'stocks' },
        clock: CLOCK,
        bar: BAR,
      });

      expect(orchestrator.runAnalysts).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('is optional — an absent coverage option calls nothing and does not throw', async () => {
      const orchestrator = passingOrchestrator();
      const step = buildAnalystsStep(orchestrator);

      await expect(
        step({
          trace_id: 'trace-1',
          signal: { asset: '3USL', asset_class: 'stocks' },
          clock: CLOCK,
          bar: BAR,
        }),
      ).resolves.toHaveLength(1);
    });
  });
});

describe('composeMarketIntelligence (#969)', () => {
  function refresher(calls: string[], name: string, options: { throws?: boolean } = {}) {
    return {
      async refresh() {
        calls.push(name);
        if (options.throws === true) throw new Error(`${name} failed`);
        return true;
      },
    };
  }

  it('runs every agent, because they write different buckets', async () => {
    // The defect this exists to prevent: the composition root used to bind
    // ONE agent, so with the news path available the sentiment agent — the
    // only `social` writer — was never called at all. A retrieving client
    // nothing calls is this repo's characteristic bug, not a new one.
    const calls: string[] = [];

    const composed = composeMarketIntelligence([
      refresher(calls, 'news'),
      refresher(calls, 'social'),
    ]);
    await composed?.refresh('t1', 'TSLA', 'stocks');

    expect(calls).toEqual(['news', 'social']);
  });

  it('keeps going when one agent fails', async () => {
    // One provider's outage must not empty the other's bucket, and must not
    // fail a tick that would otherwise have traded.
    const calls: string[] = [];

    const composed = composeMarketIntelligence([
      refresher(calls, 'news', { throws: true }),
      refresher(calls, 'social'),
    ]);

    await expect(composed?.refresh('t1', 'TSLA', 'stocks')).resolves.toBe(true);
    expect(calls).toEqual(['news', 'social']);
  });

  it('returns undefined when there is nothing to run', () => {
    // `undefined` is the honest "no writer" state the analysts step already
    // handles — not a no-op refresher that would look like a working one.
    expect(composeMarketIntelligence([undefined, undefined])).toBeUndefined();
  });

  it('passes a single agent through unwrapped', () => {
    const single = refresher([], 'only');
    expect(composeMarketIntelligence([undefined, single])).toBe(single);
  });
});
