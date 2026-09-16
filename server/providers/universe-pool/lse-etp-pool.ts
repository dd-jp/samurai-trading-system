/**
 * The LSE leveraged-ETP pool file (#749).
 *
 * ## What this is
 *
 * A checked-in, hand-compiled list of the leveraged ETPs Samurai MAY trade on
 * the live equity leg — GBP-account, Saxo GIA, LSE-listed instruments — and,
 * for each one, the separate US instrument the screener ranks it on. (This
 * line said "T212-ISA" until the 2026-08-30 venue change, #946 — see
 * "## Saxo venue change" below for what that does and does not mean for the
 * per-row evidence.)
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
 * ## The fallback subset
 *
 * `fallback_default` IS part of this file, and an earlier version of this
 * doc said it was not — "the fallback watchlist is #751's
 * active-list/rotation concern, not this pool's". That was wrong, and the
 * reason is worth keeping rather than quietly deleting: it confused the
 * fallback's *data* with its *behaviour*. #751 owns the behaviour — when the
 * fallback triggers and what alert fires — and its acceptance criteria never
 * name this field. The data has to live here, because a fallback that is
 * derived from anything the screener produces or consumes is unavailable in
 * the one scenario it exists for. `docs/specs/universe-selector-spec.md`
 * agrees twice over: it puts the field in the pool schema ("Candidate pool")
 * and puts its enforcement at pool load ("a pool with no `fallback_default`
 * row is rejected at load, not at fallback time"). Recorded as finding F4 of
 * `docs/reviews/universe-path-gap-sweep-2026-09-03.md`.
 *
 * **Which rows carry it, and on what basis.** The subset is
 * hand-declared, per the spec's third constraint, and these are the criteria
 * — stated so David can revise the membership without reverse-engineering
 * the intent:
 *
 * 1. **`subclass_envelope_measured: true` only.** ADR-0018 D3's bracket and
 *    D5's fraction were never measured against 3VT/3KOR/3KWE/3XLE (#903 is
 *    open), and degraded mode is the worst place to discover that.
 * 2. **This forces a mixed subset — it is a bind, not a preference.** With
 *    the four #903 rows excluded, the pool holds exactly four index rows
 *    (3USL, LQQ3, 3SPY, 3QQQ) resolving to two underlyings, so an
 *    index-only fallback cannot reach the spec's 5–10 range at all without
 *    readmitting them. Single-stock rows are here because of that
 *    arithmetic. (Not for throughput: the netted `per_subclass_deployment_cap`
 *    would give a mixed list more deployable capital than an index-only one,
 *    and in a mode where the screener has failed, more is not better.)
 * 3. **One ETP line per `screening_instrument`.** QQQ, PLTR and NVDA each
 *    carry two lines and SPY carries three; two lines on one underlying is
 *    doubled exposure to a single name in the one mode with no screener to
 *    notice. Rules 5 and 6 settle most of these before this rule is reached
 *    — SPY's three collapse to 3LUS alone once 3USL is excluded as USD
 *    (rule 6) and 3SPY as Saxo-absent (rule 5). Where a choice survives
 *    both, the sterling-quoted line is preferred (LQQ3 over 3QQQ) to avoid
 *    the spec's residual risk 2 twice over. There is no both-USD tiebreak
 *    any more: rule 6 excludes every USD line outright.
 * 4. **Two structural exclusions, from geometry rather than from a
 *    leaderboard.** MSTR is excluded because at 3x "the tape bleeds before
 *    any bracket is reached" (`docs/research/52-exit-geometry-and-subclass-odds.md`,
 *    E_gross −0.4672%/session), and AAPL because it resolves only 9.5% of
 *    sessions (doc 52) — D3's frozen brackets effectively never act, so the
 *    slot would be dead. Both are statements about leverage and bracket
 *    geometry. **No row is included because it ranked well in doc 52**:
 *    #750's own body warns that "an axis picked because it topped a table in
 *    doc 52 would inherit that doc's 126 trials", and a checked-in artifact
 *    seeded from the same leaderboard inherits them identically. The six are
 *    the pool's largest, most heavily traded US underlyings on ordinary
 *    market knowledge, which is a hand-declaration and is labelled as one.
 * 5. **Listing is verified; liquidity is NOT.** The field the gate reads is
 *    `saxo_tradeable`, not `t212_isa` — `t212_isa` names a venue Samurai is
 *    barred from (#896/#912) and answers a different, no-longer-live
 *    question. Every fallback row is Saxo-verified `true` (#1032 item 3);
 *    no spread or volume measurement exists yet — #750 gates on it, and the
 *    chain that would deliver one (#1034 → #1035) carries `needs-decision`
 *    pending whether Saxo's burst-sampled `infoprices` spread (#1310)
 *    supersedes DMD — so this subset is declared pending that, not screened
 *    against it.
 *
 * 6. **Sterling only** (#1220, David's 2026-09-08 ruling). Rule 6 of
 *    `assertValidFallbackSubset`, and the criterion that decided the current
 *    membership. Non-sterling lines are excluded from the tradeable universe
 *    outright (`tradeableUniverse`), so a fallback holding one hands
 *    degraded mode an instrument selection has already refused.
 *
 * **Re-selected 2026-09-05 by #1032 item 3, then narrowed 2026-09-09 by
 * #1220.** The Saxo capture found no line at all for 3SPY, 3AMZ and (under
 * its own ticker) 3LME/3FB — four of the six rows the 2026-09-03 subset named
 * — and rule 5 refuses a fallback row Saxo is verified not to list, which put
 * 3USL (USD) in the SPY slot. #1220's sterling-only ruling then took that
 * slot back off it: **3LUS:xlon (Uic 29049628), the GBP line of the same
 * ISIN, is now its own pool row and holds the SPY slot** — the sibling the
 * 2026-09-05 pass recorded, promoted deliberately rather than swapped in
 * silently, with 3USL kept as a pool row. Rule 6 also drops NVD3, 3LTS, 3LPA
 * and 3LAL, all USD lines with no sterling line of the same ISIN to move to.
 * **The subset is therefore two rows — 3LUS and LQQ3, SPY and QQQ — below
 * the spec's 5–10 sizing guidance**, which is stated here rather than
 * quietly tolerated: the pool holds only five sterling Saxo-listed lines at
 * all, and universe width for the live ramp is #1310's. LCO3 is the one
 * sterling, Saxo-listed, envelope-measured row NOT promoted into the subset,
 * because promoting it is a selection decision the #1220 ruling did not make.
 *
 * ## Saxo venue change — what changed here and what did not
 *
 * The live equity venue changed from Trading 212 (ISA) to Saxo Capital
 * Markets UK (GIA) on 2026-08-30 (ADR-0015's amendment, map #905), after
 * every row below was compiled. This doc pass (#946) updated the framing
 * text on that basis. **Not changed by this**: the GBP-LSE restriction
 * itself (#659, re-confirmed against the venue change) and the per-row
 * identity evidence (ISIN, issuer, currency, ticker) — none of that
 * depended on which broker holds the account. **Left deliberately unrenamed**:
 * `t212_isa`, `t212_source_url`, and every row's T212-sourced listing
 * evidence, because that evidence answers "does Trading 212 list this
 * ticker", not "does Saxo" — those are different, unverified claims, and
 * mechanically relabelling the field would assert a Saxo fact this pool has
 * never checked. #946's own scope excluded building a Saxo `BrokerAdapter`
 * or doing Saxo outreach, so no such check happened there. **The parallel
 * field this pool tracks for Saxo is `saxo_tradeable`** (see
 * `LseEtpPoolRow`), filled on every row by #1032 item 3 from Saxo's own
 * `GET /ref/v1/instruments` on 2026-09-05 — see `SaxoInstrumentEvidence`
 * and each row's `provenance.saxo`.
 *
 * ## Saxo evidence pass (2026-09-05, #1032 item 3)
 *
 * Every row was searched twice on the SIM gateway
 * (`gateway.saxobank.com/sim/openapi/ref/v1/instruments`,
 * `AssetTypes=Etf,Etc,Etn`): once by its `<lse_ticker>:xlon` symbol and
 * once by its ISIN. The result is three honest buckets, recorded per row:
 *
 * - **14 rows: own line listed** — `saxo_tradeable: true`, `line` carries
 *   Saxo's Uic/AssetType/ExchangeId/Currency. Every one is `AssetType: Etn`
 *   on `ExchangeId: LSE_ETF`. Five also have a sibling currency line
 *   (3USL/3LUS, 3LUS/3USL, LQQ3/QQQ3, NVD3/3NVD, LCO3/3LCO). It was 13 until
 *   #1220 promoted this pass's own 3LUS sibling record into a row of its
 *   own; that row adds no new capture, only a second reading of one.
 * - **7 rows: ISIN resolves only to a SIBLING ticker** — `false`, with the
 *   sibling recorded (3LME→3LMS, LAM3→3LAM, LPP3→3LPP, 3LNP→3LNF,
 *   LAA3→3LAA, 3LIP→3LNI, 3FB→FB3). The product exists on Saxo; the line
 *   this pool names does not. A future ticket may re-key those rows to the
 *   sibling deliberately; this pass records rather than swaps.
 * - **10 rows: nothing under ticker or ISIN** — `false`, no sibling. A
 *   broader keyword sweep found only other issuers' lines for the same
 *   underlyings (e.g. GraniteShares 3LAP for Apple, 3LZN for Amazon), which
 *   are different products and are not adopted here.
 *
 * What the pass does NOT establish: that any `true` line is tradeable in a
 * live GIA (the capture is SIM, with market data not entitled — see
 * `SaxoInstrumentEvidence.gateway`), or anything about spread, volume, or
 * tick size beyond `IsTradable: true` observed on one details call (3USL).
 * `MarketDataViaOpenApiTermsAccepted` was `false` on the probing account,
 * and `/trade/v1/infoprices` returned `NoAccess` for every instrument, so no
 * quote evidence was collectable.
 *
 * ## Provenance
 *
 * Compiled by hand, 2026-08-17 (rows 1-11) and 2026-08-19 (rows 12-30, #813),
 * from the three named LSE leveraged-ETP
 * issuers (Leverage Shares, WisdomTree — trading as the "Boost" ETP brand
 * for this product line, and GraniteShares), cross-referenced against
 * Trading 212's own public instrument pages
 * (`trading212.com/trading-instruments/invest/<TICKER>.GB`) to confirm each
 * ticker is a T212-listed instrument. Every row's `source_url` and
 * `t212_source_url` in `RowProvenance` is a page actually fetched or returned
 * by a web search during this compile — see each row for its citation.
 *
 * **What the T212 evidence is, exactly.** `trading212.com` answers HTTP 403
 * to a programmatic fetch — identically for a real ticker and for a
 * nonsense one, which was checked before any row was added — so no row's
 * `t212_source_url` was read directly. The evidence is the search-returned
 * page title, e.g. "Invest in GraniteShares 3x Long Netflix, London Stock
 * Exchange: 3LNP ETF": issuer, underlying and ticker all come from T212's
 * own page content, and a nonexistent ticker produces no such title. Two
 * rows below (3LAL, 3UBR) have titles the search engine truncated before the
 * ticker; they say so in their own `notes` rather than borrowing the
 * stronger claim their neighbours can make. Currency and ISIN are held to a
 * higher bar — a page actually fetched (AJ Bell's LSE instrument pages, or
 * justETF's per-ISIN profile) — because a wrong quoting currency is a 100x
 * sizing error and a wrong ISIN identifies a different security.
 *
 * **Expanded 2026-08-19 by [#813](https://github.com/dd-jp/samurai-trading-system/issues/813):
 * this pool is now 31 rows (tradeable ETP lines, distinct `lse_ticker`
 * values) resolving to 26 distinct `screening_instrument` values (rankable
 * underlyings)** — still not the 40-80 ADR-0016 estimates for the full
 * three-issuer catalogue, and still neither number is a ceiling on real
 * availability, only a floor. The nineteen rows #813 added each carry one
 * new underlying, so both counts moved by the same amount; the four
 * duplicated underlyings are still SPY, QQQ, PLTR, and NVDA, each carrying
 * two ETP lines from different issuers (and SPY a third, 3LUS, added by
 * #1220), which is why 31 rows resolve to 26
 * distinct underlyings — see `countRankableUnderlyings()` below, and the
 * pool-count finding further down for which of these two counts each
 * downstream ticket actually consumes. An early pass of this file stopped at 6 rows and
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
 * 25-name threshold is measured against (26 today; see the pool-count finding
 * below for why those two 25s are not the same 25) — the original under-25
 * conclusion was an artifact of stopping the search early, not a property of
 * the universe. #813 was the ticket that absorbed that per-row research:
 * nineteen further names were carried through the same ISIN + currency-line +
 * T212-page bar on 2026-08-19, and the resulting pool clears #707's
 * distinct-underlying threshold rather than merely clearing a line count.
 *
 * **This is still a seed, not a claim of completeness, and the distinction
 * survives the expansion rather than being retired by it.** GraniteShares'
 * own catalogue page lists roughly seventy 3x/-3x lines, Leverage Shares
 * advertises 150+ products, and neither WisdomTree's index range nor either
 * issuer's short (-3x) side is represented here at all — every row in this
 * file is `direction: 'long'`. What #813 established is that the pool is
 * large enough for the ranking machinery to be defined; what it did not
 * establish is that it is the whole tradeable universe, or that any row is
 * worth trading (ADR-0018 records the leveraged-ETP universe as
 * negative-expectancy on unconditional entry, and real spreads are still
 * unmeasured on any live venue — #666 closed 2026-08-27 out of scope,
 * following the T212-to-Saxo pivot, without delivering that measurement;
 * #750 now gates on it instead; the chain that would deliver it —
 * #1034 → #1035 — carries `needs-decision` pending whether Saxo's
 * `infoprices` spread (#1310) supersedes DMD, per ADR-0016). Rows were
 * dropped from this
 * pass, not padded around: a
 * GraniteShares Spotify line was carried through T212 verification and then
 * left out because no fetched page confirmed its ISIN or quoting currency.
 *
 * **The pool-count finding, restated at #813's counts — and still split by
 * what each consumer actually counts.** This pool has 31 tradeable ETP lines
 * (distinct `lse_ticker` rows) resolving to 26 distinct rankable underlyings
 * (unique `screening_instrument` values, see `countRankableUnderlyings()`),
 * because QQQ, PLTR, and NVDA each carry two ETP lines from different
 * issuers and SPY carries three. These are not interchangeable counts, and each downstream ticket
 * consumes only one of them — the expansion does not merge them, it just
 * moves both:
 *
 * - **#707** (the screener's ranking/shortlist step) ranks
 *   `screening_instrument` — underlyings, not ETP lines. At 26 distinct
 *   underlyings, #707's pool precondition is now MET: it needed the
 *   distinct-`screening_instrument` count to reach at least 25, the
 *   `docs/specs/universe-selector-spec.md` ("Candidate pool") threshold for
 *   where ranking machinery earns its keep. Row count was never the measure
 *   of that gate and still is not — 31 rows would say nothing about whether
 *   #707 can run if they collapsed onto a handful of names. **What is
 *   cleared is the pool size, not #707 itself**: a monthly quintile over 26
 *   names gives ~5 instruments per bucket, which is a defined statistic
 *   rather than the near-empty buckets 7 names produced, but #707 is a
 *   pre-registered study and nothing here pre-empts its other
 *   preconditions.
 * - **#751** (ActiveUniverseProvider, tradeable-lines wiring) consumes the
 *   31-row tradeable-ETP-line count instead — the population it wires for
 *   order routing legitimately spans issuer-duplicate lines, since 3USL and
 *   3SPY are two genuinely different holdable instruments even though both
 *   screen off SPY. **#751 must consume it through `tradeableUniverse`**,
 *   which is 5 of those 31 rows after #1220's sterling-only exclusion — see
 *   that function, and #1310 for the width problem the number is.
 *
 * **What the expansion also widened: `index_etp_3x` is now a broader bucket
 * than ADR-0018 measured.** D3's frozen bracket and D5's deployment
 * fraction for `index_etp_3x` were measured with SPY standing in for the
 * whole subclass (ADR-0018: two instruments, not the universe). Before
 * #813 every index row in this pool was a broad-US-tracker line, so that
 * stand-in held. It no longer does: 3VT (all-world), 3KOR (single-country
 * Korea), 3KWE (single-country China tech) and 3XLE (single-sector US
 * energy) all carry `subclass: 'index_etp_3x'` and none of them sits in
 * 3x SPY's volatility envelope. `assertKnownSubclass` cannot catch this —
 * the string is in `KNOWN_SUBCLASSES`, which is exactly why it is recorded
 * here and in each of those four rows' notes. A consumer that sizes off
 * `subclass` alone is, for those rows, deploying against an envelope
 * nobody measured for the instrument.
 *
 * **#903's interim resolution: these four rows are structurally excluded
 * from live sizing, not just documented as risky.** `LseEtpPoolRow` carries
 * `subclass_envelope_measured: false` on exactly 3VT/3KOR/3KWE/3XLE (`true`
 * on the other 26), and `liveSizingSubclassFor()` below is the function a
 * future `UniverseInstrument[]` builder (#751) MUST call instead of reading
 * `row.subclass` directly — it returns `undefined` for these four, which
 * `subclassOfUniverse` (`server/apps/orchestrator/types.ts`) treats as "arm
 * no per-subclass regime for this instrument" rather than "size it off the
 * SPY-measured bracket". Screening/ranking is unaffected: `countRankableUnderlyings`
 * and the full `LSE_ETP_POOL` (31 rows, 26 underlyings) are untouched, since
 * this exclusion is sizing-only. Recorded against ADR-0018 (see the
 * 2026-08-27 amendment) until Option 1 (split the subclass) or Option 2
 * (re-measure across the wider membership) lands.
 *
 * The `toBeLessThan` test that encoded the old under-25 (row-count)
 * conclusion has been removed from this file's test suite; both current
 * counts (31 rows, 26 distinct underlyings) are pinned by
 * `lse-etp-pool.test.ts` instead, along with the >= 25 threshold itself so
 * that a future row removal fails loudly against #707's gate rather than
 * silently re-blocking it.
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
 *    ETP is held in a GBP account (Saxo GIA — see "## Saxo venue change"
 *    above; this line said "GBP ISA" until #946). A currency move between
 *    entry and exit is an
 *    uncompensated term in the realised return that the US-underlying
 *    screening bars cannot see. **The settlement-boundary half of this risk
 *    is closed, not merely recorded** (#1220): twelve rows below are
 *    themselves USD- or EUR-denominated LSE lines rather than GBX/GBP ones,
 *    and `tradeableUniverse` now excludes every one of them, so no line
 *    Samurai may hold settles outside the book currency. What remains is the
 *    underlying-vs-ETP leg above, which no universe filter can remove — the
 *    underlying is USD whatever currency the wrapper is quoted in.
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
import { type AssetClass, type InstrumentSubclass, isBookCurrency } from '../../shared/index.js';

/** Long/short stance the ETP itself carries — separate from any debate direction */
export type EtpDirection = 'long' | 'short';

