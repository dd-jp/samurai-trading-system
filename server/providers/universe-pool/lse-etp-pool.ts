/**
 * The LSE leveraged-ETP pool: a checked-in, hand-compiled list of leveraged
 * ETPs Samurai may trade on the live equity leg (Saxo GIA, GBP account,
 * LSE-listed), each paired with the separate US instrument the screener
 * ranks it on.
 *
 * `lse_ticker` is what Samurai holds and routes orders against.
 * `screening_instrument` is what the screener fetches bars for and computes
 * indicators on — the US underlying, since there is no free LSE intraday
 * history. These are different objects on different venues in different
 * currencies, kept as a NAMED field pair rather than one overloaded
 * identifier. `buildRoutingMap` below binds ONLY on `lse_ticker`;
 * `screening_instrument` is never looked up there — wiring bar-fetch and
 * order-routing off two different fields makes a wrong-root fetch/route
 * impossible by construction.
 *
 * This file is data plus a type, not wiring: it is not yet consumed by the
 * production/paper universe builders, so landing `subclass` here does not
 * yet arm `per_subclass_deployment_cap` against unreviewed rows.
 *
 * `fallback_default` marks the hand-declared watchlist a caller falls back
 * to when the screener's output is stale, empty or unreadable — it lives
 * here rather than in the fallback's own consumer, since a fallback derived
 * from anything the screener produces is unavailable exactly when needed.
 * `assertValidFallbackSubset` enforces its rules; see that function.
 *
 * The live venue is Saxo Capital Markets UK (GIA), not Trading 212 (barred
 * outright by its own algo-trading terms). `t212_isa`/`t212_source_url`
 * answer "does Trading 212 list this ticker", a different, still-recorded
 * claim from `saxo_tradeable` (the Saxo-sourced field — see
 * `SaxoInstrumentEvidence`), captured against the SIM gateway only, not yet
 * verified against a live account.
 *
 * `subclass_envelope_measured` is `false` on the four rows (3VT, 3KOR,
 * 3KWE, 3XLE) whose underlying is nothing like SPY: ADR-0018 D3/D5's
 * `index_etp_3x` numbers were measured with SPY standing in for the whole
 * subclass. `liveSizingSubclassFor()` is the function a live-sizing
 * consumer MUST read this through — never `row.subclass` directly — since
 * it returns `undefined` for these four rather than silently sizing them
 * off SPY's bracket.
 *
 * `tradeableUniverse()` additionally excludes every non-sterling row: the
 * GBP/USD leg between entry and exit is an uncompensated cost nothing here
 * prices, and a foreign-currency broker fee cannot be summed cleanly into a
 * GBP book.
 *
 * This pool (31 rows / 26 distinct underlyings, see
 * `countRankableUnderlyings()`) is a verified seed of the three-issuer
 * catalogue (Leverage Shares, WisdomTree, GraniteShares), not a claim of
 * completeness — none of the issuers' short (-3x) side is represented,
 * every row is `direction: 'long'`. Each row cites a fetched source for
 * ISIN/currency and a T212 page title as listing evidence
 * (`RowProvenance`); see individual rows' `notes` for row-specific caveats.
 *
 * Residual risks, recorded rather than left to be discovered:
 * 1. Tracking error — each ETP resets DAILY, so a reach rate measured on the
 *    underlying does not transfer 1:1, especially on rough intraday paths.
 * 2. The underlying-vs-ETP FX leg — every underlying is USD-denominated even
 *    on a sterling-quoted line, and no universe filter can remove that.
 * 3. Session offset — the screener's session starts at the 14:30 London US
 *    cash open; the LSE line has already traded since 08:00.
 */
import { type AssetClass, type InstrumentSubclass, isBookCurrency } from '../../shared/index.js';

/** Long/short stance the ETP itself carries — separate from any debate direction */
type EtpDirection = 'long' | 'short';

/**
 * `true`/`false` are a Saxo-sourced verified claim; nothing may set either
 * without that source. `'unverified'` is not a placeholder default — it
 * explicitly records that no such capture exists for the row. See
 * `LseEtpPoolRow.saxo_tradeable` and `liquidityGateStatus`.
 */
