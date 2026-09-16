/**
 * The LSE mark source (#734) — the producer that writes `latest_mark` rows
 * keyed by `lse_ticker`.
 *
 * ## The hole this fills
 *
 * `market-data-service-spec.md` specs three `DataSource` implementations —
 * ccxt/Kraken, IBKR and Alpaca — and **none of them serves the LSE**. #1151
 * deleted the first two as unwired (both vendors are out of scope), leaving
 * Alpaca the only vendor source in the tree; it serves the LSE no better. Under
 * [ADR-0016](../../../../docs/adr/0016-universe-leveraged-etps-ungated.md) the
 * live equity universe is GBP LSE-listed leveraged ETPs held in a Saxo
 * Capital Markets UK GIA (ADR-0015's venue amendment), and
 * `server/providers/universe-pool/lse-etp-pool.ts` splits the
 * identity in two: `screening_instrument` (the liquid US underlying, which
 * Alpaca serves) is what the screener ranks, and `lse_ticker` is what Samurai
 * actually holds and routes. Nothing on the mark path knew the second identity
 * at all, so Verdict's `stale_feed` no-go (#641) and the Risk Manager's
 * valuation bound (#640) — both of which gate on `Mark.observed_at` for the
 * TRADED instrument — could never pass on the live equity leg.
 *
 * This class is the vendor-neutral half of the fix. The vendor-specific half
 * is `LseMarkClient`, which is injected: which vendor can lawfully serve a
 * real-time LSE quote is an open owner decision, recorded in
 * `docs/research/34-lse-mark-source-options.md`. Every candidate measured
 * there either cannot be used (no LSE coverage at all — Alpaca and Polygon
 * were re-probed with this project's own keys and answer `invalid symbol` /
 * an exchange list with no `XLON`), or cannot be used lawfully at £0, or needs
 * an access step only the owner can take (#895 — choosing and provisioning
 * the vendor). So this
 * ships with **no concrete client**: the seam, the normalisation, and the
 * refusals are decidable now; the vendor is not.
 *
 * ## Why marking off the US underlying is refused, structurally
 *
 * The issue is explicit that marking an LSE 3x ETP off its US underlying is
 * inadmissible — it is 3x-leveraged, differently denominated, and trades a
 * session that overlaps the US one by about two hours. Good enough to RANK a
 * candidate the evening before on completed bars; nowhere near good enough to
 * value an open position or fire a bracket. A comment saying so is not a
 * mechanism, so this class carries an ALLOW-LIST rather than a warning:
 * anything that is not an `lse_ticker` in the pool is refused, and the refusal
 * names the substitution explicitly when the caller passed a known
 * `screening_instrument`. `universe-selector-spec.md` asserts the mirror
 * invariant on the watchlist side; this is the same invariant on the mark
 * side.
 *
 * ## Why currency is a refusal and not a conversion
 *
 * Probing the pool's eleven tickers on 2026-08-18 (doc 34 §3) found the LSE
 * lines are **not uniformly GBP**: some quote in GBX/GBp (pence), some in USD,
 * and two rows of the checked-in pool disagree with the venue about which.
 * Two different failures follow, and they are not the same failure:
 *
 * - **GBX/GBp is a UNIT change, not a currency change.** `LQQ3` at `31240.0`
 *   is £312.40. Serving that number as a GBP mark is a 100x mispricing that
 *   every downstream check would wave through — the price is fresh, the
 *   timestamp is honest, the instrument is right. So pence are converted, and
 *   the conversion is exact, deterministic and needs no market data.
 * - **USD is a genuine currency**, and converting it needs an FX rate this
 *   system does not have and does not source. So it is REFUSED, loudly, at the
 *   mark. A GBP book valued partly in dollars breaches every cap at once and
 *   looks green while doing it.
 *
 * That refusal is deliberately inconvenient: TWELVE of the thirty-one pool
 * rows in `lse-etp-pool.ts` declare USD or EUR, so a universe naming one of
 * them cannot be marked. That is a real finding about the pool (doc 34 §3.2),
 * not a defect in this class.
 *
 * #1220 narrowed the universe rather than pricing the FX: `tradeableUniverse`
 * (universe-pool) now excludes every non-sterling row at SELECTION. This
 * refusal is the backstop, not a duplicate: it fires at `LseMarkDataSource`
 * construction over the lines actually held, so it still catches a universe
 * assembled without that selector.
 */
import { BOOK_CURRENCY, isBookCurrency, isPenceCurrency } from '../../../shared/index.js';
import type { RawCandle } from '../ingestion.js';
import { LseRegularHoursCalendar } from '../trading-calendar.js';
import type { Quote } from '../types.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