/**
 * Tri-state Saxo tradeability. `true`/`false` are a verified claim, sourced
 * from Saxo's own instrument list — nothing in this repo may set either
 * without that source (#1032 item 3), and every checked-in row now carries
 * that source in `RowProvenance.saxo`. `'unverified'` is not a placeholder
 * default; it is the explicit, recorded statement that no such list has been
 * captured for the row, so there is nothing to source a boolean from. See
 * `LseEtpPoolRow.saxo_tradeable` and `liquidityGateStatus` for how a caller
 * must read this.
 */
export type SaxoTradeability = true | false | 'unverified';

/**
 * One LSE line as Saxo's `GET /ref/v1/instruments` returns it. `symbol` is
 * Saxo's `TICKER:xlon` form; `uic` is what an order is placed against
 * (`SaxoBrokerAdapter` resolves `lse_ticker -> {uic, asset_type}` through
 * this). `exchange_id` is `LSE_ETF` on every LSE ETP line — filtering the
 * endpoint on `ExchangeId=LSE` returns NOTHING for these, which is why the
 * capture keyed on symbol/ISIN and recorded the exchange it found instead.
 */
export interface SaxoInstrumentLine {
  readonly symbol: string;
  readonly uic: number;
  readonly asset_type: 'Etn' | 'Etf' | 'Etc';
  readonly exchange_id: 'LSE_ETF';
  /**
   * What `GET /ref/v1/instruments` says, which for a GBX-quoted line is
   * `GBP` — the search endpoint carries no quote unit at all. NOT what the
   * execution stage prices against: `saxoInstrumentResolverFromVenue`
   * (saxo-adapter.ts) reads `CurrencyCode`, `PriceCurrency` and
   * `PriceToContractFactor` from `/ref/v1/instruments/details` per line and
   * converts every price through the factor (#1302, doc 44 §2.1). This field
   * is provenance — what the pool's own compile observed — and no cash
   * amount may be derived from it.
   */
  readonly currency: string;
}

