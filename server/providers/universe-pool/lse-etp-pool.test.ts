import { describe, expect, it } from 'vitest';
import {
  ADR_0018_SUBCLASS_BRACKETS,
  resolveSubclassBracket,
  SubclassBracketUnresolvableError,
} from '../../pipeline/trader/subclass-bracket.js';
import {
  assertKnownSubclass,
  assertValidFallbackSubset,
  assertValidPool,
  buildRoutingMap,
  countRankableUnderlyings,
  FALLBACK_DEFAULT_MAX_ROWS,
  KNOWN_SUBCLASSES,
  LSE_ETP_POOL,
  type LseEtpPoolRow,
  liveSizingSubclassFor,
  resolveMiSubject,
  screeningInstrumentFor,
  UnknownSubclassError,
} from './lse-etp-pool.js';

function makeRow(overrides: Partial<LseEtpPoolRow> = {}): LseEtpPoolRow {
  return {
    lse_ticker: 'TEST',
    screening_instrument: 'TST',
    underlying: 'Test Co',
    leverage: 3,
    direction: 'long',
    subclass: 'index_etp_3x',
    currency: 'GBX',
    t212_isa: true,
    subclass_envelope_measured: true,
    // Opt in explicitly, so a future multi-row pool built from this helper does
    // not silently exercise the fallback ceiling and duplicate-underlying rules.
    fallback_default: false,
    provenance: {
      isin: 'XX0000000000',
      issuer: 'Leverage Shares',
      source_url: 'https://example.invalid/source',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/TEST.GB',
      verified_on: '2026-08-17',
    },
    ...overrides,
  };
}

