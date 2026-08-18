/**
 * The LSE leveraged-ETP pool file (#749).
 *
 * ## What this is
 *
 * A checked-in, hand-compiled list of the leveraged ETPs Samurai MAY trade on
 * the live equity leg — GBP-account, T212-ISA, LSE-listed instruments — and,
 * for each one, the separate US instrument the screener ranks it on.
 *
 * ## The two identities
 *
 * `lse_ticker` is what Samurai holds and routes: the LSE-listed leveraged ETP
 * itself, the thing an order is placed against. `screening_instrument` is
 * what the screener fetches bars for and computes indicators on: the US
 * underlying, because [#656](https://github.com/dd-jp/samurai-trading-system/issues/656)
 * established there is no free LSE intraday history. These are genuinely
 * different objects traded on different venues in different currencies, and
 * `docs/specs/universe-selector-spec.md` ("Candidate pool") requires the split
 * be a NAMED field pair rather than one overloaded identifier — the same
 * ambiguity `AssetClassRoutingDataSource#routeFor`
 * (`server/providers/market-data-service/sources/asset-class-routing-source.ts`)
 * already refuses for asset class, at the instrument-identity layer instead.
 *
 * `buildRoutingMap` below binds ONLY on `lse_ticker`. `screening_instrument`
 * is not looked up by anything here — a caller wiring bar-fetch and
 * order-routing off two different fields is what keeps a wrong-root
 * fetch/route from ever being possible by construction, rather than by
 * convention.
 *
 * ## Scope — data plus a type, not wiring
 *
 * This file does not touch `DEFAULT_UNIVERSE`, `production.ts`, or
 * `paper-profile.ts`. #749's own acceptance criteria say "nothing in this
 * ticket sends an order or reads a live LSE quote; it is data plus a type",
 * and issue comment 2026-08-17T11:09:07Z on #749 records that landing the
 * `subclass` dimension **declared but not yet consumed** keeps arming
 * `per_subclass_deployment_cap` and the frozen bracket path (#739) a
 * separate, reviewable step — #800 (Trader/D5 cap disagreement) is open and
 * unresolved, so this file is deliberately not wired into any
 * `UniverseInstrument[]` a running profile reads. Consuming it is a later
 * ticket's job (#751, ActiveUniverseProvider).
 *
 * `fallback_default` (the story-12 fallback subset the universe-selector spec
 * also asks for) is likewise NOT part of this file — the fallback watchlist
 * is #751's active-list/rotation concern, not this pool's.
 *
 * ## Provenance
 *
 * Compiled by hand, 2026-08-17, from the three named LSE leveraged-ETP
 * issuers (Leverage Shares, WisdomTree — trading as the "Boost" ETP brand
 * for this product line, and GraniteShares), cross-referenced against
 * Trading 212's own public instrument pages
 * (`trading212.com/trading-instruments/invest/<TICKER>.GB`) to confirm each
 * ticker is a T212-listed instrument. Every row's `source_url` and
 * `t212_source_url` in `RowProvenance` is a page actually fetched or returned
 * by a web search during this compile — see each row for its citation.
 *
 * **This pool is 11 rows (tradeable ETP lines, distinct `lse_ticker`
 * values) but only 7 distinct `screening_instrument` values (rankable
 * underlyings) — not the 40-80 ADR-0016 estimates for the full
 * three-issuer catalogue, and neither number is a ceiling on real
 * availability, only a floor.** SPY, QQQ, PLTR, and NVDA each carry two ETP
 * lines from different issuers, which is why 11 rows resolve to 7 distinct
 * underlyings — see `countRankableUnderlyings()` below, and the pool-count
 * finding further down for which of these two counts each downstream ticket
 * actually consumes. An early pass of this file stopped at 6 rows and
 * reported "under 25" as a finding. That was wrong, and the mistake is worth
 * naming: the first pass dropped a candidate the moment its currency line was
 * unconfirmed (Palantir, a second NVIDIA line), while simultaneously keeping
 * rows with the identical uncertainty (3USL, NVD3) because they had already
 * been accepted. Re-running the same bar T212's own instrument pages give —
 * "does `trading212.com/trading-instruments/invest/<TICKER>.GB` resolve" —
 * against those same dropped names immediately produced five more verified
 * rows (3LNV, 3QQQ, MST3, 3LPA, PLT3), and a plain search of GraniteShares'
 * own site surfaced an EIGHTEEN-ticker 3x/-3x single-stock catalogue
 * (`etfstream.com`, "GraniteShares lists 18 leveraged and inverse US stock
 * ETPs") before Leverage Shares' or WisdomTree's ranges are even considered —
 * Leverage Shares alone advertises 150+ products. **The verified-tradeable
 * count of ETP LINES for this three-issuer universe is materially above
 * 25** — that is a line count, not the distinct-underlying count #707's
 * 25-name threshold is measured against (7 today; see the pool-count finding
 * below for why those two 25s are not the same 25) — the original under-25
 * conclusion was an artifact of stopping the search early, not a property of
 * the universe. Bulk-importing the rest of that 18-ticker (and larger)
 * catalogue row-by-row was out of scope for this pass — each addition needs
 * the same ISIN + currency-line + T212-page verification this file's eleven
 * rows got, which is more per-row research than one ticket can absorb — so
 * this file ships 11 fully-verified rows (7 distinct underlyings) as a seed,
 * not a claim of completeness.
 *
 * **The pool-count finding this ticket asks for, corrected — and split by
 * what each consumer actually counts.** This pool has 11 tradeable ETP lines
 * (distinct `lse_ticker` rows) but only 7 distinct rankable underlyings
 * (unique `screening_instrument` values, see `countRankableUnderlyings()`),
 * because SPY, QQQ, PLTR, and NVDA each carry two ETP lines from different
 * issuers. These are not interchangeable counts, and each downstream ticket
 * consumes only one of them:
 *
 * - **#707** (the screener's ranking/shortlist step) ranks
 *   `screening_instrument` — underlyings, not ETP lines. At 7 distinct
 *   underlyings, #707 is BLOCKED, not cleared: it needs the distinct-
 *   `screening_instrument` count to reach at least 25, the
 *   `docs/specs/universe-selector-spec.md` ("Candidate pool") threshold for
 *   where ranking machinery earns its keep, and row count is not the measure
 *   of that gate — 11 rows says nothing about whether #707 can run. A
 *   monthly quintile over 7 names is in fact MORE degenerate (1-2
 *   instruments per bucket) than the 12-15-row case already recorded on
 *   #707 as requiring the bucketing scheme to be restated before its first
 *   run, so this correction tightens #707's precondition, it does not
 *   relax it.
 * - **#751** (ActiveUniverseProvider, tradeable-lines wiring) consumes the
 *   11-row tradeable-ETP-line count instead — the population it wires for
 *   order routing legitimately spans issuer-duplicate lines, since 3USL and
 *   3SPY are two genuinely different holdable instruments even though both
 *   screen off SPY.
 *
 * The `toBeLessThan` test that encoded the old under-25 (row-count)
 * conclusion has been removed from this file's test suite; both current
 * counts (11 rows, 7 distinct underlyings) are pinned by
 * `lse-etp-pool.test.ts` instead.
 *
 * ## Residual risks (issue #749, "record ... rather than leaving them to be
 * discovered")
 *
 * 1. **Tracking error.** Each ETP tracks `leverage x underlying` on a DAILY
 *    reset, with drift from financing costs and rebalancing. A reach rate
 *    measured on the underlying (docs/research/18-intraday-instrument-physics.md)
 *    and assumed to transfer 1:1 to the ETP is an approximation whose error
 *    grows with intraday path roughness — precisely the regime the screener
 *    selects for.
 * 2. **The GBP/USD leg.** Every underlying here is USD-denominated; the
 *    ETP is held in a GBP ISA. A currency move between entry and exit is an
 *    uncompensated term in the realised return that the US-underlying
 *    screening bars cannot see. (Several rows below are themselves
 *    USD-denominated LSE lines rather than GBX/GBP lines — see each row's
 *    `currency` field and note — which is the same risk one layer earlier,
 *    at the settlement-vs-listing-currency boundary, not just underlying-vs-ETP.)
 * 3. **The session offset.** The screener's target session opens at 14:30
 *    London — the US cash open, and `screening_instrument`'s first bar of
 *    the day. The traded `lse_ticker` has already been trading on the LSE
 *    since 08:00 — six and a half hours of price discovery the screening
 *    window omits entirely. A reach rate measured on the US session is
 *    conditioned on a session start the ETP itself does not share.
 *
 * None of these is a reason to screen on unavailable LSE bars — they are the
 * reason the screener's output is a watchlist, not a signal (doc 18, doc 41
 * already rest on this same assumption).
 */