// `BOOK_CURRENCY`/`isBookCurrency` are re-exported below for this module's
// own existing consumers (its test, the `market-data-service` barrel) — the
// definitions themselves moved to `shared/book-currency.ts` under #1465,
// which also repoints `lse-etp-pool.ts`'s `isSterlingQuoted` at the same
// predicate instead of a hand-duplicated code list
export { BOOK_CURRENCY, isBookCurrency };

/**
 * A vendor quote whose currency this source cannot serve into a GBP book.
 *
 * Its own class, not a bare `Error`, because the two callers that matter treat
 * it differently from a transport failure: a failover wrapper must NOT retry
 * this on a second vendor (the currency is a property of the LISTING, so the
 * next vendor answers identically), and an operator reading it needs the
 * currency named to know whether the fix is an FX decision or a pool row.
 */
export class MarkCurrencyError extends Error {
  readonly instrument: string;
  readonly currency: string;

  constructor(instrument: string, currency: string, vendor: string) {
    super(
      `${vendor} quoted ${instrument} in '${currency}', which cannot be served into a ` +
        `${BOOK_CURRENCY} book. Pence (GBX/GBp) are converted because that is an exact unit ` +
        'change; any other currency needs an FX rate this system does not source, and inventing ' +
        'one would put a systematically wrong mark on the live-money path while every health ' +
        'signal stayed green. Either trade the GBP-denominated line of this ETP, or resolve the ' +
        'FX decision (docs/research/34-lse-mark-source-options.md §3.2) before marking this row.',
    );
    this.name = 'MarkCurrencyError';
    this.instrument = instrument;
    this.currency = currency;
  }
}

/**
 * The caller asked this source for an instrument that is not a tradeable
 * `lse_ticker`.
 *
 * The interesting case — and the one the issue names as "the failure mode
 * worth a test" — is a `screening_instrument`: `SPY` reaching a mark read for
 * `3SPY` is not a missing symbol, it is the US underlying being substituted
 * for the 3x LSE wrapper, which prices an open position off an instrument that
 * moves a third as fast in a different currency on a different session.
 */
export class NonTradeableInstrumentError extends Error {
  readonly instrument: string;

  constructor(instrument: string, tradeable: readonly string[], isScreeningInstrument: boolean) {
    super(
      isScreeningInstrument
        ? `LSE mark source refused '${instrument}': that is a SCREENING INSTRUMENT (the US ` +
            'underlying the screener ranks on), not an lse_ticker Samurai holds. Marking an LSE ' +
            '3x ETP off its US underlying is inadmissible — different leverage, different ' +
            'currency, and a session that overlaps by about two hours — so this substitution is ' +
            'refused at the source rather than warned about. Pass the lse_ticker (#734).'
        : `LSE mark source refused '${instrument}': it is not an lse_ticker in the LSE ETP pool ` +
            `(known: ${tradeable.join(', ') || 'none'}). There is no safe guess about which venue ` +
            'a symbol trades on, so there is no guess — add the row to lse-etp-pool.ts, or route ' +
            'this instrument to the source that actually serves its venue.',
    );
    this.name = 'NonTradeableInstrumentError';
    this.instrument = instrument;
  }
}

