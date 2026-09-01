/**
 * Where the outside benchmarks' daily closes come from (#981).
 *
 * ## The data-availability finding this file records
 *
 * #981 required the data dependency be settled BEFORE building, because #895
 * (choose/provision the LSE real-time L1 mark vendor) is open. It is a different
 * need and does NOT block this: #895 is about real-time L1 marks for the LIVE
 * GBP LSE leg, while SPY and AGG are ordinary US-listed instruments served as
 * DAILY historical bars by the Alpaca source this repo already runs
 * (`sources/alpaca-source.ts`, routed to `/v2/stocks/...` by
 * `AssetClassRoutingDataSource`).
 *
 * Verified concretely against the live endpoint on 2026-09-01, on the feed the
 * codebase actually constructs (`DEFAULT_ALPACA_DATA_FEED = 'iex'`, not SIP —
 * the free-tier-safe default `alpaca-http-client.ts` documents): SPY, AGG, IEF,
 * BND and TLT each returned 30 daily bars over a 30-day window with no
 * subscription error. So the benchmark series needs no new vendor, no new key
 * and no new spend.
 *
 * ## Why a port rather than a direct `MarketDataService` dependency
 *
 * The same reason every other Feedback Loop input is one: the composition root
 * injects the real reader and tests inject a fake. It also keeps the benchmark
 * cycle synchronous-looking in its own tests while the real fetch is over HTTP.
 *
 * ## Which `MarketDataService` — NOT the pipeline's
 *
 * The instance passed here must be built on `buildBenchmarkDataSource`, not on
 * the pipeline's `components.marketData`. The latter is derived from the
 * configured `universe`: once #751 puts LSE tickers in it, its source becomes
 * `LseMarkDataSource` EXCLUSIVELY, and that source refuses `'SPY'` on purpose
 * — SPY is a `screening_instrument` (the US underlying a 3x LSE ETP tracks),
 * and marking the wrapper off the underlying is inadmissible (#734). Both
 * benchmarks would then sit in `unmeasured` forever with nothing failing,
 * which is precisely what #636 forbids: the outside benchmark is computed on
 * FL's own cadence, independent of what the live universe trades. Benchmarks
 * are reference series, never order targets, so no venue restriction reaches
 * them.
 */
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { BenchmarkObservation } from './outside-benchmark.js';

/** Daily closes for one benchmark leg, covering the window AND its anchor bar. */
export interface BenchmarkSeriesSource {
  /**
   * Closes for `instrument` spanning at least `[from, to]`, INCLUDING at least
   * one bar at or before `from` — `buildOutsideBenchmark` needs that anchor as
   * the denominator of the window's first daily return, and refuses to measure
   * without it rather than silently covering a shorter period than the arms.
   */
  getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trading days are fewer than calendar days, so asking for one bar per calendar
 * day of the window always over-fetches — which is the point: the surplus is
 * what guarantees the anchor bar at or before `from` exists even across a long
 * holiday weekend. Plus a small fixed pad for a window that starts on one.
 */
const ANCHOR_PAD_BARS = 5;

export class MarketDataBenchmarkSeriesSource implements BenchmarkSeriesSource {
  constructor(private readonly marketData: MarketDataService) {}

  async getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]> {
    const calendarDays = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
    const bars = await this.marketData.getBars(
      instrument,
      {
        timeframe: '1d',
        lookback: Math.max(calendarDays, 1) + ANCHOR_PAD_BARS,
        // `'allow'` rather than the default `'error'`, and deliberately: a short
        // series is DETECTABLE downstream — `buildOutsideBenchmark` refuses
        // outright when the anchor or the in-window closes are missing — so the
        // usual argument for `'error'` (a consumer that is silently wrong rather
        // than merely degraded, e.g. an SMA computed over 3 bars presented as
        // one over 50) does not apply here. Erroring on a partial window would
        // instead lose a benchmark on every early-soak day the venue simply has
        // less history than the pad asks for.
        partial: 'allow',
      },
      to,
    );

    return bars.map((bar) => ({ close_time: bar.close_time, close: bar.close }));
  }
}