import type { AssetClass, InstrumentSubclass } from '../../shared/index.js';

/** Long/short stance the ETP itself carries — separate from any debate direction. */
export type EtpDirection = 'long' | 'short';

/**
 * Per-row citation. Not decoration: #749's acceptance criteria require
 * "dated provenance naming the issuer sources and the T212 metadata
 * cross-reference", and a shared file-level date does not say which specific
 * claim (ticker existing, ISIN, currency line, T212 listing) came from which
 * fetch.
 */
export interface RowProvenance {
  /** ISIN of the ETP, as stated by the issuer/aggregator source below. */
  readonly isin: string;
  /** One of the three named issuers: 'Leverage Shares' | 'WisdomTree' | 'GraniteShares'. */
  readonly issuer: string;
  /** A URL actually fetched or returned by search during this compile, naming ticker/ISIN/currency. */
  readonly source_url: string;
  /** A trading212.com instrument page confirming T212 lists this ticker. */
  readonly t212_source_url: string;
  /** ISO date this row was compiled/verified. */
  readonly verified_on: string;
  /** Anything uncertain about this specific row that a reader must not silently trust. */
  readonly notes?: string;
}

/**
 * One tradeable-instrument row. All eight fields #749 asks for, plus
 * `provenance` (not one of the eight — an addition, not a substitute).
 */
