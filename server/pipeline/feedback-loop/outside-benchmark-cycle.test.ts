import type { ArmComparison } from '../control-arm/index.js';
import { noCostBasisDrops } from '../control-arm/index.js';
import type { BenchmarkObservation, BenchmarkSeriesSource } from '../outside-benchmark/index.js';
import { InMemoryOutsideBenchmarkSampleStore } from './fixture-stores.js';
import { runOutsideBenchmarkCycle } from './outside-benchmark-cycle.js';
import type { OutsideBenchmarkCycleInput } from './types/outside-benchmark.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:00:00.000Z');
const WINDOW_FROM = new Date('2026-08-05T09:15:00.000Z');
const WINDOW_TO = new Date('2026-08-31T20:00:00.000Z');

const COMPARISON: ArmComparison = {
  from: WINDOW_FROM,
  to: WINDOW_TO,
  basis: 1_000,
  live: {
    arm: 'live',
    trade_count: 7,
    realized_pnl_net: 21.5,
    return_pct: 0.0215,
    max_drawdown_pct: 0.04,
    refused_pass_count: 0,
    cost_basis_drops: noCostBasisDrops(),
  },
  control: {
    arm: 'control',
    trade_count: 6,
    realized_pnl_net: 4,
    return_pct: 0.004,
    max_drawdown_pct: 0.02,
    refused_pass_count: 0,
    cost_basis_drops: noCostBasisDrops(),
  },
};

const clock = { now: () => NOW };

class RecordingSeriesSource implements BenchmarkSeriesSource {
  readonly calls: { instrument: string; from: Date; to: Date }[] = [];

  constructor(private readonly byInstrument: Record<string, BenchmarkObservation[] | Error>) {}

  async getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]> {
    this.calls.push({ instrument, from, to });
    const entry = this.byInstrument[instrument];
    if (entry === undefined) throw new Error(`no fixture series for ${instrument}`);
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

function series(closes: readonly number[]): BenchmarkObservation[] {
  return closes.map((close, i) => ({
    close_time: new Date(WINDOW_FROM.getTime() + (i === 0 ? -DAY : i * DAY)),
    close,
  }));
}

function sources(spy: readonly number[], agg: readonly number[]): RecordingSeriesSource {
  return new RecordingSeriesSource({ SPY: series(spy), AGG: series(agg) });
}

describe('runOutsideBenchmarkCycle — the window is the matched control’s', () => {
  it('measures over the ArmComparison’s window, never a window of its own', async () => {
    const series = sources([100, 102, 104], [100, 100, 101]);
    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series,
      samples: new InMemoryOutsideBenchmarkSampleStore(),
    });

    expect(series.calls.length).toBeGreaterThan(0);
    for (const call of series.calls) {
      expect(call.from).toEqual(WINDOW_FROM);
      expect(call.to).toEqual(WINDOW_TO);
    }

    for (const sample of result.measured) {
      expect(sample.from).toEqual(WINDOW_FROM);
      expect(sample.to).toEqual(WINDOW_TO);
      expect(sample.computed_at).toEqual(NOW);
      expect(sample.to.getTime()).not.toBe(sample.computed_at.getTime());
    }
  });

  it('has no window parameter of its own to get wrong', () => {
    const input: OutsideBenchmarkCycleInput = {
      clock,
      comparison: COMPARISON,
      series: sources([100, 101], [100, 100]),
      samples: new InMemoryOutsideBenchmarkSampleStore(),
      // @ts-expect-error there is no `window_ms` on this input, by design. The
      window_ms: 30 * DAY,
    };
    expect(input).toBeTruthy();
  });
});

describe('runOutsideBenchmarkCycle — measures and persists both benchmarks', () => {
  it('persists SPY and 60/40, each with return AND drawdown', async () => {
    const samples = new InMemoryOutsideBenchmarkSampleStore();
    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series: sources([100, 110, 99], [100, 100, 100]),
      samples,
    });

    expect(result.unmeasured).toEqual([]);
    expect(result.measured.map((s) => s.performance.benchmark)).toEqual(['spy', 'sixty_forty']);

    const persisted = samples.getRecent(10, NOW);
    expect(persisted).toHaveLength(2);
    for (const sample of persisted) {
      expect(typeof sample.performance.buy_and_hold_return_pct).toBe('number');
      expect(typeof sample.performance.max_drawdown_pct).toBe('number');
      expect(sample.performance.observation_count).toBe(2);
    }

    const spy = persisted.find((s) => s.performance.benchmark === 'spy');
    const blend = persisted.find((s) => s.performance.benchmark === 'sixty_forty');
    expect(spy?.performance.max_drawdown_pct ?? 0).toBeGreaterThan(
      blend?.performance.max_drawdown_pct ?? 0,
    );
  });

  it('carries no divergence verdict and no alert channel — secondary, structurally', async () => {
    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series: sources([100, 130], [100, 100]),
      samples: new InMemoryOutsideBenchmarkSampleStore(),
    });

    for (const sample of result.measured) {
      expect('diverged' in sample).toBe(false);
      expect('divergence' in sample).toBe(false);
      expect('reason' in sample.performance).toBe(false);
    }
    expect('alerts' in result).toBe(false);
  });
});

describe('runOutsideBenchmarkCycle — unmeasurable is absent, never fabricated', () => {
  it('persists NOTHING for a benchmark whose series is unavailable', async () => {
    const samples = new InMemoryOutsideBenchmarkSampleStore();
    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series: new RecordingSeriesSource({ SPY: new Error('vendor 429'), AGG: series([100, 100]) }),
      samples,
    });

    expect(samples.getRecent(10, NOW)).toEqual([]);
    expect(result.measured).toEqual([]);
    expect(result.unmeasured.map((u) => u.benchmark)).toEqual(['spy', 'sixty_forty']);
    for (const unmeasured of result.unmeasured) {
      expect(unmeasured.reason).toMatch(/vendor 429/);
    }
  });

  it("does not let one benchmark's data gap cost the operator the other", async () => {
    const samples = new InMemoryOutsideBenchmarkSampleStore();
    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series: new RecordingSeriesSource({
        SPY: series([100, 105]),
        AGG: new Error('no bars for AGG'),
      }),
      samples,
    });

    expect(result.measured.map((s) => s.performance.benchmark)).toEqual(['spy']);
    expect(result.unmeasured.map((u) => u.benchmark)).toEqual(['sixty_forty']);
    expect(samples.getRecent(10, NOW)).toHaveLength(1);
  });

  it('reports a missing anchor as unmeasured rather than measuring a short window', async () => {
    const samples = new InMemoryOutsideBenchmarkSampleStore();
    const inWindowOnly = [1, 2].map((i) => ({
      close_time: new Date(WINDOW_FROM.getTime() + i * DAY),
      close: 100 + i,
    }));

    const result = await runOutsideBenchmarkCycle({
      clock,
      comparison: COMPARISON,
      series: new RecordingSeriesSource({ SPY: inWindowOnly, AGG: inWindowOnly }),
      samples,
    });

    expect(samples.getRecent(10, NOW)).toEqual([]);
    expect(result.unmeasured).toHaveLength(2);
    expect(result.unmeasured[0].reason).toMatch(/no close at or before the window start/);
  });
});