type SaxoTradeability = true | false | 'unverified';

/**
 * One LSE line as Saxo's `GET /ref/v1/instruments` returns it. `exchange_id`
 * is `LSE_ETF` on every LSE ETP line — `ExchangeId=LSE` returns nothing for
 * these, which is why the capture keyed on symbol/ISIN instead.
 */
interface SaxoInstrumentLine {
  readonly symbol: string;
  readonly uic: number;
  readonly asset_type: 'Etn' | 'Etf' | 'Etc';
  readonly exchange_id: 'LSE_ETF';
  /**
   * Provenance only — what the search endpoint reported, which for a
   * GBX-quoted line is `GBP` (it carries no quote unit at all). Never derive
   * a cash amount from this; `saxoInstrumentResolverFromVenue` reads the
   * details endpoint's own currency fields for that.
   */
  readonly currency: string;
}

/**
 * The row's Saxo evidence, searched by ticker AND ISIN. `line` is the
 * row's OWN ticker line (`saxo_tradeable` is `true` iff non-null).
 * `sibling_line` is a DIFFERENT ticker under the same ISIN, recorded for a
 * future deliberate re-key — never what the row trades. `gateway: 'sim'`
 * is a real caveat: re-verify against the live gateway before the live
 * ramp.
 */
interface SaxoInstrumentEvidence {
  readonly verified_on: string;
  readonly gateway: 'sim';
  readonly line: SaxoInstrumentLine | null;
  readonly sibling_line?: SaxoInstrumentLine;
}

/** Per-row citation — a shared file-level date can't say which claim (ticker, ISIN, currency, listing) came from which fetch */
interface RowProvenance {
  /** ISIN of the ETP, as stated by the issuer/aggregator source below */
  readonly isin: string;
  /** One of the three named issuers: 'Leverage Shares' | 'WisdomTree' | 'GraniteShares' */
  readonly issuer: string;
  /** A URL actually fetched or returned by search during this compile, naming ticker/ISIN/currency */
  readonly source_url: string;
  /**
   * A trading212.com instrument page confirming T212 lists this ticker.
   *
   * Optional: absent means exactly one thing — no T212 evidence exists for
   * this row (rows added after T212 was barred outright cannot carry one,
   * since that research pass no longer runs). Citing a plausible-looking
   * URL nobody fetched would be worse than the absence in a file whose whole
   * discipline is provenance. Read `t212_isa` the same way on such a row.
   */
  readonly t212_source_url?: string;
  /** ISO date this row was compiled/verified */
  readonly verified_on: string;
  /** What Saxo's own instrument list says about this row — the source of `saxo_tradeable` */
  readonly saxo: SaxoInstrumentEvidence;
  /** Anything uncertain about this specific row that a reader must not silently trust */
  readonly notes?: string;
}

/** One tradeable-instrument row */
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
   * Best-effort: does Trading 212 LIST this ticker (from T212's own public
   * instrument pages), never a Saxo or tradeability/spread claim. On a row
   * compiled after T212 was barred, `false` means "no T212 evidence
   * exists", not "T212 does not list it" — such rows carry no
   * `t212_source_url` and say so in `provenance.notes`.
   */
  readonly t212_isa: boolean;
  /**
   * Tradeable on Saxo Capital Markets UK (GIA) — the live venue — sourced
   * from Saxo's OWN instrument list (`provenance.saxo`). This is the hard
   * liquidity gate; `t212_isa` is a different, unrelated claim. `false`
   * covers two cases the evidence block distinguishes: a sibling line under
   * the same ISIN lists but not this ticker, or nothing lists at all —
   * neither is a claim about the underlying product. `'unverified'` is not
   * a placeholder for `true`; read through `liquidityGateStatus`.
   */
  readonly saxo_tradeable: SaxoTradeability;
  /**
   * Whether ADR-0018's D3/D5 numbers for THIS row's `subclass` were actually
   * measured against an instrument like it — not just whether the subclass
   * string is recognised (`assertKnownSubclass`'s separate, weaker job).
   * `false` on the four rows whose underlying is nothing like SPY (3VT,
   * 3KOR, 3KWE, 3XLE). Read through `liveSizingSubclassFor()`, never
   * directly.
   */
  readonly subclass_envelope_measured: boolean;
  /**
   * Whether this row is part of the pool's declared fallback watchlist —
   * used when the screener's output is stale, empty or unreadable. Lives
   * here rather than in the consumer's rotation logic because the fallback
   * must work when the screener has failed, so it can't be derived from
   * anything the screener produces. Enforced by `assertValidPool`.
   */
  readonly fallback_default: boolean;
  readonly provenance: RowProvenance;
}