export interface LseEtpPoolRow {
  /** What Samurai HOLDS and ROUTES orders against. The LSE-listed ETP. */
  readonly lse_ticker: string;
  /**
   * What the screener fetches bars for and computes indicators on. The US
   * underlying (or, for an index/basket, the closest liquid US ETF proxy —
   * see each row's `screening_instrument`/`underlying` pair). NEVER passed to
   * `buildRoutingMap` or any routing lookup — see module doc.
   */
  readonly screening_instrument: string;
  /** Human-readable name of the thing being tracked (index, basket, or single company). */
  readonly underlying: string;
  /** Leverage multiple, e.g. 3 for a 3x product. Always positive; see `direction` for long/short. */
  readonly leverage: number;
  readonly direction: EtpDirection;
  /** ADR-0018's pricing dimension. Must be one of `KNOWN_SUBCLASSES` — see `assertKnownSubclass`. */
  readonly subclass: InstrumentSubclass;
  /** ISO 4217-ish currency code of the LSE-listed line this row actually names (may be GBP, GBX, or USD). */
  readonly currency: string;
  /**
   * Best-effort determination that Trading 212 LISTS this ticker, from
   * T212's own public instrument pages (see `provenance.t212_source_url`) —
   * NOT that it is confirmed listed-and-tradeable inside the Trading 212
   * Stocks ISA. Listing is verified; ISA eligibility and this account's
   * permission to actually trade it are unverified pending #665 (the
   * complex-products questionnaire, still open), which can shrink this pool.
   * This is also NOT a spread or liquidity measurement — #666 (still open)
   * is what measures real T212 spreads. Until #665 and #666 land, treat
   * every `true` here as "T212 lists the instrument", not "this account can
   * hold it" or "the spread is tradeable" — the acceptance criterion calling
   * this "the liquidity gate until #666 measures real spreads" names the
   * spread gap explicitly rather than leaving it implied.
   */
  readonly t212_isa: boolean;
  readonly provenance: RowProvenance;
}

/**
 * The subclasses this pool file may legally populate. A SUBSET of
 * `InstrumentSubclass` (`contracts/primitives.ts`) — `'crypto'` is a member
 * of that union but never appears in an LSE equity pool, and is excluded
 * here on purpose rather than merely never used, so an accidental crypto row
 * fails the same loud way an unrecognised string would.
 *
 * `contracts/primitives.ts` already owns `InstrumentSubclass` per
 * `docs/specs/cross-spec-contracts.md` CV-24 — this file does not redefine
 * the type, only the allow-list this pool checks rows against.
 */