/**
 * The row's Saxo evidence (#1032 item 3): what `GET /ref/v1/instruments`
 * (`Keywords=<ticker|ISIN>&AssetTypes=Etf,Etc,Etn`) returned on the SIM
 * gateway on `verified_on`, searched by the row's own ticker AND its ISIN.
 *
 * `line` is the row's OWN ticker line — `saxo_tradeable` is `true` iff it is
 * non-null. `sibling_line` is a DIFFERENT LSE ticker Saxo lists under the
 * same ISIN (the other currency line of the same product); it is recorded so
 * a future row can adopt it deliberately, and is never what the row trades —
 * `lse_ticker` is the identity every route binds on, and silently swapping
 * it for a sibling would trade a line nothing else in this pool describes.
 *
 * `gateway: 'sim'` is a real caveat: the live instrument universe was not
 * queried (no live token is provisioned), and Saxo does not promise the two
 * are identical. Re-verify against `gateway.saxobank.com/openapi` before the
 * live ramp.
 */
export interface SaxoInstrumentEvidence {
  readonly verified_on: string;
  readonly gateway: 'sim';
  readonly line: SaxoInstrumentLine | null;
  readonly sibling_line?: SaxoInstrumentLine;
}

/**
 * Per-row citation. Not decoration: #749's acceptance criteria require
 * "dated provenance naming the issuer sources and the T212 metadata
 * cross-reference", and a shared file-level date does not say which specific
 * claim (ticker existing, ISIN, currency line, T212 listing) came from which
 * fetch.
 */