/**
 * The subclasses this pool file may legally populate — a SUBSET of
 * `InstrumentSubclass`. `'crypto'` is excluded on purpose (never appears in
 * an LSE equity pool) so an accidental crypto row fails as loudly as an
 * unrecognised string would.
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
 * The checked-in pool: 31 rows (tradeable ETP lines) resolving to 26
 * distinct `screening_instrument` values (rankable underlyings — see
 * `countRankableUnderlyings()`), since SPY, QQQ, PLTR and NVDA each carry
 * more than one line
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
    // Compiled after T212 was barred — `false` means "unevidenced", not
    // "T212 does not list it"; see `t212_isa`'s own doc
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
  // Verified 2026-08-19. T212 pages answer HTTP 403 to a programmatic fetch,
  // so `t212_source_url` evidence below is the search-returned page title,
  // not a direct read of the page
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
 * The `screening_instrument` for a traded `lse_ticker`, or `null` when it's
 * not a pool row at all. A LOOKUP, not the inverse of `buildRoutingMap` —
 * must never be used to pick an API root or place an order.
 */
export function screeningInstrumentFor(
  lseTicker: string,
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): string | null {
  return pool.find((row) => row.lse_ticker === lseTicker)?.screening_instrument ?? null;
}

/**
 * Market Intelligence retrieval subject for an instrument — MI is keyed on
 * `screening_instrument`, not `lse_ticker`, since a 3x wrapper generates no
 * headlines of its own. Unlike `screeningInstrumentFor`, always returns a
 * usable subject: a non-pool instrument already IS its own MI subject.
 * Never used for order placement or bar-fetching.
 */
export function resolveMiSubject(
  instrument: string,
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): string {
  return screeningInstrumentFor(instrument, pool) ?? instrument;
}

/**
 * Distinct `screening_instrument` values (rankable underlyings, not
 * tradeable ETP lines) — the count the screener's ranking step consumes,
 * strictly less than `pool.length` whenever an underlying carries more than
 * one issuer's ETP line
 */
export function countRankableUnderlyings(pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL): number {
  return new Set(pool.map((row) => row.screening_instrument)).size;
}

/**
 * The subclass a LIVE-SIZING consumer may use for this row, or `undefined`
 * when its envelope was never measured. A future universe builder MUST
 * call this rather than reading `row.subclass` directly — an unset
 * `UniverseInstrument.subclass` arms no per-subclass regime, which is safer
 * than silently sizing against another instrument's envelope. Does not
 * change screening/ranking, which still reads the full pool unfiltered —
 * this exclusion is sizing-only.
 */
export function liveSizingSubclassFor(row: LseEtpPoolRow): InstrumentSubclass | undefined {
  return row.subclass_envelope_measured ? row.subclass : undefined;
}

/**
 * Row-level admission: admit-unless-verified-`false`. An `'unverified'` row
 * is admitted — an unarmed gate must pass rows through, not exclude on a
 * tradeability claim nobody checked. Both `liquidityGateStatus` and
 * `assertValidFallbackSubset` read admission through this single function so
 * the two can never silently disagree.
 */
export function gateAdmits(row: LseEtpPoolRow): boolean {
  return row.saxo_tradeable !== false;
}

/**
 * Whether the row's LSE line is quoted in sterling — the second gate
 * alongside `gateAdmits`: the GBP/USD leg between entry and exit is an
 * uncompensated cost nothing here prices, and a foreign-currency broker fee
 * cannot be summed cleanly into a GBP book. GBX is IN — pence is an exact
 * unit conversion, not an FX rate.
 */