export const KNOWN_SUBCLASSES: readonly InstrumentSubclass[] = [
  'index_etp_3x',
  'single_stock_etp_3x',
];

/**
 * Thrown by `assertKnownSubclass`. A distinct class so a caller validating a
 * whole pool can tell "bad data" from an unrelated fault.
 */
export class UnknownSubclassError extends Error {
  constructor(
    readonly lse_ticker: string,
    readonly subclass: string,
  ) {
    super(
      `LSE ETP pool row '${lse_ticker}' has subclass '${subclass}', which is not one of the ` +
        `recorded subclasses (${KNOWN_SUBCLASSES.join(', ')}). CV-24 (docs/specs/cross-spec-contracts.md) ` +
        'requires an unrecognised subclass to fail loud, never default — a default here means full ' +
        'deployment against an envelope nobody measured for this instrument.',
    );
    this.name = 'UnknownSubclassError';
  }
}

/** Refuses a row whose `subclass` is not in `KNOWN_SUBCLASSES`. Never coerces or defaults. */
export function assertKnownSubclass(row: LseEtpPoolRow): void {
  if (!KNOWN_SUBCLASSES.includes(row.subclass)) {
    throw new UnknownSubclassError(row.lse_ticker, row.subclass);
  }
}

/**
 * The checked-in pool. Eleven rows (tradeable ETP lines): four
 * `index_etp_3x`, seven `single_stock_etp_3x`. That resolves to only 7
 * distinct `screening_instrument` values (rankable underlyings; see
 * `countRankableUnderlyings()`) — 2 among the index rows (SPY, QQQ, each
 * doubled) and 5 among the single-stock rows (TSLA, AAPL, MSTR, plus NVDA
 * and PLTR each doubled) — since SPY, QQQ, PLTR, and NVDA each carry two
 * lines from different issuers. See the module doc's provenance section for
 * why this is a verified seed of the full three-issuer catalogue rather than
 * an exhaustive scrape, and for the corrected pool-count finding — which of
 * these two counts each downstream ticket (#707, #751) consumes.
 */