/** One vendor candle, in the vendor's own quoted currency */
interface LseVendorCandle {
  /** Source-native candle timestamp (period start) */
  open_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A vendor bar payload plus the currency every price in it is quoted in */
export interface LseVendorBars {
  /** e.g. 'GBX' | 'GBp' | 'GBP' | 'USD' — normalised or refused, never assumed. */
  currency: string;
  candles: readonly LseVendorCandle[];
}

/**
 * A vendor's latest observation for one LSE line.
 *
 * `observed_at` is the OBSERVATION's own time — the trade or quote timestamp
 * the venue stamped — never the time the request was made. That distinction is
 * the entire point of the ticket: `Mark.observed_at` is what #641 and #640
 * gate on, and a request-time stamp makes a mark that is hours old look
 * one second fresh. A client that cannot produce a real observation time is
 * not an admissible mark source and must throw rather than substitute
 * `new Date()`.
 *
 * `bid`/`ask` are optional and matter more here than on any other source.
 * These ETPs are market-maker quoted and thinly TRADED: measured over the five
 * sessions to 2026-08-19 (doc 34 §3.3, produced by
 * `docs/research/34-print-gap-measurement.py`), the median within-session gap
 * between prints runs from 2 minutes on the busiest line to 44 on the thinnest,
 * and on SEVEN of the eleven names more than 17% of consecutive-print gaps
 * exceed the 15-minute `max_mark_age.stocks` bound — 72.7% for `3AAP`, and an
 * eighth line (`3LPA`) printed four times in five whole sessions. A LAST-TRADE
 * mark therefore fails #641 by
 * illiquidity alone, on any vendor. A quote midpoint does not, because the
 * market maker refreshes it whether or not anyone trades.
 */
export interface LseVendorQuote {
  price: number;
  currency: string;
  observed_at: Date;
  bid?: number | undefined;
  ask?: number | undefined;
}

/**
 * The vendor seam. Injected, never constructed here — which vendor can lawfully
 * serve this is an open owner decision (doc 34), and keeping it a port is what
 * lets that decision land as a config change rather than a rewrite.
 */
export interface LseMarkClient {
  /** Vendor name, recorded on every `Bar.source` / `Mark.source` for audit */
  readonly vendor: string;
  getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<LseVendorBars>;
  getLatestQuote(symbol: string): Promise<LseVendorQuote>;
}

export interface LseMarkSourceOptions {
  /**
   * The `lse_ticker` values this source will serve, and nothing else. Defaults
   * to the checked-in pool's tickers — see `buildLseMarkSource`, which is how
   * the composition root supplies it.
   */
  tradeable: ReadonlySet<string>;
  /**
   * `screening_instrument` values, used ONLY to make the refusal message name
   * the real mistake. Never a routing key: nothing in this file can resolve a
   * screening instrument to a price, which is the property the two-field split
   * exists to guarantee.
   */
  screeningInstruments?: ReadonlySet<string> | undefined;
  /**
   * The currency each `lse_ticker` is DECLARED to trade in (`lse_ticker` ->
   * ISO-ish code), checked once at CONSTRUCTION rather than per read.
   *
   * Supplying it turns "this instrument cannot be priced into a GBP book" from
   * a throw on the first live tick into a refusal to boot. That distinction is
   * the whole of `buildLseMarkSourceIfNeeded`'s doctrine applied one level
   * down: a mid-tick `MarkCurrencyError` reaches an operator as a stage
   * failure on whichever instrument happened to be read first, with positions
   * possibly already open, whereas a startup error names every offending row at
   * once, before anything trades.
   *
   * It does NOT replace the per-read check. The declared value is hand-compiled
   * and has been measured wrong: probing the pool's eleven tickers on
   * 2026-08-18 (doc 34 §3.2) found `3AAP` declared `GBP` while the venue quotes
   * it in `GBp` — a 100x error — and `3QQQ` declared `USD` while the venue
   * quotes it in `GBp`. So the declaration is the CONSERVATIVE gate (refusing
   * early costs an opportunity) and the vendor's own currency field on each
   * payload stays AUTHORITATIVE (refusing late prevents a mispricing).
   *
   * Optional so a caller with no pool metadata — a test, a bespoke composition
   * root — keeps the per-read check alone.
   */
  declaredCurrencies?: ReadonlyMap<string, string> | undefined;
  /** Bar granularity a backtest mark is derived from */
  markTimeframe?: string | undefined;
}

/**
 * Converts a vendor price into `BOOK_CURRENCY`, or throws.
 *
 * Exported because the conversion is the part most worth testing directly: it
 * is the difference between £312.40 and £31,240, and it is applied to bars and
 * marks and quotes alike.
 */
export function toBookCurrency(
  price: number,
  currency: string,
  instrument: string,
  vendor: string,
): number {
  const code = currency.trim();
  // Pence FIRST: 'GBp' upper-cases to 'GBP', so a case-insensitive pound test
  // run first would swallow it and 100x the price
  if (isPenceCurrency(code)) {
    return price / 100;
  }
  if (code.toUpperCase() === BOOK_CURRENCY) {
    return price;
  }
  throw new MarkCurrencyError(instrument, currency, vendor);
}

/**
 * Refuse a set of declared currencies at CONSTRUCTION, naming every offending
 * row at once.
 *
 * The alternative — letting `toBookCurrency` throw on the first live read —
 * surfaces the same fact as a stage failure mid-tick, on whichever instrument
 * the pipeline happened to reach first, with positions possibly already open.
 * Refusing here costs an unstartable orchestrator, which is the cheaper of the
 * two failures and the one an operator can act on.
 */
function assertMarkableCurrencies(
  declared: ReadonlyMap<string, string> | undefined,
  vendor: string,
): void {
  if (declared === undefined) return;
  const offenders = [...declared]
    .filter(([, currency]) => !isBookCurrency(currency))
    .map(([instrument, currency]) => `${instrument} (${currency})`);
  if (offenders.length === 0) return;
  throw new Error(
    `LseMarkDataSource: cannot be constructed for ${offenders.join(', ')} — the pool declares ` +
      `${offenders.length === 1 ? 'this line' : 'these lines'} in a currency that is not ${BOOK_CURRENCY} ` +
      'or a pence sub-unit of it, and this system holds no FX rate. Marking them into a GBP book ' +
      'would require an FX decision nobody has made: see docs/research/34-lse-mark-source-options.md §3.2, ' +
      'which measured that most of the checked-in pool quotes in USD despite the GBP-only restriction ' +
      'ADR-0016/#659 asserts. #1220 narrowed the universe to the sterling lines — build the ' +
      'universe through tradeableUniverse() (universe-pool) and no such line can reach here. ' +
      `(vendor: ${vendor})`,
  );
}

/**
 * The LSE leveraged-ETP `DataSource`.
 *
 * `stocks` and the LSE session calendar are fixed at construction, exactly as
 * `AlpacaDataSource` fixes its own: `LseRegularHoursCalendar` is the calendar
 * the live equity leg already runs its flatten on (#668), and using the US
 * one here would drop every bar between 08:00 and 14:30 London and keep every
 * bar after 16:30.
 */
export class LseMarkDataSource extends NormalizingDataSource {
  readonly #client: LseMarkClient;
  readonly #tradeable: ReadonlySet<string>;
  readonly #screeningInstruments: ReadonlySet<string>;
  readonly #markTimeframe: string;

