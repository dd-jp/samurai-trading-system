import type { AnalystOrchestrator } from '../../analysts/index.js';
import type { AnalystView } from '../../debate-engine/index.js';
import type { Clock, LogEntry, Logger } from '../../shared/index.js';
import { buildAnalystsStep } from './analysts-adapter.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

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
  it('narrows AnalystRunResult to bare AnalystView[] and passes the 3-arg call through unmodified', async () => {
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
    });

    expect(result).toBe(views);
    expect(runAnalysts).toHaveBeenCalledWith(
      'trace-1',
      { asset: 'AAPL', asset_class: 'stocks' },
      CLOCK,
    );
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
      });

      expect(entries).toEqual([]);
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
        }),
      ).resolves.toEqual([]);
    });
  });
});
