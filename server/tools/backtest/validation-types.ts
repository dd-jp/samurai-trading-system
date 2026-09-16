/**
 * Domain types & contracts for the Validation Library (ticket #89). See
 * docs/specs/cost-model-backtest-spec.md ("Module: Validation Library" —
 * Key Interface) and user stories 14-18, 20.
 *
 * These live beside `types.ts` (the #87/#88 cost-model + harness contracts)
 * rather than inside it: `types.ts` states the validation library is "a later
 * ticket ... not declared here", and the two seams have different callers.
 * The harness drives replay; this library is called by the Feedback Loop and
 * by offline research directly, without a replay in between (spec line 33).
 *
 * **`ValidationLibrary` is not declared as one interface here.** The spec
 * sketches it as a single object, but its members have no shared state
 * except the config-trial log, which is an injected port with its own
 * lifetime (`config-trial-log.ts`). The metric/split/DSR/PBO/MinBTL
 * primitives are pure functions of their arguments — binding them to an
 * instance would invent a construction seam the issue does not ask for and
 * that FL, per story 20, does not need in order to recompose them.
 */

import type { DateRange } from './universe.js';

/**
 * Periodic returns for one config over the sample, as fractions (0.01 = +1%),
 * in ascending time order and evenly spaced at `periodsPerYear`.
 *
 * Fractional rather than log returns because the drawdown and profit-factor
 * fields below are defined over realized equity, and the spec's expectancy is
 * a per-trade currency quantity — mixing log returns into that set would make
 * the suite's fields incommensurable.
 */
export interface ReturnSeries {
  returns: readonly number[];
  /**
   * Observations per year for annualization — 252 for daily stock bars, 365
   * for daily crypto bars. Explicit rather than inferred: the library is
   * handed a bare series and cannot know the bar cadence, and guessing it
   * silently mis-annualizes every ratio in the suite.
   */
  periodsPerYear: number;
}

/** One closed round-trip. The trade record the trade-derived metrics read. */
interface Trade {
  instrument: string;
  /**
   * Realized PnL in account currency, **net of costs** — the cost model has
   * already priced the fills this trade is derived from (spec: `CostModel.fill`
   * is the single fill authority). Expectancy is therefore net by
   * construction, per its spec definition "... − costs".
   */
  pnl: number;
  /** Absolute traded notional (entry + exit), the turnover numerator */
  notional: number;
  opened_at: Date;
  closed_at: Date;
}

/** The closed trades over the sample, in ascending `closed_at` order */
export interface TradeSeries {
  trades: readonly Trade[];
  /**
   * Average deployed capital over the sample, in account currency. Turnover is
   * traded notional / capital, so without it the ratio has no denominator.
   */
  averageCapital: number;
  /** The sample the trades were drawn from — the exposure denominator */
  window: DateRange;
}

/**
 * Reported together, never one number (spec: "Module: Validation Library",
 * user story 13).
 *
 * Declared in `contracts/metrics.ts` and re-exported here. It was never a
 * backtest-only shape: the Feedback Loop recomposes it into its live report
 * and `DashboardSnapshot.metrics` puts it on the operator's screen, so this
 * folder — named for an offline research harness — owned a type on the money
 * path. Moving the declaration is the whole of that fix; every import site,
 * including `index.ts`'s barrel, still resolves through here.
 */
export type { MetricsSuite } from '../../../contracts/index.js';

/**
 * One train/test split. Train is a list of ranges, not a single range: CPCV
 * removes the purged/embargoed bars from the middle of the train set, which
 * leaves it discontiguous.
 */
export interface Split {
  train: DateRange[];
  test: DateRange[];
}

/** The MinBTL guard's verdict for a window */
export interface MinBtlVerdict {
  /** Max independent trials the sample length supports (~45 / 5yr) */
  limit: number;
  /** N — distinct configs evaluated for selection */
  distinct_configs: number;
  /** `distinct_configs > limit` — the strategy has out-searched its data */
  exceeded: boolean;
}

/** PBO's verdict. `reject` is the spec's kill line: PBO > 0.05. */
export interface PboVerdict {
  /** Probability the in-sample-best config underperforms the median OOS */
  pbo: number;
  verdict: 'accept' | 'reject';
}
