/**
 * The mined eval executor (ticket #90) — pybroker's walk-forward/CPCV split +
 * eval-metric executor shape, over this component's own primitives. See
 * `eval-types.ts` for what "pybroker integration" means here and for the
 * fidelity caveat on the unavailable sources.
 *
 * It owns no math. Splits come from `generateSplits` (#89), metrics from
 * `computeMetrics` (#89), fill prices from `CostModel.fill` (#87) via the
 * replay that already ran. What it owns is the *sequencing*: attest the fills,
 * derive the series, cut the splits, score each test slice.
 *
 * That is also why acceptance criterion 2 ("same split boundaries as our own
 * generator") holds trivially — the executor calls that generator rather than
 * mining a second copy of the boundary arithmetic. Stated plainly because it
 * makes the criterion a wiring guard, not an agreement-between-two-derivations
 * result: it catches the executor silently re-cutting or shifting the splits
 * it was handed, and nothing stronger. The alternative — a pybroker-flavoured
 * reimplementation to cross-check against — is the duplicate implementation
 * the spec's "one implementation → live metrics == backtest metrics"
 * (cross-spec §5) exists to forbid.
 */

import type { ClosedTrade } from '../../shared/index.js';
import type {
  EvalExecutor,
  EvalOptions,
  EvalReport,
  ReplayTradeSource,
  SplitEval,
} from './eval-types.js';
import { computeMetrics } from './metrics.js';
import { generateSplits } from './splits.js';
import { assertCostModelPriced, toReturnSeries, toTradeSeries } from './trade-derivation.js';
import type { ReplayTimeline } from './types.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite } from './validation-types.js';

export interface EvalExecutorDeps {
  source: ReplayTradeSource;
  /** The same bar timeline the replay stepped — the return series' periods. */
  timeline: ReplayTimeline;
}

export class EvalExecutorImpl implements EvalExecutor {
  constructor(private readonly deps: EvalExecutorDeps) {}

  async evaluate(options: EvalOptions): Promise<EvalReport> {
    const trades = await this.deps.source.closedTrades(options.window);

    // Attestation first (AC 1): if any fill was priced by something other than
    // CostModel.fill, every number below is computed off optimistic fills.
    // Fail before producing them rather than after.
    for (const trade of trades) {
      assertCostModelPriced(trade, await this.deps.source.fills(trade.idempotency_key));
    }

    const bars = await this.deps.timeline.barTimestamps(options.window);

    const splits = generateSplits(options.window, options.scheme, {
      embargo: options.embargo,
      barMs: options.barMs,
    });

    const splitEvals: SplitEval[] = splits.map((split) => ({
      split,
      metrics: this.score(trades, bars, testRangeOf(split.test), options),
    }));

    return {
      window: this.score(trades, bars, options.window, options),
      splits: splitEvals,
    };
  }

  /** Score one contiguous sample — the whole window, or one split's test slice. */
  private score(
    trades: readonly ClosedTrade[],
    bars: readonly Date[],
    sample: DateRange,
    options: EvalOptions,
  ): MetricsSuite {
    const seriesOptions = { window: sample, averageCapital: options.averageCapital };
    const sampleTrades = trades.filter((trade) => within(trade.closed_at, sample));
    const sampleBars = bars.filter((bar) => within(bar, sample));

    return computeMetrics(
      toReturnSeries(sampleTrades, sampleBars, {
        ...seriesOptions,
        periodsPerYear: options.periodsPerYear,
      }),
      toTradeSeries(sampleTrades, seriesOptions),
    );
  }
}

/**
 * The sample a split's test side defines — and the reason CPCV is not scored
 * here yet.
 *
 * `MetricsSuite.exposure` is "fraction of the sample with a position open",
 * and `computeMetrics` takes that denominator from the single
 * `TradeSeries.window`. A walk-forward or CSCV test side is one contiguous
 * range, so the window is exactly the sample. A CPCV test side is *k* disjoint groups
 * (splits.ts: `CPCV_TEST_GROUPS = 2`), and the only single range spanning them
 * also spans the untested gap between them — which would silently inflate the
 * exposure denominator and under-report exposure on every CPCV split.
 *
 * Reporting a knowingly wrong number is worse than reporting none, so this
 * throws instead. Scoring CPCV honestly needs `TradeSeries` to carry a *list*
 * of sample ranges, which changes a #89 contract and every caller of it — out
 * of scope for this ticket, whose acceptance criteria are walk-forward. Split
 * *generation* for CPCV is unaffected and still works (#89).
 *
 * The `cscv` scheme (#406) holds out one group at a time, so its test side is
 * a single range and this restriction never bites — which is how the PBO
 * matrix gets built without extending `TradeSeries` first.
 */
function testRangeOf(test: readonly DateRange[]): DateRange {
  const range = test[0];

  if (range === undefined) {
    throw new Error('EvalExecutor: split has an empty test side — there is no sample to score.');
  }
  if (test.length > 1) {
    throw new Error(
      `EvalExecutor: cannot score a split with ${test.length} disjoint test ranges (CPCV). ` +
        'MetricsSuite.exposure is measured against a single contiguous TradeSeries.window, so ' +
        'spanning the gap between test groups would under-report exposure. Scoring CPCV needs ' +
        'TradeSeries to carry a list of sample ranges; use scheme "walk_forward" or "cscv" ' +
        'until it does.',
    );
  }

  return range;
}

/** Inclusive at both ends — a bar or close exactly on a boundary is in sample. */
function within(at: Date, range: DateRange): boolean {
  return at.getTime() >= range.start.getTime() && at.getTime() <= range.end.getTime();
}