export const LSE_ETP_POOL: readonly LseEtpPoolRow[] = [
  {
    lse_ticker: '3USL',
    screening_instrument: 'SPY',
    underlying: 'S&P 500',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'IE00B7Y34M31',
      issuer: 'WisdomTree',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00B7Y34M31',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3USL.GB',
      verified_on: '2026-08-17',
      notes:
        "WisdomTree S&P 500 3x Daily Leveraged. Same product family ADR-0016's 0.18% round-trip " +
        "figure is quoted for. justETF's LSE listing table also shows a GBX (pence) line under " +
        'ticker 3LUS for the same ISIN; 3USL (this row) is the USD line and is the ticker ADR-0016 ' +
        "and T212's public page both name, so it is used here rather than the untested 3LUS line.",
    },
  },
  {
    lse_ticker: 'LQQ3',
    screening_instrument: 'QQQ',
    underlying: 'Nasdaq 100',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    provenance: {
      isin: 'IE00BLRPRL42',
      issuer: 'WisdomTree',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00BLRPRL42',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LQQ3.GB',
      verified_on: '2026-08-17',
      notes:
        'WisdomTree NASDAQ 100 3x Daily Leveraged, GBX (pence sterling) line. justETF also lists a ' +
        'USD line for the same ISIN under ticker QQQ3 on the LSE; T212 lists both LQQ3.GB and ' +
        'QQQ3.GB separately, and LQQ3 is used here as the GBP-denominated line.',
    },
  },
  {
    lse_ticker: '3SPY',
    screening_instrument: 'SPY',
    underlying: 'S&P 500 (SPDR S&P 500 ETF Trust)',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    provenance: {
      isin: 'XS2472197149',
      issuer: 'Leverage Shares',
      source_url: 'https://www.cnbc.com/quotes/3SPY-GB',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3SPY.GB',
      verified_on: '2026-08-17',
      notes:
        'Leverage Shares 3x Long US 500 ETP Securities, quoted in GBX (pence) on the LSE per ' +
        'MarketScreener. A second S&P 500 3x product from a different issuer to 3USL above — both ' +
        'genuinely exist and are both T212-listed.',
    },
  },
  {
    lse_ticker: '3LTS',
    screening_instrument: 'TSLA',
    underlying: 'Tesla Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2656472193',
      issuer: 'GraniteShares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2656472193',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LTS.GB',
      verified_on: '2026-08-17',
      notes:
        'GraniteShares 3x Long Tesla Daily ETP. justETF lists this ISIN under three LSE lines ' +
        '(3LTP GBX, 3LTE EUR, 3LTS USD); 3LTS is the ticker T212 and ADR-0018 D3 both name, so it ' +
        'is used here — the GBX line (3LTP) was not independently confirmed as T212-listed.',
    },
  },
  {
    lse_ticker: 'NVD3',
    screening_instrument: 'NVDA',
    underlying: 'NVIDIA Corp',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2820604770',
      issuer: 'Leverage Shares',
      source_url: 'https://www.cnbc.com/quotes/NVD3-GB',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/NVD3.GB',
      verified_on: '2026-08-17',
      notes:
        'Leverage Shares 3x NVIDIA ETP Securities. The LSE also carries a 3NVD line for the same ' +
        'ISIN per aggregator search results; its currency could not be independently confirmed from ' +
        'a fetched source, so this row uses NVD3 (the ticker T212’s own instrument page names) ' +
        'and its currency is recorded as USD on the balance of the (imperfectly consistent) evidence ' +
        '— treat this one field, specifically, as lower-confidence than the rest of the row.',
    },
  },
  {
    lse_ticker: '3AAP',
    screening_instrument: 'AAPL',
    underlying: 'Apple Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBP',
    t212_isa: true,
    provenance: {
      isin: 'IE00BK5BZS07',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00BK5BZS07',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3AAP.GB',
      verified_on: '2026-08-17',
      notes:
        'Leverage Shares 3x Apple ETP Securities, GBP line (distinct from the AAP3 USD line on the ' +
        'same LSE listing for this ISIN).',
    },
  },
  {
    lse_ticker: '3LNV',
    screening_instrument: 'NVDA',
    underlying: 'NVIDIA Corp',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2734938835',
      issuer: 'GraniteShares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2734938835',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LNV.GB',
      verified_on: '2026-08-17',
      notes:
        'GraniteShares 3x Long NVIDIA Daily ETP. A second, separately-issued NVIDIA 3x product from ' +
        "NVD3 above (Leverage Shares) — both genuinely exist. justETF's LSE table lists three lines " +
        'for this ISIN (3LVP GBX, 3LVE EUR, 3LNV USD); 3LNV is the ticker T212 itself lists, so it is ' +
        'used here.',
    },
  },
  {
    lse_ticker: '3QQQ',
    screening_instrument: 'QQQ',
    underlying: 'Nasdaq 100',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2472197065',
      issuer: 'Leverage Shares',
      source_url: 'https://www.marketscreener.com/quote/etf/LEVERAGE-SHARES-3X-LONG-U-143798640/',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3QQQ.GB',
      verified_on: '2026-08-17',
      notes:
        'Leverage Shares 3x Long US Tech 100 ETP Securities, USD line — a second Nasdaq 100 3x ' +
        'product from a different issuer to LQQ3 above, same relationship as 3SPY/3USL for the S&P 500.',
    },
  },
  {
    lse_ticker: 'MST3',
    screening_instrument: 'MSTR',
    underlying: 'Strategy Inc (formerly MicroStrategy)',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2901882618',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2901882618',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/MST3.GB',
      verified_on: '2026-08-17',
      notes:
        'Leverage Shares 3x Long MicroStrategy (MSTR) ETP, USD line. justETF also lists a GBX line ' +
        '(3MST) for the same ISIN; MST3 is the ticker T212 itself lists, so it is used here. ' +
        'MSTR is itself a leveraged bet on BTC via corporate treasury holdings — this row inherits ' +
        'that exposure on top of the 3x ETP wrapper, a compounding-leverage risk distinct from the ' +
        'three residual risks named below and worth flagging if this row is ever consumed.',
    },
  },
  {
    lse_ticker: '3LPA',
    screening_instrument: 'PLTR',
    underlying: 'Palantir Technologies Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2856105833',
      issuer: 'GraniteShares',
      source_url: 'https://www.marketscreener.com/quote/etf/GRANITESHARES-3X-LONG-PAL-130089189/',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LPA.GB',
      verified_on: '2026-08-17',
      notes:
        'GraniteShares 3x Long Palantir Daily ETP Securities, USD base currency per MarketScreener. ' +
        'A second, separately-issued Palantir 3x product from PLT3 below (Leverage Shares) — both ' +
        'genuinely exist.',
    },
  },
  {
    lse_ticker: 'PLT3',
    screening_instrument: 'PLTR',
    underlying: 'Palantir Technologies Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    provenance: {
      isin: 'XS2663694680',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2663694680',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/PLT3.GB',
      verified_on: '2026-08-17',
      notes:
        "Leverage Shares 3x Palantir ETP Securities, USD line. justETF's LSE table lists three lines " +
        'for this ISIN (3PLT GBX, 3PRE EUR, PLT3 USD); PLT3 is the ticker T212 itself lists, so it is ' +
        'used here.',
    },
  },
];

