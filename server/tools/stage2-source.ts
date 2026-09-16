/**
 * Which aggregates source a Stage 2 run uses, and over what window.
 *
 * Stage 2 had exactly one source until now — `HttpPolygonClient` — and the
 * Polygon plan serves two years against a five-year request, so every verdict
 * to date was computed on ~500 stock bars. `FreeStackAggregatesClient` lifts
 * that to ten years at £0 on keys already held (see its module doc).
 *
 * **Polygon stays the default, deliberately.** `STAGE2_PINNED_WINDOW` exists
 * so a run is "reproducible to the millisecond", and several callers
 * (`run-stage2-cost-decomposition.ts`, `ingest-tiingo-history.ts`) are pinned
 * to it. Flipping the default would silently change what every existing
 * invocation measures, including the runs the prior verdicts were written
 * from. The free stack is opt-in via `STAGE2_SOURCE=free-stack`, so the diff
 * is additive and the old verdict stays reproducible by running the script
 * with no environment change at all.
 *
 * Both windows end at the same instant so the two verdicts differ only in how
 * far back the sample reaches — the variable under test.
 */

import { timeframeToMs } from '../providers/market-data-service/index.js';
import {
  type DateRange,
  DEFAULT_STAGE2_TIMEFRAME,
  FreeStackAggregatesClient,
  HttpPolygonClient,
  type PolygonClient,
} from './backtest/index.js';

/**
 * The exact window the 2026-08-05 verdict requested, to the millisecond.
 *
 * Pinned rather than computed from `new Date()`: a relative window shifts with
 * wall-clock time and with it every fold boundary, MinBTL count and selected
 * config, so two runs of "the same" command would not be comparable.
 */
export const STAGE2_PINNED_WINDOW: DateRange = {
  start: new Date('2021-08-06T18:17:07.694Z'),
  end: new Date('2026-08-05T18:17:07.694Z'),
};

/**
 * The free stack's reach. Requested from 2016-01-01 rather than from a
 * measured first-bar date: `effectiveWindow` in `run-stage2.ts` already
 * narrows the requested range to the intersection every symbol covers, so
 * asking early and letting it narrow keeps the true start a *measured*
 * property of the data rather than a constant that silently rots when a venue
 * extends its history.
 *
 * Measured 2026-08-07: Alpaca serves SPY daily from 2016-01-04 and Coinbase
 * serves ETH-USD from 2016-05-18, so the intersection lands mid-May 2016.
 */
export const STAGE2_FREE_STACK_WINDOW: DateRange = {
  start: new Date('2016-01-01T00:00:00.000Z'),
  end: STAGE2_PINNED_WINDOW.end,
};

type Stage2SourceLabel = 'polygon' | 'free-stack';

export interface Stage2Source {
  client: PolygonClient;
  window: DateRange;
  label: Stage2SourceLabel;
  /** The bar resolution this run ingests and replays (#664) */
  timeframe: string;
}

/**
 * The bar resolution a direct run uses — `STAGE2_TIMEFRAME`, default `'1d'`.
 *
 * Default daily, for the same reason `STAGE2_SOURCE` defaults to Polygon:
 * flipping it would silently change what every existing invocation measures,
 * including the runs the prior verdicts were written from. Intraday is opt-in,
 * so the diff stays additive.
 *
 * `STAGE2_TIMEFRAME=1m STAGE2_SOURCE=free-stack` is the invocation #664 exists
 * to make possible — Alpaca's free tier serves full SIP consolidated 1-minute
 * bars from 2016-01-04 (#656), which is why intraday is only offered on the
 * free stack. Polygon here is a free-tier fallback key (2-year window,
 * 5 req/min) and `HttpPolygonClient` refuses anything but `'1d'` outright.
 *
 * Validated through `timeframeToMs`, so a typo (`'1min'`) fails at resolution
 * rather than after the first vendor call.
 */
export function resolveStage2Timeframe(env: NodeJS.ProcessEnv = process.env): string {
  const timeframe = env.STAGE2_TIMEFRAME?.trim();
  if (timeframe === undefined || timeframe.length === 0) return DEFAULT_STAGE2_TIMEFRAME;
  timeframeToMs(timeframe);
  return timeframe;
}

/**
 * Resolves the source from the environment. Takes the environment as an
 * argument rather than reading `process.env` directly so the choice is
 * testable without mutating global state.
 */
export function resolveStage2Source(env: NodeJS.ProcessEnv = process.env): Stage2Source {
  const requested = env.STAGE2_SOURCE ?? 'polygon';
  const timeframe = resolveStage2Timeframe(env);

  if (requested === 'polygon') {
    return {
      // Conditional spread rather than `apiKey: env.POLYGON_API_KEY`:
      // `HttpPolygonClient`'s option is `apiKey?: string`, which under
      // `exactOptionalPropertyTypes` refuses an explicit `undefined`. Omitting
      // the key entirely is also what makes the client fall back to its own
      // `process.env` read and produce its own missing-key error message
      client: new HttpPolygonClient(
        env.POLYGON_API_KEY === undefined ? {} : { apiKey: env.POLYGON_API_KEY },
      ),
      window: STAGE2_PINNED_WINDOW,
      label: 'polygon',
      timeframe,
    };
  }

  if (requested === 'free-stack') {
    return {
      client: new FreeStackAggregatesClient({
        alpacaKeyId: env.ALPACA_API_KEY,
        alpacaSecretKey: env.ALPACA_API_SECRET,
      }),
      window: STAGE2_FREE_STACK_WINDOW,
      label: 'free-stack',
      timeframe,
    };
  }

  // Refused rather than defaulted: a typo silently producing a two-year
  // Polygon run, reported as if it were the ten-year one, is exactly the
  // failure this switch exists to make visible
  throw new Error(
    `resolveStage2Source: STAGE2_SOURCE='${requested}' is not recognised. ` +
      "Use 'polygon' (default, 2y) or 'free-stack' (10y).",
  );
}