describe('LSE_ETP_POOL — the checked-in pool', () => {
  it('is non-empty and every row has all nine required fields plus provenance', () => {
    expect(LSE_ETP_POOL.length).toBeGreaterThan(0);
    for (const row of LSE_ETP_POOL) {
      expect(row.lse_ticker).toBeTruthy();
      expect(row.screening_instrument).toBeTruthy();
      expect(row.underlying).toBeTruthy();
      expect(row.leverage).toBeGreaterThan(0);
      expect(['long', 'short']).toContain(row.direction);
      expect(row.subclass).toBeTruthy();
      expect(row.currency).toBeTruthy();
      expect(typeof row.t212_isa).toBe('boolean');
      expect(typeof row.subclass_envelope_measured).toBe('boolean');
      expect(typeof row.fallback_default).toBe('boolean');
      expect(row.provenance.isin).toBeTruthy();
      expect(row.provenance.issuer).toBeTruthy();
      expect(row.provenance.source_url).toMatch(/^https:\/\//);
      expect(row.provenance.t212_source_url).toMatch(
        /^https:\/\/www\.trading212\.com\/trading-instruments\/invest\//,
      );
      expect(row.provenance.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('is at least the 11 tradeable ETP lines verified for this pass, seeding a line-count universe known to exceed 25', () => {
    // A first pass of this file stopped at 6 rows and asserted
    // `toBeLessThan(25)` as a pool-count finding. That assertion encoded a
    // research-coverage artifact (currency-line doubt applied inconsistently
    // across candidate rows) as if it were a property of the universe, and
    // was wrong: re-running the same T212-instrument-page bar against the
    // dropped candidates immediately produced five more verified rows, and a
    // plain search of GraniteShares' own catalogue surfaced an 18-ticker 3x
    // single-stock line before Leverage Shares' or WisdomTree's ranges were
    // even considered. The verified-tradeable ETP-LINE count across the three
    // named issuers is materially above 25 — see the module doc's provenance
    // section. That is a line count, NOT the distinct-underlying count #707's
    // 25-name threshold is measured against (26 today — see the
    // `countRankableUnderlyings` describe block below, where that threshold
    // has its own assertion). #813 carried nineteen further rows through the
    // same per-row verification, but the file still ships a verified seed
    // rather than a claim of completeness — neither issuer's short (-3x)
    // side is represented at all — so the test asserts a floor rather than a
    // ceiling.
    expect(LSE_ETP_POOL.length).toBeGreaterThanOrEqual(11);
  });

  it('every lse_ticker is distinct — no instrument routes to two rows', () => {
    const tickers = LSE_ETP_POOL.map((row) => row.lse_ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it('is internally valid (subclass known, both identities non-empty)', () => {
    expect(() => assertValidPool(LSE_ETP_POOL)).not.toThrow();
  });
});

describe('the declared fallback subset (F4, docs/reviews/universe-path-gap-sweep-2026-09-03.md)', () => {
  // The fallback is the only thing standing between a bad screener run and a
  // fully dark session (universe-selector-spec.md, "Candidate pool", after
  // story 26 was withdrawn), so its failure mode is a *silent* one: a pool
  // that declares no fallback presents as a healthy no-trade session on the
  // one day it matters. These tests are the load-time half of that; #751's
  // provider tests own the behavioural half.

  it('the checked-in pool declares a non-empty fallback subset that is not the whole pool', () => {
    const fallback = LSE_ETP_POOL.filter((row) => row.fallback_default);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.length).toBeLessThanOrEqual(FALLBACK_DEFAULT_MAX_ROWS);
    expect(fallback.length).toBeLessThan(LSE_ETP_POOL.length);
  });

  it('every fallback row has a measured subclass envelope', () => {
    // ADR-0018 D3's bracket and D5's fraction were never measured against the
    // four #903 rows (3VT/3KOR/3KWE/3XLE). Degraded mode is the worst place
    // to discover that, so the subset is drawn from measured rows only.
    for (const row of LSE_ETP_POOL.filter((r) => r.fallback_default)) {
      expect(row.subclass_envelope_measured).toBe(true);
    }
  });

  it('no two fallback rows rank on the same screening_instrument', () => {
    const underlyings = LSE_ETP_POOL.filter((r) => r.fallback_default).map(
      (r) => r.screening_instrument,
    );
    expect(new Set(underlyings).size).toBe(underlyings.length);
  });

  it('assertValidPool rejects a pool that declares no fallback row at all', () => {
    const dark = LSE_ETP_POOL.map((row) => ({ ...row, fallback_default: false }));
    expect(() => assertValidPool(dark)).toThrow(/no fallback_default row/);
    expect(() => assertValidFallbackSubset(dark)).toThrow(/healthy no-trade session/);
  });

  it('assertValidPool rejects a pool that marks more rows than the ceiling', () => {
    const everything = LSE_ETP_POOL.map((row) => ({ ...row, fallback_default: true }));
    expect(everything.filter((r) => r.fallback_default).length).toBeGreaterThan(
      FALLBACK_DEFAULT_MAX_ROWS,
    );
    expect(() => assertValidPool(everything)).toThrow(
      new RegExp(`above the ${FALLBACK_DEFAULT_MAX_ROWS}-row ceiling`),
    );
  });

  it('assertValidPool rejects two fallback rows on one underlying, naming both lines', () => {
    // SPY, QQQ, PLTR and NVDA each carry two ETP lines; marking both is
    // doubled exposure to one name in the mode with no screener to notice.
    // This rule is the module's own, not the spec's — the throw says so.
    const doubled = [
      makeRow({ lse_ticker: '3SPY', screening_instrument: 'SPY', fallback_default: true }),
      makeRow({ lse_ticker: '3USL', screening_instrument: 'SPY', fallback_default: true }),
    ];
    expect(() => assertValidPool(doubled)).toThrow(/'3SPY' and '3USL'/);
    expect(() => assertValidPool(doubled)).toThrow(/own invariant/);
  });

  it('assertValidPool rejects a fallback row whose subclass envelope was never measured', () => {
    // #903's four widened rows are excluded from liveSizingSubclassFor, so a
    // fallback holding one would size against nothing — in the one mode with
    // no screener running to notice.
    const widened = [
      makeRow({
        lse_ticker: '3VT',
        screening_instrument: 'VT',
        fallback_default: true,
        subclass_envelope_measured: false,
      }),
    ];
    expect(() => assertValidPool(widened)).toThrow(/'3VT'/);
    expect(() => assertValidPool(widened)).toThrow(/never measured/);
  });

  it('accepts two rows on one underlying when only one of them is the fallback', () => {
    expect(() =>
      assertValidPool([
        makeRow({ lse_ticker: '3SPY', screening_instrument: 'SPY', fallback_default: true }),
        makeRow({ lse_ticker: '3USL', screening_instrument: 'SPY', fallback_default: false }),
      ]),
    ).not.toThrow();
  });
});

describe('routing binds on lse_ticker only', () => {
  it('every routing key is a lse_ticker, and no screening_instrument leaks into it', () => {
    const pool = [
      makeRow({ lse_ticker: '3USL', screening_instrument: 'SPY' }),
      makeRow({
        lse_ticker: '3LTS',
        screening_instrument: 'TSLA',
        subclass: 'single_stock_etp_3x',
      }),
    ];
    const routing = buildRoutingMap(pool);

    expect(routing.get('3USL')).toBe('stocks');
    expect(routing.get('3LTS')).toBe('stocks');
    expect(routing.has('SPY')).toBe(false);
    expect(routing.has('TSLA')).toBe(false);
    expect(routing.size).toBe(pool.length);
  });

  it('the real checked-in pool never lets a screening_instrument double as a routing key', () => {
    const routing = buildRoutingMap(LSE_ETP_POOL);
    // No skip-guard for `screening_instrument === lse_ticker`: `assertValidPool`
    // now refuses such a row outright (#807), so a `continue` here would be a
    // test branch that reads as coverage and covers nothing.
    for (const row of LSE_ETP_POOL) {
      expect(routing.has(row.screening_instrument)).toBe(false);
    }
  });
});

describe('subclass validation fails loud', () => {
  it('accepts every recorded subclass', () => {
    for (const subclass of KNOWN_SUBCLASSES) {
      expect(() => assertKnownSubclass(makeRow({ subclass }))).not.toThrow();
    }
  });

  it('throws UnknownSubclassError on an unrecognised subclass rather than defaulting', () => {
    const row = makeRow({ subclass: 'index_etp_3x' as LseEtpPoolRow['subclass'] });
    const bad = { ...row, subclass: 'quadruple_leveraged_etp' } as unknown as LseEtpPoolRow;
    expect(() => assertKnownSubclass(bad)).toThrow(UnknownSubclassError);
  });

  it('excludes crypto — this pool is LSE equities only', () => {
    expect(KNOWN_SUBCLASSES).not.toContain('crypto');
    const cryptoRow = makeRow({ subclass: 'crypto' });
    expect(() => assertKnownSubclass(cryptoRow)).toThrow(UnknownSubclassError);
  });

  it('assertValidPool rejects a pool containing one bad row', () => {
    const bad = {
      ...makeRow(),
      subclass: 'not_a_real_subclass',
    } as unknown as LseEtpPoolRow;
    expect(() => assertValidPool([...LSE_ETP_POOL, bad])).toThrow(UnknownSubclassError);
  });
});

// The checked-in pool's distinctness is asserted above ('every lse_ticker is
// distinct', and the routing block). These cover the other half — a pool a
// CALLER supplies, which #751 is the first ticket to make possible (#807).
describe('identity distinctness is enforced, not merely observed', () => {
  it('assertValidPool rejects a caller-supplied row whose lse_ticker equals its screening_instrument, naming the row', () => {
    const collapsed = makeRow({ lse_ticker: 'SPY', screening_instrument: 'SPY' });
    expect(() => assertValidPool([...LSE_ETP_POOL, collapsed])).toThrow(/'SPY'/);
    expect(() => assertValidPool([collapsed])).toThrow(/same identity/);
  });

  it('assertValidPool treats a case-only or whitespace-only difference as the SAME identity, not two', () => {
    // '3USL' vs '3usl' is a transcription of one identifier, never two
    // instruments on two venues — the exact confusion the named field pair
    // refuses. Case-sensitive validation would wave this through.
    expect(() =>
      assertValidPool([makeRow({ lse_ticker: '3USL', screening_instrument: '3usl' })]),
    ).toThrow(/same identity/);
    expect(() =>
      assertValidPool([makeRow({ lse_ticker: '3USL', screening_instrument: ' 3USL ' })]),
    ).toThrow(/same identity/);
  });

  it('assertValidPool accepts a genuinely distinct pair even when one string contains the other', () => {
    // The checked-in pool holds 3SPY/SPY and 3QQQ/QQQ: a distinct ETP line and
    // its distinct US underlying. The check is equality, never containment.
    expect(() =>
      assertValidPool([
        makeRow({ lse_ticker: '3SPY', screening_instrument: 'SPY', fallback_default: true }),
      ]),
    ).not.toThrow();
  });
});

describe('t212_isa is populated for every row', () => {
  it('is a boolean, not undefined, on every row', () => {
    for (const row of LSE_ETP_POOL) {
      expect(row.t212_isa === true || row.t212_isa === false).toBe(true);
    }
  });
});

describe('countRankableUnderlyings — the count #707 consumes, not #751', () => {
  it('returns 26 for the checked-in pool: SPY, QQQ, PLTR, and NVDA each carry two ETP lines', () => {
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBe(26);
  });

  it('clears the >= 25 distinct-underlying threshold #707 ranks against (#813)', () => {
    // The named acceptance criterion of #813, asserted rather than observed.
    // This is the gate `docs/specs/universe-selector-spec.md` ("Candidate
    // pool") sets for where the monthly-quintile ranking earns its keep: at
    // 7 underlyings the quintiles held 1-2 names each and the statistic was
    // undefined rather than merely weak. It is deliberately a floor, not an
    // equality — rows may be added freely, but removing enough of them to
    // drop back under 25 must fail here rather than silently re-block #707.
    // Note this counts UNDERLYINGS, not rows: 30 rows would not satisfy it
    // if they collapsed onto fewer than 25 distinct screening instruments.
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBeGreaterThanOrEqual(25);
  });

  it('is strictly less than the row count, since some underlyings have more than one issuer line', () => {
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBeLessThan(LSE_ETP_POOL.length);
  });

  it('the pool has exactly 30 tradeable ETP lines — the count #751 consumes', () => {
    expect(LSE_ETP_POOL.length).toBe(30);
  });

  it('defaults to the checked-in pool when called with no argument', () => {
    expect(countRankableUnderlyings()).toBe(26);
  });

  it('counts distinct screening_instrument values, not rows, on an arbitrary pool', () => {
    const pool = [
      makeRow({ lse_ticker: 'A1', screening_instrument: 'SPY' }),
      makeRow({ lse_ticker: 'A2', screening_instrument: 'SPY' }),
      makeRow({ lse_ticker: 'A3', screening_instrument: 'QQQ' }),
    ];
    expect(countRankableUnderlyings(pool)).toBe(2);
  });
});

// #903: index_etp_3x was widened by #813 to include four underlyings nothing
// like SPY (3VT/VT all-world, 3KOR/EWY South Korea, 3KWE/KWEB China internet,
// 3XLE/XLE US energy sector), but ADR-0018's D3/D5 numbers for index_etp_3x
// were measured with SPY standing in for the whole subclass. These tests
// prove — against the REAL `resolveSubclassBracket`, not a re-implementation
// — that a live-sizing consumer built the way #751 must build it cannot size
// those four rows off the SPY-measured envelope.
describe('liveSizingSubclassFor — #903 excludes the four unmeasured index_etp_3x rows from live sizing', () => {
  const UNMEASURED_TICKERS = ['3VT', '3KOR', '3KWE', '3XLE'];

  it('flags exactly the four widened rows as unmeasured, and every other row as measured', () => {
    const unmeasured = LSE_ETP_POOL.filter((row) => !row.subclass_envelope_measured).map(
      (row) => row.lse_ticker,
    );
    expect(unmeasured.sort()).toEqual([...UNMEASURED_TICKERS].sort());

    const measured = LSE_ETP_POOL.filter((row) => row.subclass_envelope_measured);
    expect(measured.length).toBe(LSE_ETP_POOL.length - 4);
  });

  it("returns undefined for exactly the 4 flagged rows, and the row's real subclass for the other 26", () => {
    for (const row of LSE_ETP_POOL) {
      if (UNMEASURED_TICKERS.includes(row.lse_ticker)) {
        expect(liveSizingSubclassFor(row)).toBeUndefined();
      } else {
        expect(liveSizingSubclassFor(row)).toBe(row.subclass);
      }
    }
  });

  it('a subclassOf map built the way #751 must build it (via liveSizingSubclassFor, keyed on lse_ticker — the same key buildRoutingMap and UniverseInstrument.asset use) omits the 4 unmeasured rows entirely', () => {
    const subclassOf = Object.fromEntries(
      LSE_ETP_POOL.flatMap((row) => {
        const subclass = liveSizingSubclassFor(row);
        return subclass === undefined ? [] : [[row.lse_ticker, subclass] as const];
      }),
    );

    for (const ticker of UNMEASURED_TICKERS) {
      expect(Object.hasOwn(subclassOf, ticker)).toBe(false);
    }
    expect(Object.keys(subclassOf).length).toBe(LSE_ETP_POOL.length - 4);

    // The proof that matters: feed this map into the REAL Trader-side
    // resolver and confirm each of the four unmeasured rows fails loud
    // instead of being sized off the SPY-measured index_etp_3x bracket.
    for (const ticker of UNMEASURED_TICKERS) {
      expect(() => resolveSubclassBracket(ticker, subclassOf, ADR_0018_SUBCLASS_BRACKETS)).toThrow(
        SubclassBracketUnresolvableError,
      );
    }

    // The guard must not over-exclude: a measured index_etp_3x row (3USL)
    // still resolves successfully to the SPY-measured bracket.
    const resolved = resolveSubclassBracket('3USL', subclassOf, ADR_0018_SUBCLASS_BRACKETS);
    expect(resolved).toBe(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x);

    // And a measured single_stock_etp_3x row resolves to its own bracket too.
    const resolvedSingleStock = resolveSubclassBracket(
      '3LTS',
      subclassOf,
      ADR_0018_SUBCLASS_BRACKETS,
    );
    expect(resolvedSingleStock).toBe(ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x);
  });

  it('screening/ranking is unaffected: the full pool and its rankable-underlying count are unchanged by the sizing exclusion', () => {
    // The guard is sizing-only. #707's ranking precondition and #751's
    // tradeable-line count must not silently shrink because of it.
    expect(LSE_ETP_POOL.length).toBe(30);
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBe(26);
  });
});

// #914/#960: the read-side resolution step both the fundamental analyst's
// fix and any future MI producer need — resolve an LSE wrapper to the US
// underlying MI is actually keyed on, falling back to the instrument itself
// for anything not in the pool.
describe('resolveMiSubject — the MI-wide retrieval-subject resolution (#914/#960)', () => {
  it('resolves a real LSE pool row to its screening_instrument, matching screeningInstrumentFor directly', () => {
    expect(resolveMiSubject('3USL')).toBe('SPY');
    expect(screeningInstrumentFor('3USL')).toBe('SPY');

    expect(resolveMiSubject('NVD3')).toBe('NVDA');
    expect(screeningInstrumentFor('NVD3')).toBe('NVDA');
  });

  it('falls back to the instrument itself for a non-pool name — every instrument in DEFAULT_UNIVERSE today', () => {
    expect(resolveMiSubject('AAPL')).toBe('AAPL');
    expect(resolveMiSubject('QQQ')).toBe('QQQ');
    expect(resolveMiSubject('TSLA')).toBe('TSLA');
    expect(resolveMiSubject('BTC-USD')).toBe('BTC-USD');
  });
});