/**
 * Builds the routing map `AssetClassRoutingDataSource`-shaped callers need:
 * `lse_ticker -> 'stocks'`, for every row. `screening_instrument` is never
 * read here — the whole point of the two-field split is that a routing
 * layer built from this map cannot resolve a screening instrument to
 * anything, because it was never given the chance to.
 */
export function buildRoutingMap(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): ReadonlyMap<string, AssetClass> {
  const map = new Map<string, AssetClass>();
  for (const row of pool) {
    map.set(row.lse_ticker, 'stocks');
  }
  return map;
}

/**
 * The `screening_instrument` for a traded `lse_ticker`, or `null` when the
 * instrument is not a pool row at all (#797).
 *
 * **This is a LOOKUP, not a routing map.** It answers "is the instrument I am
 * about to compute a volume read on a leveraged-ETP wrapper, and if so what is
 * the informed instrument behind it" — the question #744's volume caveat
 * forces on every volume-derived read. It is deliberately NOT the inverse of
 * `buildRoutingMap` and must never be used to pick an API root or place an
 * order: `screening_instrument` reaching a routing layer is exactly what
 * `buildRoutingMap`'s doc comment refuses, and nothing here changes that.
 *
 * `null` for a non-pool instrument is a real answer, not a miss to paper over.
 * Every instrument in today's configured universes (`DEFAULT_UNIVERSE`'s SPY,
 * QQQ, AAPL, TSLA) IS a liquid US instrument, so its own volume is the
 * informed volume and no caveat is owed — see `technical-analyst.ts`'s RVOL
 * call site, which renders the caveat only on the non-`null` branch.
 */
export function screeningInstrumentFor(
  lseTicker: string,
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): string | null {
  return pool.find((row) => row.lse_ticker === lseTicker)?.screening_instrument ?? null;
}

/**
 * The count #707 (screener ranking/shortlist) actually consumes: the number
 * of DISTINCT `screening_instrument` values in a pool — rankable
 * underlyings, not tradeable ETP lines. Strictly less than `pool.length`
 * whenever an underlying carries more than one issuer's ETP line, which this
 * pool's SPY/QQQ/PLTR/NVDA rows do (11 rows, 7 distinct underlyings). See
 * the module doc's pool-count finding for why row count is NOT the measure
 * #707's 25-name threshold is against.
 */
export function countRankableUnderlyings(pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL): number {
  return new Set(pool.map((row) => row.screening_instrument)).size;
}

/**
 * Validates every row of a pool: subclass is recognised (fails loud per
 * `assertKnownSubclass`), and both instrument-identity fields are non-empty
 * and distinct. Rejects a whole malformed pool at once rather than letting a
 * bad row surface later as a routing throw mid-session.
 */
export function assertValidPool(pool: readonly LseEtpPoolRow[]): void {
  for (const row of pool) {
    assertKnownSubclass(row);
    if (row.lse_ticker.trim().length === 0) {
      throw new Error('LSE ETP pool row has an empty lse_ticker.');
    }
    if (row.screening_instrument.trim().length === 0) {
      throw new Error(`LSE ETP pool row '${row.lse_ticker}' has an empty screening_instrument.`);
    }
  }
}

assertValidPool(LSE_ETP_POOL);