  constructor(client: LseMarkClient, options: LseMarkSourceOptions) {
    super({
      source: client.vendor,
      asset_class: 'stocks',
      calendar: new LseRegularHoursCalendar(),
    });
    if (options.tradeable.size === 0) {
      throw new Error(
        'LseMarkDataSource: constructed with an empty tradeable set, so every read would be ' +
          'refused. An empty allow-list is a wiring error, not a narrower source — supply the ' +
          'lse_ticker values from the LSE ETP pool (buildLseMarkSource).',
      );
    }
    assertMarkableCurrencies(options.declaredCurrencies, client.vendor);
    this.#client = client;
    this.#tradeable = options.tradeable;
    this.#screeningInstruments = options.screeningInstruments ?? new Set<string>();
    this.#markTimeframe = options.markTimeframe ?? '1m';
  }

  protected override get markTimeframe(): string {
    return this.#markTimeframe;
  }

  #assertTradeable(instrument: string): void {
    if (this.#tradeable.has(instrument)) return;
    throw new NonTradeableInstrumentError(
      instrument,
      [...this.#tradeable],
      this.#screeningInstruments.has(instrument),
    );
  }

  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]> {
    this.#assertTradeable(instrument);
    const { currency, candles } = await this.#client.getBars(
      instrument,
      timeframe,
      asOf,
      limit,
      partial,
    );
    const toBook = (price: number): number =>
      toBookCurrency(price, currency, instrument, this.#client.vendor);

    return candles.map((candle) => ({
      open_time: candle.open_time,
      open: toBook(candle.open),
      high: toBook(candle.high),
      low: toBook(candle.low),
      close: toBook(candle.close),
      // Volume is a SHARE count, not a price — converting it would be wrong
      volume: candle.volume,
    }));
  }

  /**
   * The vendor's latest observation, stamped at the vendor's own observation
   * time.
   *
   * Prefers the quote MIDPOINT when the vendor supplies a two-sided quote, and
   * falls back to the vendor's `price` otherwise. That preference is not
   * cosmetic on this universe: see `LseVendorQuote` for the measured print
   * gaps that make a last-trade mark fail #641 by illiquidity alone.
   */
  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    this.#assertTradeable(instrument);
    const quote = await this.#client.getLatestQuote(instrument);
    const raw = midpointOf(quote) ?? quote.price;

    return {
      price: toBookCurrency(raw, quote.currency, instrument, this.#client.vendor),
      observed_at: quote.observed_at,
    };
  }

  /**
   * The two-sided quote, when the vendor has one.
   *
   * `null` rather than a throw when it does not, matching the port's contract
   * ("only implemented by sources that quote bid/ask") and what
   * `getSpreadEstimate` already expects — a vendor without a book is a vendor
   * with no observable spread, not an error.
   */
  async fetchQuote(instrument: string): Promise<Quote | null> {
    this.#assertTradeable(instrument);
    const quote = await this.#client.getLatestQuote(instrument);
    if (quote.bid === undefined || quote.ask === undefined) return null;

    return {
      bid: toBookCurrency(quote.bid, quote.currency, instrument, this.#client.vendor),
      ask: toBookCurrency(quote.ask, quote.currency, instrument, this.#client.vendor),
      observed_at: quote.observed_at,
    };
  }
}

/** The midpoint of a two-sided quote, or `null` when the vendor gave only one side */
function midpointOf(quote: LseVendorQuote): number | null {
  if (quote.bid === undefined || quote.ask === undefined) return null;
  return (quote.bid + quote.ask) / 2;
}