export interface RowProvenance {
  /** ISIN of the ETP, as stated by the issuer/aggregator source below */
  readonly isin: string;
  /** One of the three named issuers: 'Leverage Shares' | 'WisdomTree' | 'GraniteShares' */
  readonly issuer: string;
  /** A URL actually fetched or returned by search during this compile, naming ticker/ISIN/currency */
  readonly source_url: string;
  /**
   * A trading212.com instrument page confirming T212 lists this ticker.
   *
   * Optional since #1220, and absent means exactly one thing: no T212
   * evidence exists for this row. Every row compiled on or before
   * 2026-08-19 carries one; a row added after the 2026-08-30 venue change
   * (ADR-0015's amendment — T212 is barred outright, #896/#912) cannot,
   * because no such research pass runs any more. Citing a plausible-looking
   * URL nobody fetched would be worse than the absence in a file whose whole
   * discipline is provenance. Read `t212_isa` the same way on such a row —
   * see its own doc.
   */
  readonly t212_source_url?: string;
  /** ISO date this row was compiled/verified */
  readonly verified_on: string;
  /** What Saxo's own instrument list says about this row — the source of `saxo_tradeable` */
  readonly saxo: SaxoInstrumentEvidence;
  /** Anything uncertain about this specific row that a reader must not silently trust */
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
  /** Human-readable name of the thing being tracked (index, basket, or single company) */
  readonly underlying: string;
  /** Leverage multiple, e.g. 3 for a 3x product. Always positive; see `direction` for long/short. */
  readonly leverage: number;
  readonly direction: EtpDirection;
  /** ADR-0018's pricing dimension. Must be one of `KNOWN_SUBCLASSES` — see `assertKnownSubclass`. */
  readonly subclass: InstrumentSubclass;
  /** ISO 4217-ish currency code of the LSE-listed line this row actually names (may be GBP, GBX, or USD) */
  readonly currency: string;
  /**
   * Best-effort determination that Trading 212 LISTS this ticker, from
   * T212's own public instrument pages (see `provenance.t212_source_url`) —
   * NOT that it is confirmed listed-and-tradeable inside a Trading 212
   * account. On a row compiled AFTER the 2026-08-30 venue change (3LUS,
   * #1220) `false` means "no T212 evidence exists" rather than "T212 does
   * not list it" — no such research pass runs any more; those rows carry no
   * `t212_source_url` and say so in their own `provenance.notes`. NOT a
   * claim about Saxo (the live equity venue since
   * 2026-08-30, ADR-0015's amendment, map #905 — see "## Saxo venue change"
   * above). Listing is verified; T212-side eligibility to actually trade it
   * was pending #665 (the complex-products questionnaire), which closed
   * 2026-08-27 as out of scope once T212 was ruled out as a venue at all
   * (#896/#912, both closed 2026-08-27) — it never ran, so this field never
   * shrank on that basis. This is also NOT a spread or liquidity
   * measurement — #666, which would have measured real T212 spreads, closed
   * the same day for the same reason; #750 now gates on a real per-instrument
   * spread measurement instead; the chain that would deliver it —
   * #1034 → #1035 — carries `needs-decision` pending whether Saxo's
   * `infoprices` spread (#1310) supersedes DMD, per ADR-0016. Every `true`
   * here means only
   * "T212 lists the instrument" — not "tradeable", not "the spread is
   * tradeable", and not anything about Saxo, which this field has never
   * checked.
   */
  readonly t212_isa: boolean;
  /**
   * Whether this instrument is tradeable on Saxo Capital Markets UK (GIA) —
   * the live equity venue since 2026-08-30 (ADR-0015's amendment, map #905)
   * — sourced from SAXO'S OWN instrument list. **This is the field
   * `docs/specs/universe-selector-spec.md` story 16 / #750 AC7 name as the
   * hard liquidity gate.** `t212_isa` above answers a different,
   * no-longer-live question (does Trading 212 list it) and must never be
   * read as this one.
   *
   * Sourced on every row from `provenance.saxo` (#1032 item 3, 2026-09-05,
   * SIM gateway): `true` iff Saxo lists the row's OWN `<lse_ticker>:xlon`
   * line on `LSE_ETF`. `false` covers two honest cases the evidence block
   * distinguishes — Saxo lists a sibling line under the same ISIN but not
   * this ticker (7 rows), or lists nothing for the ISIN at all (10 rows).
   * Neither is a tradeability claim about the underlying product; both are a
   * claim about THIS line, which is the one every route binds on.
   *
   * `'unverified'` was every row's value before that pass and remains the
   * only value a new row may carry until its own capture lands — it is not
   * a quiet placeholder for `true`. Read through `liquidityGateStatus`:
   * `assertValidPool` refuses a pool where `gateAdmits` is constant across
   * verified rows, because a gate that excludes nothing (or everything) on
   * every row is a bug, not a legitimate configuration.
   */
  readonly saxo_tradeable: SaxoTradeability;
  /**
   * Whether ADR-0018's D3/D5 numbers for THIS row's `subclass` were actually
   * measured against an instrument like this one — not just whether the
   * subclass string is known (`assertKnownSubclass`'s separate, weaker job:
   * a string can be a recognised member of `KNOWN_SUBCLASSES` while still
   * describing an instrument nobody measured, which is exactly #813's
   * `index_etp_3x` widening).
   *
   * `false` on exactly the four rows #813 added whose underlying is nothing
   * like SPY (3VT/VT all-world, 3KOR/EWY South Korea, 3KWE/KWEB China
   * internet, 3XLE/XLE US energy sector) — ADR-0018 D3's frozen bracket and
   * D5's deployment fraction for `index_etp_3x` were measured with SPY
   * standing in for the whole subclass. `true` on every other row.
   *
   * Read this through `liveSizingSubclassFor()`, never directly — that
   * function is what a live-sizing consumer (#751) must build its
   * `subclassOf` map from. #903 records the interim resolution.
   */
  readonly subclass_envelope_measured: boolean;
  /**
   * Whether this row is part of the pool's DECLARED DEFAULT SUBSET — the
   * watchlist Samurai falls back to when the screener's output is stale,
   * empty or unreadable (`docs/specs/universe-selector-spec.md`, "Candidate
   * pool", story 12's invariant 3).
   *
   * **Why this field lives in the pool file and not in #751's rotation
   * logic.** The fallback exists to work *when the screener has failed*, so
   * it cannot be derived from anything the screener produces or consumes —
   * not last known ranking (the spec's own third constraint), and not the
   * per-instrument liquidity or cost #750 gates on and the #1034 → #1035
   * chain (`needs-decision` pending #1310) would deliver, because a
   * screener run that could not read its inputs is exactly the run that
   * triggers the fallback. It has to be statically declared in a checked-in
   * artifact, which is this one. #751 owns the fallback's *behaviour* — when
   * it triggers, what alert fires — and never names this field. (This
   * module doc previously said the opposite; see "## The fallback subset"
   * above for what that error was and why it mattered.)
   *
   * Enforced by `assertValidPool`: at least one row must carry `true`, and
   * no more than `FALLBACK_DEFAULT_MAX_ROWS` may. A pool that cannot answer
   * "what do we trade when the screener fails" fails silently on the one day
   * it matters, and the failure presents as a healthy no-trade session.
   */
  readonly fallback_default: boolean;
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
 * The checked-in pool. Thirty-one rows (tradeable ETP lines): nine
 * `index_etp_3x`, twenty-two `single_stock_etp_3x`. That resolves to 26
 * distinct `screening_instrument` values (rankable underlyings; see
 * `countRankableUnderlyings()`) — 6 among the index rows (SPY tripled and
 * QQQ doubled, plus VT, EWY, KWEB, XLE) and 20 among the single-stock rows
 * (NVDA and PLTR each doubled) — since SPY, QQQ, PLTR, and NVDA are the only
 * underlyings carrying more than one line. Every row added by
 * #813 on 2026-08-19 brought a new underlying with it, which is why the row
 * count and the distinct-underlying count moved together. See the module
 * doc's provenance section for why this is still a verified seed of the full
 * three-issuer catalogue rather than an exhaustive scrape, and for the
 * pool-count finding — which of these two counts each downstream ticket
 * (#707, #751) consumes.
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00B7Y34M31',
      issuer: 'WisdomTree',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00B7Y34M31',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3USL.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3USL:xlon',
          uic: 3347273,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
        sibling_line: {
          symbol: '3LUS:xlon',
          uic: 29049628,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
      },
      verified_on: '2026-08-17',
      notes:
        "WisdomTree S&P 500 3x Daily Leveraged. Same product family ADR-0016's 0.18% round-trip " +
        "figure is quoted for. justETF's LSE listing table also shows a GBX (pence) line under " +
        'ticker 3LUS for the same ISIN, which is now its own row directly below and holds the SPY ' +
        'fallback slot (#1220). This USD line stays a pool row — the slot moved, the line was not ' +
        'deleted — but `tradeableUniverse` excludes it, along with every other non-sterling row.',
    },
  },
  {
    lse_ticker: '3LUS',
    screening_instrument: 'SPY',
    underlying: 'S&P 500',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    // No T212 evidence exists for this row and none can be produced: it was
    // compiled after the 2026-08-30 venue change barred T212 outright
    // (#896/#912), so `false` here means "unevidenced", not "T212 does not
    // list it" — see `t212_isa`'s own doc. `t212_source_url` is omitted for
    // the same reason rather than filled with a plausible URL nobody fetched
    t212_isa: false,
    saxo_tradeable: true,
    fallback_default: true,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00B7Y34M31',
      issuer: 'WisdomTree',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00B7Y34M31',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LUS:xlon',
          uic: 29049628,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
        sibling_line: {
          symbol: '3USL:xlon',
          uic: 3347273,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-09-09',
      notes:
        'The sterling line of the SAME ISIN as 3USL above, added by #1220 so the SPY fallback slot ' +
        'can sit on a sterling line. Its Saxo evidence is not a new capture: it is the 2026-09-05 ' +
        "SIM pass's own `sibling_line` for 3USL, promoted deliberately here — the Uic (29049628) " +
        'and asset type are that record, unchanged. `currency: GBX` follows the justETF LSE ' +
        "listing table 3USL's note already cites (a pence line under this ticker); Saxo's search " +
        'endpoint reports GBP for it because it carries no quote unit at all — see ' +
        '`SaxoInstrumentLine.currency`, and #1302 for the pence scaling the execution path applies. ' +
        'No spread, volume or live-GIA tradeability claim is made here beyond that record.',
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
    saxo_tradeable: true,
    fallback_default: true,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00BLRPRL42',
      issuer: 'WisdomTree',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00BLRPRL42',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LQQ3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: 'LQQ3:xlon',
          uic: 29391797,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
        sibling_line: {
          symbol: 'QQQ3:xlon',
          uic: 19640660,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
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
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2472197149',
      issuer: 'Leverage Shares',
      source_url: 'https://www.cnbc.com/quotes/3SPY-GB',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3SPY.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2656472193',
      issuer: 'GraniteShares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2656472193',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LTS.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LTS:xlon',
          uic: 31110397,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2820604770',
      issuer: 'Leverage Shares',
      source_url: 'https://www.cnbc.com/quotes/NVD3-GB',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/NVD3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: 'NVD3:xlon',
          uic: 36215230,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
        sibling_line: {
          symbol: '3NVD:xlon',
          uic: 48409301,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
      },
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
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00BK5BZS07',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=IE00BK5BZS07',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3AAP.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2734938835',
      issuer: 'GraniteShares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2734938835',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LNV.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LNV:xlon',
          uic: 32903440,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
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
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2472197065',
      issuer: 'Leverage Shares',
      source_url: 'https://www.marketscreener.com/quote/etf/LEVERAGE-SHARES-3X-LONG-U-143798640/',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3QQQ.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2901882618',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2901882618',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/MST3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: 'MST3:xlon',
          uic: 45829218,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2856105833',
      issuer: 'GraniteShares',
      source_url: 'https://www.marketscreener.com/quote/etf/GRANITESHARES-3X-LONG-PAL-130089189/',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LPA.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LPA:xlon',
          uic: 41867775,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
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
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2663694680',
      issuer: 'Leverage Shares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2663694680',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/PLT3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: 'PLT3:xlon',
          uic: 36655087,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-17',
      notes:
        "Leverage Shares 3x Palantir ETP Securities, USD line. justETF's LSE table lists three lines " +
        'for this ISIN (3PLT GBX, 3PRE EUR, PLT3 USD); PLT3 is the ticker T212 itself lists, so it is ' +
        'used here.',
    },
  },
  // #813's expansion pass, verified 2026-08-19. Nineteen further rows, each
  // carrying a fetched `source_url` (an AJ Bell LSE instrument page or a
  // justETF profile naming the ISIN and the quoting currency) and a
  // `t212_source_url` whose page title names issuer, underlying and ticker
  // The T212 pages themselves answer HTTP 403 to a programmatic fetch, so
  // the T212 evidence is the search-returned page title — the same standard
  // the eleven rows above were compiled to ("actually fetched OR returned by
  // a web search during this compile")
  {
    lse_ticker: '3LME',
    screening_instrument: 'MSFT',
    underlying: 'Microsoft Corp',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'EUR',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2662640627',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LME',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LME.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LMS:xlon',
          uic: 41867361,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Microsoft Daily ETP. **This row is the EUR line**, not a sterling one: ' +
        'AJ Bell quotes LSE:3LME in euro and the issuer fact summary reads "3LME (EUR) / 3LMP (GBX) / ' +
        '3LMS (USD)". 3LME is nonetheless the only one of the three T212 was found to list, so it is ' +
        'the row here — this file claims listing, not ISA-tradeability (see `t212_isa`), and the ' +
        'settlement-vs-listing-currency risk is residual risk 2 below, one notch louder for this row.',
    },
  },
  {
    lse_ticker: 'LAM3',
    screening_instrument: 'AMD',
    underlying: 'Advanced Micro Devices Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS3075487713',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:LAM3',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LAM3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LAM:xlon',
          uic: 41867782,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long AMD Daily ETP, sterling line. AJ Bell quotes LSE:LAM3 in pence, so the ' +
        'currency is recorded as GBX even though the issuer fact summary loosely says "LAM3 (GBP)" — ' +
        'that field is base currency, not the quote convention, and reading it as pounds is a 100x ' +
        'sizing error. The 3LAM ticker T212 also lists is Euronext Paris, not the LSE; it is not this row.',
    },
  },
  {
    lse_ticker: '3LAL',
    screening_instrument: 'GOOG',
    underlying: 'Alphabet Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2675292309',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LAL',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LAL.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LAL:xlon',
          uic: 41829246,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Alphabet Daily ETP, USD line (issuer fact summary: "3LAL (USD) / 3LGE ' +
        '(EUR) / 3LGP (GBX)"). The issuer names GOOG, not GOOGL, as the tracked share class, so that is ' +
        'the screening instrument. Two lower-confidence points, recorded rather than smoothed over: the ' +
        "T212 search result's title was truncated before the ticker, so the ticker evidence there is the " +
        'URL alone; and a MarketScreener title carries a different ISIN (XS2193968307) for a line of the ' +
        'same name, most likely a superseded one — the fetched AJ Bell page is what this row records.',
    },
  },
  {
    lse_ticker: 'LPP3',
    screening_instrument: 'PYPL',
    underlying: 'PayPal Holdings Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2596087671',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:LPP3',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LPP3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LPP:xlon',
          uic: 41867864,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long PayPal Daily ETP, sterling line, quoted in pence per AJ Bell. T212 lists ' +
        'both LPP3.GB and the USD line 3LPP.GB under the same ISIN; LPP3 is used here because it is the ' +
        'sterling one. (A third 3LPP line trades in euro on Milan — same ticker string, different venue.)',
    },
  },
  {
    lse_ticker: '3LNP',
    screening_instrument: 'NFLX',
    underlying: 'Netflix Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2856106302',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LNP',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LNP.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LNF:xlon',
          uic: 31123656,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Netflix Daily ETP, GBX line (issuer fact summary: "3LNE (EUR) / 3LNF ' +
        '(USD) / 3LNP (GBX)"). A MarketScreener title carries XS2193970543 for a Netflix line of the ' +
        'same name; the fetched AJ Bell pages for all three current lines return XS2856106302, so the ' +
        'older ISIN is treated as superseded and is deliberately not used here.',
    },
  },
  {
    lse_ticker: 'LCO3',
    screening_instrument: 'COIN',
    underlying: 'Coinbase Global Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2575914176',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:LCO3',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LCO3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: 'LCO3:xlon',
          uic: 42347700,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
        sibling_line: {
          symbol: '3LCO:xlon',
          uic: 40906631,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Coinbase Daily ETP, sterling line quoted in pence. Two independently ' +
        "fetched sources agree on ISIN and currency: AJ Bell's LSE:LCO3 page and justETF's profile for " +
        'this ISIN, whose LSE table reads "LCO3 | GBX" and "3LCO | USD". COIN is an equity underlying, ' +
        'so this row is in scope for an equities-only pool — but its price is driven by crypto activity, ' +
        'which is a correlation this pool does not model.',
    },
  },
  {
    lse_ticker: 'LAA3',
    screening_instrument: 'BABA',
    underlying: 'Alibaba Group Holding Ltd',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2842095320',
      issuer: 'GraniteShares',
      source_url: 'https://www.justetf.com/en/etf-profile.html?isin=XS2842095320',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/LAA3.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LAA:xlon',
          uic: 41829249,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Alibaba Daily ETP. The fetched justETF profile for this ISIN lists ' +
        '"London Stock Exchange | LAA3 | GBX (British pence)" alongside the USD line 3LAA. AJ Bell has ' +
        'no page for LAA3, so unlike the neighbouring GraniteShares rows this one rests on a single ' +
        'fetched source for its currency; the T212 listing evidence is independent of it. BABA is the ' +
        'US ADR line, which is what the screener would fetch bars for.',
    },
  },
  {
    lse_ticker: '3LMO',
    screening_instrument: 'MRNA',
    underlying: 'Moderna Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS3069877556',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LMO',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LMO.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Moderna Daily ETP, USD line (AJ Bell quotes LSE:3LMO in dollars). The ' +
        'issuer names a sterling twin, MOL3, but no T212 page for it was found, so the only ' +
        'T212-evidenced Moderna line is this dollar one — recorded as USD rather than substituting the ' +
        'unevidenced sterling ticker.',
    },
  },
  {
    lse_ticker: '3LIP',
    screening_instrument: 'NIO',
    underlying: 'NIO Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS3075487044',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LIP',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LIP.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: '3LNI:xlon',
          uic: 41828820,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long NIO Daily ETP, GBX line (issuer fact summary: "3LIE (EUR) / 3LIP (GBX) / ' +
        '3LNI (USD)"; AJ Bell quotes LSE:3LIP in pence). GraniteShares has published a reverse split for ' +
        'this product, so any historical price series for the ETP line is discontinuous across it — the ' +
        'screener reads NIO, not this line, so it is unaffected, but a mark or PnL history is not.',
    },
  },
  {
    lse_ticker: '3LSQ',
    screening_instrument: 'XYZ',
    underlying: 'Block Inc (formerly Square)',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'USD',
    t212_isa: true,
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2596085972',
      issuer: 'GraniteShares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3LSQ',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3LSQ.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3LSQ:xlon',
          uic: 41846290,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'GraniteShares 3x Long Square Daily ETP, USD line per AJ Bell. **The screening instrument is ' +
        'XYZ, not SQ**: Block renamed its NYSE ticker from SQ to XYZ effective 2025-01-21 (the company ' +
        "issued the change itself), and both the issuer's product page and T212's page title still say " +
        '"Square" — a stale name on the ETP side, not a second instrument. A bar fetch on SQ would ' +
        'resolve to nothing or to the wrong root, which is exactly the confusion the two-field split ' +
        'exists to prevent. The issuer also names a sterling line, LSQ3; no T212 page for it was found.',
    },
  },
  {
    lse_ticker: '3AMZ',
    screening_instrument: 'AMZN',
    underlying: 'Amazon.com Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00BK5BZQ82',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3AMZ',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3AMZ.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Amazon ETP Securities, tracking the iSTOXX Leveraged 3X AMZN Index. AJ Bell ' +
        'quotes LSE:3AMZ in pence; the issuer factsheet lists the same ISIN across three LSE lines ' +
        '(3AMZ sterling, AMZ3 USD, 3AMZE EUR), so the ISIN alone does not identify a tradeable line — ' +
        'the ticker does.',
    },
  },
  {
    lse_ticker: '3FB',
    screening_instrument: 'META',
    underlying: 'Meta Platforms Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'IE00BK5C1B80',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3FB',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3FB.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
        sibling_line: {
          symbol: 'FB3:xlon',
          uic: 35479426,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'USD',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Facebook ETP Securities, sterling line quoted in pence. Both the issuer ' +
        'factsheet and T212 still carry the pre-rename "Facebook" product name; the tracked company is ' +
        "Meta Platforms and the screener's instrument is META, which the issuer's own product page " +
        'states. 3FB is also a Euronext Amsterdam and Borsa Italiana code for this ISIN — the LSE line ' +
        'is the one this row names.',
    },
  },
  {
    lse_ticker: '3UBR',
    screening_instrument: 'UBER',
    underlying: 'Uber Technologies Inc',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2337092550',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3UBR',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3UBR.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Uber ETP Securities, sterling line quoted in pence per AJ Bell. The T212 ' +
        'result title for 3UBR.GB is truncated before the ticker ("Invest in Leverage Shares 3x UBER, ' +
        'London Stock Exchange"), so the ticker evidence there is the URL; the USD twin UBR3.GB carries ' +
        'the full title. Recorded rather than quietly upgraded.',
    },
  },
  {
    lse_ticker: '3RAC',
    screening_instrument: 'RACE',
    underlying: 'Ferrari NV (US ADR)',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2595673190',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3RAC',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3RAC.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long Ferrari ETP, sterling line quoted in pence. The issuer names the ' +
        'underlying as the Ferrari NV ADR and the index as iSTOXX Leveraged 3x RACE, which is where the ' +
        'RACE screening instrument comes from. The ADR’s listing venue was NOT independently ' +
        'confirmed by any page fetched for this row — the company is also Milan-listed, and the two ' +
        'venues do not share a session, so which line the screener actually fetches is worth checking ' +
        'before this row is consumed.',
    },
  },
  {
    lse_ticker: '3ARM',
    screening_instrument: 'ARM',
    underlying: 'Arm Holdings plc (US ADR)',
    leverage: 3,
    direction: 'long',
    subclass: 'single_stock_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: true,
    provenance: {
      isin: 'XS2691006303',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3ARM',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3ARM.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long ARM ETP, sterling line quoted in pence. Underlying is the Arm Holdings ' +
        'ADR per the issuer; the index is iSTOXX Leveraged 3x ARM, which is where the ARM screening ' +
        "ticker comes from. As with 3RAC, the ADR's listing venue was not independently confirmed by a " +
        'fetched page. The USD twin ARM3 is also T212-listed.',
    },
  },
  {
    lse_ticker: '3VT',
    screening_instrument: 'VT',
    underlying: 'Vanguard Total World Stock ETF',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: false,
    provenance: {
      isin: 'XS2399364822',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3VT',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3VT.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long Total World ETP. AJ Bell states the product delivers 3x the daily ' +
        'performance of the Vanguard Total World Stock Index Fund ETF, so the screening instrument is ' +
        'that ETF itself (VT) rather than a proxy — the closest this pool gets to screening the actual ' +
        'tracked object. Sterling line quoted in pence; VT3 (USD) and 3VTE (EUR) share the ISIN. ' +
        'NOT THE SPY-MEASURED ENVELOPE: ADR-0018 measured the `index_etp_3x` bracket and D5 ' +
        'deployment fraction with SPY standing in for the whole subclass. VT is a broader, ' +
        'multi-region tracker, so a consumer sizing this row off the subclass is sizing off an ' +
        'envelope nobody measured for this instrument.',
    },
  },
  {
    lse_ticker: '3KOR',
    screening_instrument: 'EWY',
    underlying: 'iShares MSCI South Korea ETF',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: false,
    provenance: {
      isin: 'XS2472196257',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3KOR',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3KOR.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3KOR:xlon',
          uic: 55762873,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long South Korea ETP, sterling line quoted in pence. AJ Bell names the ' +
        'tracked object as the iShares MSCI South Korea ETF, i.e. EWY. Note the session mismatch in ' +
        'residual risk 3 is worse for this row than for a US single stock: the Korean market that drives ' +
        "EWY's NAV is closed for the whole of the screening window. " +
        'NOT THE SPY-MEASURED ENVELOPE: ADR-0018 measured the `index_etp_3x` bracket and D5 ' +
        'deployment fraction with SPY standing in for the whole subclass. A single-country ' +
        'tracker sits nowhere near 3x SPY, so a consumer sizing this row off the subclass is ' +
        'sizing off an envelope nobody measured for this instrument.',
    },
  },
  {
    lse_ticker: '3KWE',
    screening_instrument: 'KWEB',
    underlying: 'KraneShares CSI China Internet ETF',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: true,
    fallback_default: false,
    subclass_envelope_measured: false,
    provenance: {
      isin: 'XS2800709128',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3KWE',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3KWE.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: {
          symbol: '3KWE:xlon',
          uic: 31532726,
          asset_type: 'Etn',
          exchange_id: 'LSE_ETF',
          currency: 'GBP',
        },
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long China Tech ETP, sterling line quoted in pence. AJ Bell names the ' +
        'KraneShares CSI China Internet ETF (KWEB) as the tracked object. T212 also lists 3KWB.GB, ' +
        'which is the EUR line of the same product — not this row. The same closed-home-market caveat ' +
        'as 3KOR applies, as does 3KOR\u2019s envelope caveat: ADR-0018 measured the `index_etp_3x` ' +
        'bracket and D5 deployment fraction with SPY standing in for the whole subclass, and a ' +
        'single-country sector tracker is not that instrument.',
    },
  },
  {
    lse_ticker: '3XLE',
    screening_instrument: 'XLE',
    underlying: 'Energy Select Sector SPDR Fund',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    saxo_tradeable: false,
    fallback_default: false,
    subclass_envelope_measured: false,
    provenance: {
      isin: 'XS2399370555',
      issuer: 'Leverage Shares',
      source_url: 'https://www.ajbell.co.uk/market-research/LSE:3XLE',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/3XLE.GB',
      saxo: {
        verified_on: '2026-09-05',
        gateway: 'sim',
        line: null,
      },
      verified_on: '2026-08-19',
      notes:
        'Leverage Shares 3x Long Oil & Gas ETP, sterling line quoted in pence. AJ Bell names the Energy ' +
        'Select Sector SPDR Fund (XLE) as the tracked object. T212 also lists 3XEE.GB, the EUR line of ' +
        'the same product \u2014 not this row. NOT THE SPY-MEASURED ENVELOPE: ADR-0018 measured the ' +
        '`index_etp_3x` bracket and D5 deployment fraction with SPY standing in for the whole ' +
        'subclass. A single-sector tracker is not that instrument, so a consumer sizing this row ' +
        'off the subclass is sizing off an envelope nobody measured for it.',
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
 * Resolves the Market Intelligence RETRIEVAL subject for an instrument — the
 * "key on `screening_instrument`, not `lse_ticker`" rule #960 recorded as
 * MI-wide (#914). News/sentiment/X coverage for an LSE-listed leveraged ETP
 * is filed under, and must be read back under, the liquid US underlying it
 * tracks: a 3x wrapper generates no headlines of its own, and keying MI on
 * the wrapper produces either an invisible-wrong class-wide read (#914's
 * measured defect) or a permanent `NO_DATA_MARKER` for a name that genuinely
 * has coverage under its underlying.
 *
 * Unlike `screeningInstrumentFor`, this ALWAYS returns a usable subject
 * rather than `null`: a non-pool instrument (every name in today's
 * `DEFAULT_UNIVERSE` — SPY, QQQ, AAPL, TSLA, and crypto ids like `BTC-USD`)
 * already IS its own MI subject, so the fallback is the identity, not a
 * missing answer.
 *
 * Same routing caveat as `screeningInstrumentFor` above: this is a lookup for
 * WHAT TO ASK MI FOR, never for order placement or bar-fetching — those stay
 * keyed on `lse_ticker` (or the routing map's inverse), and nothing here
 * changes that.
 */
export function resolveMiSubject(
  instrument: string,
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): string {
  return screeningInstrumentFor(instrument, pool) ?? instrument;
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
 * The subclass a LIVE-SIZING consumer may use for this row, or `undefined`
 * when ADR-0018's D3/D5 numbers for that subclass were never measured
 * against an instrument like it (#903).
 *
 * **This is the function a future `UniverseInstrument[]` builder (#751) MUST
 * call when setting `UniverseInstrument.subclass` from a pool row.** Reading
 * `row.subclass` directly would silently re-introduce the hazard #813's
 * widening created: `UniverseInstrument.subclass` is optional specifically
 * so an unset value arms NO per-subclass regime for that instrument
 * (`subclassOfUniverse`, `server/apps/orchestrator/types.ts`, filters out
 * `instrument.subclass === undefined`) rather than sizing it off another
 * instrument's envelope — the same "unclassified is safer than
 * misclassified" argument `resolveSubclassBracket`
 * (`server/pipeline/trader/subclass-bracket.ts`) makes one stage later. A
 * `subclassOf` map built with `liveSizingSubclassFor` therefore cannot
 * contain 3VT, 3KOR, 3KWE or 3XLE, and `resolveSubclassBracket` throws
 * `SubclassBracketUnresolvableError` for any of them rather than sizing
 * against the SPY-measured `index_etp_3x` bracket (see
 * `lse-etp-pool.test.ts`, which asserts this end-to-end against the real
 * function, not just against this file's flag).
 *
 * **What this does NOT close.** A caller can still read `row.subclass`
 * directly and bypass this entirely — Option 3 (#903's chosen resolution)
 * is "structurally excluded from live sizing" through this helper plus the
 * test that proves it, not a type-level guarantee that no code path can
 * reach `row.subclass`. #751 must use this helper; nothing here can force
 * it to.
 *
 * Screening/ranking is untouched by this function and must stay that way —
 * `countRankableUnderlyings` and every other screening consumer keep
 * reading the full `LSE_ETP_POOL` (31 rows, 26 underlyings) unchanged, since
 * this exclusion is sizing-only, not a pool filter.
 */
export function liveSizingSubclassFor(row: LseEtpPoolRow): InstrumentSubclass | undefined {
  return row.subclass_envelope_measured ? row.subclass : undefined;
}

/**
 * Row-level admission decision the liquidity gate actually applies:
 * admit-unless-verified-`false`. An `'unverified'` row is admitted, because
 * an unarmed gate must pass rows through rather than exclude on a
 * tradeability claim nobody has checked (see `saxo_tradeable`'s own doc on
 * `LseEtpPoolRow`); only a Saxo-VERIFIED `false` excludes. `liquidityGateStatus`
 * and `assertValidFallbackSubset` both read admission through this function
 * rather than re-deriving it from `saxo_tradeable` a second way — "what does
 * the gate admit" is answered in exactly one place, so the two can never
 * silently disagree (#1100 review: they used to — see `liquidityGateStatus`).
 */
export function gateAdmits(row: LseEtpPoolRow): boolean {
  return row.saxo_tradeable !== false;
}

/**
 * Whether the row's LSE line is quoted in sterling — the second gate the
 * tradeable universe applies, alongside `gateAdmits` (#1220).
 *
 * David's 2026-09-08 ruling on #1220 excludes the non-sterling lines outright
 * for the live ramp rather than deprioritising them: the GBP/USD leg between
 * entry and exit is an uncompensated term nothing in this system prices (the
 * cost model has no FX margin — see `venues.saxo` in
 * `server/tools/backtest/types.ts`), and a broker fee arriving in a foreign
 * currency is summed into a GBP book. A ranked-last USD row is still a row
 * the screener can surface on a thin day; an excluded one cannot.
 *
 * GBX is IN. Pence is an exact unit conversion, not an FX rate, and #1302
 * already lands the scaling through Saxo's `PriceToContractFactor`.
 *
 * Delegates to `isBookCurrency` (`shared/book-currency.ts`, #1465) rather
 * than a hand-duplicated code list: this file already imports the `shared`
 * barrel for `AssetClass`/`InstrumentSubclass` (no `assertValidPool`-at-
 * import cost the way importing `market-data-service` would carry), so the
 * two "is this sterling" answers can no longer silently diverge the way
 * `gateAdmits` once did (#1100).
 */
export function isSterlingQuoted(row: LseEtpPoolRow): boolean {
  return isBookCurrency(row.currency);
}

/**
 * The rows a live consumer may trade: Saxo-listed (`gateAdmits`) AND
 * sterling-quoted (`isSterlingQuoted`).
 *
 * **This is the function #751's `ActiveUniverseProvider` must build its
 * `UniverseInstrument[]` from**, the same way `liveSizingSubclassFor` is the
 * function it must set `subclass` through. Reading `LSE_ETP_POOL` directly
 * would readmit the twelve non-sterling lines the #1220 ruling excluded.
 *
 * The two gates stay separate predicates rather than folding currency into
 * `gateAdmits`: that function is the Saxo LIQUIDITY gate, and
 * `liquidityGateStatus`'s reasons speak in `saxo_tradeable`'s own terms —
 * folding currency in would make it report "every row is Saxo-verified
 * false" for a USD row Saxo verified true.
 *
 * **The result is deliberately narrow, and that is the ruling's own
 * consequence, not a bug**: five rows of the checked-in thirty-one. Universe
 * width for the live ramp is #1310's.
 */
export function tradeableUniverse(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): readonly LseEtpPoolRow[] {
  return pool.filter((row) => gateAdmits(row) && isSterlingQuoted(row));
}

/**
 * The gate's own account of whether `saxo_tradeable` is doing anything,
 * classified off `gateAdmits`'s row-level decision rather than off
 * `saxo_tradeable` directly — so this can never say something `gateAdmits`
 * itself would disagree with (it is `assertValidPool`'s own source of truth,
 * not a parallel description of it).
 *
 * - `'unarmed'` — no row (or an empty pool) carries a Saxo-verified value;
 *   every row is `'unverified'`. The gate has nothing to exclude on yet and
 *   MUST be read as pass-through, not as "nothing is tradeable". This was
 *   the checked-in pool's state from #1054 Part 1 until #1032 item 3's
 *   evidence pass (2026-09-05) armed it.
 * - `'vacuous'` — at least one row carries a Saxo-verified value, but
 *   `gateAdmits` returns the SAME answer for every row — all admitted, or
 *   all excluded. This is not a legitimate configuration: a gate that
 *   excludes nothing, or excludes everything, on every input is a bug.
 *   `admits` names which extreme it is. `assertValidPool` refuses a pool in
 *   this state.
 * - `'armed'` — `gateAdmits` disagrees between at least two rows. The gate
 *   has real information to exclude on.
 */
export type LiquidityGateStatus =
  | { readonly state: 'unarmed'; readonly reason: string }
  | { readonly state: 'armed'; readonly reason: string }
  | { readonly state: 'vacuous'; readonly admits: boolean; readonly reason: string };

export function liquidityGateStatus(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): LiquidityGateStatus {
  // "Armed at all" and "what it decides" are two different questions, asked
  // in two passes on purpose. Collapsing them into one pass that just tracks
  // whether `saxo_tradeable` is constant (as an earlier version of this
  // function did) answers "armed" from `saxo_tradeable`'s raw distinctness
  // instead of from `gateAdmits`'s actual output, which is the wrong
  // question: `liquidityGateStatus([{unverified}, {true}])` reported 'armed'
  // even though admit-unless-false admits both rows, so nothing is excluded
  const verifiedCount = pool.filter((row) => row.saxo_tradeable !== 'unverified').length;
  if (pool.length === 0 || verifiedCount === 0) {
    return {
      state: 'unarmed',
      reason:
        pool.length === 0
          ? 'Empty pool — there is nothing for the gate to exclude on.'
          : "Every row's saxo_tradeable is 'unverified' — no Saxo instrument evidence has been " +
            'captured for this pool (#1032 item 3 did so for the checked-in pool). The gate is ' +
            'explicitly UNARMED: it passes every row through rather than excluding on a ' +
            'tradeability claim nothing has verified.',
    };
  }
  let admitsAll = true;
  let excludesAll = true;
  for (const row of pool) {
    if (gateAdmits(row)) {
      excludesAll = false;
    } else {
      admitsAll = false;
    }
  }
  if (admitsAll || excludesAll) {
    return {
      state: 'vacuous',
      admits: admitsAll,
      reason: admitsAll
        ? "gateAdmits(row) is true for every row (no row is Saxo-verified 'false'). A gate that " +
          'excludes nothing on every input is not a legitimate configuration.'
        : "gateAdmits(row) is false for every row (every row is Saxo-verified 'false'). A gate " +
          'that excludes everything on every input is equally broken.',
    };
  }
  return {
    state: 'armed',
    reason: 'gateAdmits(row) disagrees between rows — the gate has real exclusion information.',
  };
}

/**
 * Validates every row of a pool: subclass is recognised (fails loud per
 * `assertKnownSubclass`), and both instrument-identity fields are non-empty
 * and distinct — distinct meaning UNEQUAL AFTER TRIMMING AND CASE-FOLDING
 * (`'3USL'` and `' 3usl '` are the SAME identity here, not two). Rejects a
 * whole malformed pool at once rather than letting a bad row surface later as
 * a routing throw mid-session.
 *
 * Distinctness is the invariant this module exists to carry: `buildRoutingMap`
 * binds only on `lse_ticker`, which is what makes a wrong-root fetch/route
 * impossible by construction rather than by convention (see module doc). A row
 * whose two identities coincide collapses that split back into one overloaded
 * identifier, so it is refused here rather than merely observed by a test
 * against the checked-in pool (#807).
 *
 * **Why this comparison folds case while `buildRoutingMap` and
 * `screeningInstrumentFor` match case-sensitively.** Those two do runtime key
 * lookup, where the exact string a caller holds is the key and must match
 * exactly. This is authoring-time data hygiene on a hand-compiled file, where
 * a pair differing only in case or surrounding whitespace is a transcription
 * of one identifier, never two genuinely different instruments on two venues —
 * exactly the identity confusion the named field pair was introduced to
 * refuse. Case-sensitive validation here would wave through the confusing case
 * and catch only the obvious one.
 *
 * The comparison is equality on the normalised values, never containment: the
 * checked-in pool legitimately holds `3SPY`/`SPY` and `3QQQ`/`QQQ`, which are
 * a distinct ETP line and its distinct US underlying.
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
    if (row.lse_ticker.trim().toUpperCase() === row.screening_instrument.trim().toUpperCase()) {
      throw new Error(
        `LSE ETP pool row '${row.lse_ticker}' has an lse_ticker and a screening_instrument that are ` +
          `the same identity ('${row.lse_ticker}' vs '${row.screening_instrument}', compared after ` +
          'trimming and case-folding). They name genuinely different objects — the LSE-listed ETP ' +
          'Samurai routes orders against, and the US underlying the screener fetches bars for — and ' +
          'a row where they coincide collapses that split back into one overloaded identifier, which ' +
          'is what buildRoutingMap binding only on lse_ticker exists to make impossible.',
      );
    }
  }
  assertLiquidityGateNotVacuous(pool);
  assertValidFallbackSubset(pool);
}

/**
 * Refuses a pool whose liquidity gate (`saxo_tradeable`) is 'vacuous' per
 * `liquidityGateStatus` — constant `true` or constant `false` across every
 * row. Both are a no-op-or-total gate shipping silently, this repo's
 * dominant defect class (a mechanism that runs but enforces nothing) one
 * level up: the ORIGINAL version of this defect was exactly this, with
 * `t212_isa` constant `true` on all 30 rows then in the pool (#1054).
 *
 * The `'unarmed'` state (constant `'unverified'`) does NOT throw here — see
 * `liquidityGateStatus`'s own doc for why that state is the honest one, not
 * the bug. If a future evidence pass verifies every row to the SAME value,
 * that is either a coincidence worth recording explicitly (not just leaving
 * the field uniform and silent) or, if it is genuinely accurate, a signal
 * that `saxo_tradeable` has stopped carrying exclusion information and the
 * real gate has to come from #1054 Part 2's cost ceiling instead — never a
 * reason to flip one row back to the other value just to silence this check.
 */
function assertLiquidityGateNotVacuous(pool: readonly LseEtpPoolRow[]): void {
  const status = liquidityGateStatus(pool);
  if (status.state === 'vacuous') {
    throw new Error(
      `LSE ETP pool's liquidity gate (saxo_tradeable) is constant across all ${pool.length} rows: ` +
        `gateAdmits ${status.admits ? 'admits every row' : 'excludes every row'}. ${status.reason} If ` +
        'Saxo tradeability is now genuinely uniform, record that explicitly (this function, or a ' +
        'comment on the pool) rather than shipping a field that looks armed but excludes nothing — ' +
        "and land #1054 Part 2's cost ceiling as the real gate, since a uniform-true tradeability " +
        'flag can no longer do that job.',
    );
  }
}

/**
 * The most rows `assertValidPool` will accept as the fallback subset.
 *
 * The spec does not put a number on the loader; it puts one on the subset
 * ("sized to the watchlist range (5–10 names)") and gives the reason:
 * falling back to every row "would deploy into 30 names at once, which the
 * subclass envelope refuses anyway — so the fallback would produce a
 * refusal storm instead of trading". The same 10 is also the tick
 * budget (τ = 2 min against the instrument-pass cost), which "binds whatever
 * produced the list" — the fallback included. So the ceiling is enforced.
 *
 * **The floor deliberately is not.** The spec's only stated loader rule is
 * that a pool carrying NO fallback row is rejected; "5–10" describes how the
 * subset should be sized, not a condition the loader was asked to fail on,
 * and a hard floor of 5 would reject a legitimately small future pool for
 * violating a range written against this one.
 */
export const FALLBACK_DEFAULT_MAX_ROWS = 10;

/**
 * Enforces the six rules on the pool's declared fallback subset.
 *
 * Rule 1 is the spec's: "a pool with no `fallback_default` row is rejected at
 * load, not at fallback time".
 *
 * **Rule 2 is a ceiling, not the spec's "Not the full pool" clause**, and the
 * difference matters: a pool of ten rows or fewer may mark every row and
 * still pass. A strict `fallback.length < pool.length` subset rule is
 * deliberately not enforced, for the same reason the 5-row floor is not — it
 * would reject a legitimately small future pool for violating a range written
 * against this 31-row one. At any pool size the ceiling is the binding
 * constraint the spec gives a reason for (the refusal storm, and the tick
 * budget); "not the full pool" is a property of a pool this size, which
 * `lse-etp-pool.test.ts` pins on the checked-in artifact rather than here.
 *
 * **Rule 3 — every fallback row must carry a measured subclass envelope.**
 * Degraded mode is the worst place to discover an unmeasured envelope: there
 * is no screener running to notice, and `liveSizingSubclassFor` omits the
 * unmeasured rows, so a fallback list holding one would size against nothing.
 * The subset selection was made on this basis (#903); the rule stops a later
 * edit from marking a widened row without re-reading that reasoning.
 *
 * **Rule 4 — no two fallback rows may share a `screening_instrument` — is
 * this module's own invariant, not the spec's**, and is called out as such
 * here and in its throw message so it can be removed without hunting for a
 * document that required it. It exists because four underlyings in this pool
 * (SPY, QQQ, PLTR, NVDA) carry two ETP lines each, and a fallback list that
 * picked up both lines of one underlying would concentrate a degraded-mode
 * session on a single name — in precisely the mode where no screener is
 * running to notice.
 *
 * **Rule 5 is the spec's ("Fallback behaviour"): no fallback row may be one
 * `gateAdmits` excludes** — i.e. none may carry a Saxo-VERIFIED
 * `saxo_tradeable: false`. A fallback watchlist that can hand back a name
 * Saxo has been verified NOT to list is the silent halt wearing the
 * fallback's name. This is deliberately "not verified ineligible", not
 * "verified eligible", so a future pool whose rows are still `'unverified'`
 * loads (#1054 Part 1); the checked-in pool's fallback rows are all
 * verified `true` regardless (#1032 item 3), which `lse-etp-pool.test.ts`
 * pins on the artifact rather than here.
 *
 * **Rule 6 — no fallback row may be non-sterling** (#1220, David's
 * 2026-09-08 ruling). `tradeableUniverse` excludes USD and EUR lines
 * outright, so a fallback row in one of those currencies would hand degraded
 * mode an instrument selection has already refused. This is rule 5's argument
 * one gate over, and it is what dropped the four USD fallback rows (3LTS,
 * NVD3, 3LPA, 3LAL) the 2026-09-05 subset named: unlike 3USL, none of them
 * has a sterling line of the same ISIN to move to, so they fall out with no
 * replacement.
 */
export function assertValidFallbackSubset(pool: readonly LseEtpPoolRow[]): void {
  const fallback = pool.filter((row) => row.fallback_default);
  if (fallback.length === 0) {
    throw new Error(
      'LSE ETP pool declares no fallback_default row. A pool that cannot answer "what do we ' +
        'trade when the screener fails" fails silently on the one day it matters, and the failure ' +
        'presents as a healthy no-trade session — so it is refused at load rather than at fallback ' +
        'time (docs/specs/universe-selector-spec.md, "Candidate pool").',
    );
  }
  if (fallback.length > FALLBACK_DEFAULT_MAX_ROWS) {
    throw new Error(
      `LSE ETP pool declares ${fallback.length} fallback_default rows, above the ` +
        `${FALLBACK_DEFAULT_MAX_ROWS}-row ceiling. The fallback is a subset, not the pool: falling ` +
        'back to every row deploys into more names than the subclass envelope admits, so it ' +
        'produces a refusal storm instead of trading, and it breaches the same tick budget the ' +
        'active-list cap exists to bound.',
    );
  }
  for (const row of fallback) {
    if (!row.subclass_envelope_measured) {
      throw new Error(
        `LSE ETP pool marks '${row.lse_ticker}' as a fallback_default row, but its subclass ` +
          'envelope was never measured (#903). Degraded mode is the worst place to discover an ' +
          'unmeasured envelope: no screener is running to notice, and liveSizingSubclassFor omits ' +
          'the unmeasured rows, so the fallback would size against nothing.',
      );
    }
  }
  const seen = new Map<string, string>();
  for (const row of fallback) {
    const key = row.screening_instrument.trim().toUpperCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `LSE ETP pool marks two fallback_default rows on the same screening_instrument ` +
          `('${prior}' and '${row.lse_ticker}' both rank on '${row.screening_instrument}'). This ` +
          "rule is this module's own invariant, not one docs/specs/universe-selector-spec.md " +
          'states: two ETP lines on one underlying is doubled exposure to a single name in the ' +
          'one mode where no screener is running to notice.',
      );
    }
    seen.set(key, row.lse_ticker);
  }
  for (const row of fallback) {
    if (!gateAdmits(row)) {
      throw new Error(
        `LSE ETP pool marks '${row.lse_ticker}' as a fallback_default row, but saxo_tradeable is ` +
          'Saxo-verified false for it. A fallback watchlist that can return a name Saxo has been ' +
          "verified NOT to list is the silent halt wearing the fallback's name " +
          '(docs/specs/universe-selector-spec.md, "Fallback behaviour").',
      );
    }
  }
  for (const row of fallback) {
    if (!isSterlingQuoted(row)) {
      throw new Error(
        `LSE ETP pool marks '${row.lse_ticker}' as a fallback_default row, but its line is quoted ` +
          `in '${row.currency}', which is not sterling. #1220's ruling (David, 2026-09-08) excludes ` +
          'non-sterling lines from the tradeable universe for the live ramp, so a fallback holding ' +
          'one hands degraded mode an instrument selection has already refused — the same silent ' +
          'halt rule 5 refuses one gate over.',
      );
    }
  }
}

assertValidPool(LSE_ETP_POOL);