export function isSterlingQuoted(row: LseEtpPoolRow): boolean {
  return isBookCurrency(row.currency);
}

/**
 * The rows a live consumer may trade: Saxo-listed AND sterling-quoted. This
 * is the function a live universe builder must build its instruments from —
 * reading `LSE_ETP_POOL` directly would readmit the excluded non-sterling
 * lines. Deliberately narrow: five rows of the checked-in thirty-one.
 */
export function tradeableUniverse(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): readonly LseEtpPoolRow[] {
  return pool.filter((row) => gateAdmits(row) && isSterlingQuoted(row));
}

/**
 * Whether `saxo_tradeable` is doing anything, classified off `gateAdmits`'s
 * output (never re-derived from `saxo_tradeable` directly, so the two can't
 * disagree). `'unarmed'` = every row `'unverified'`, must read as
 * pass-through. `'vacuous'` = `gateAdmits` agrees on every row (admits all
 * or excludes all) — not a legitimate configuration; `assertValidPool`
 * refuses it. `'armed'` = `gateAdmits` disagrees between rows.
 */
export type LiquidityGateStatus =
  | { readonly state: 'unarmed'; readonly reason: string }
  | { readonly state: 'armed'; readonly reason: string }
  | { readonly state: 'vacuous'; readonly admits: boolean; readonly reason: string };

export function liquidityGateStatus(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): LiquidityGateStatus {
  // Two passes on purpose: "armed at all" and "what it decides" must read off
  // `gateAdmits`'s actual output, not `saxo_tradeable`'s raw distinctness —
  // the latter reported 'armed' for a case where nothing was excluded
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
 * Validates every row: subclass recognised, both identity fields non-empty
 * and distinct after TRIMMING AND CASE-FOLDING (`'3USL'`/`' 3usl '` are the
 * same identity, not two). Rejects the whole pool at once rather than
 * letting a bad row surface later as a routing throw mid-session. Folds
 * case here (unlike `buildRoutingMap`'s runtime lookups, which must match
 * exactly) because this is authoring-time hygiene on a hand-compiled file,
 * where a case/whitespace-only difference is a transcription of one
 * identifier, never two genuinely different instruments.
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
 * Refuses a pool whose liquidity gate is 'vacuous' (constant `true` or
 * `false` across every row) — a no-op-or-total gate shipping silently. The
 * `'unarmed'` state does NOT throw — see `liquidityGateStatus`'s own doc
 * for why that one is honest.
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
 * The most rows `assertValidPool` will accept as the fallback subset. The
 * spec sizes the watchlist at 5-10 names and gives the reason: falling back
 * to every row would produce a refusal storm instead of trading, and 10 is
 * also the tick budget. The floor is deliberately NOT enforced — only "no
 * fallback row at all" is a loader failure; a hard floor would reject a
 * legitimately small future pool.
 */
export const FALLBACK_DEFAULT_MAX_ROWS = 10;

/**
 * Enforces six rules on the pool's declared fallback subset:
 * 1. At least one `fallback_default` row exists (the spec's own rule).
 * 2. At most `FALLBACK_DEFAULT_MAX_ROWS` — a ceiling, not "not the full
 *    pool"; a pool of ≤10 rows may legitimately mark every row.
 * 3. Every fallback row has a measured subclass envelope — degraded mode
 *    has no screener running to notice an unmeasured one.
 *    `liveSizingSubclassFor` would size such a row against nothing.
 * 4. No two fallback rows share a `screening_instrument` — this module's
 *    own invariant (not the spec's): two lines on one underlying would
 *    concentrate a degraded-mode session on a single name.
 * 5. No fallback row is Saxo-VERIFIED `false` (the spec's "Fallback
 *    behaviour") — an `'unverified'` row still loads; only a verified
 *    exclusion is refused.
 * 6. No fallback row is non-sterling — same silent-halt argument as rule 5,
 *    one gate over.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: six independent fallback-list rules (each documented above as its own numbered rule), each with its own throw message; merging their loops or splitting them into sub-functions would change which rule's message fires first on a multi-violation pool, which lse-etp-pool.test.ts pins.
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
