import { describe, expect, it } from 'vitest';
import {
  ADR_0018_SUBCLASS_BRACKETS,
  resolveSubclassBracket,
  SubclassBracketUnresolvableError,
} from '../../pipeline/trader/subclass-bracket.js';
import { isBookCurrency } from '../../shared/index.js';
import {
  assertKnownSubclass,
  assertValidFallbackSubset,
  assertValidPool,
  buildRoutingMap,
  countRankableUnderlyings,
  FALLBACK_DEFAULT_MAX_ROWS,
  gateAdmits,
  isSterlingQuoted,
  KNOWN_SUBCLASSES,
  LSE_ETP_POOL,
  type LseEtpPoolRow,
  liquidityGateStatus,
  liveSizingSubclassFor,
  resolveMiSubject,
  screeningInstrumentFor,
  tradeableUniverse,
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
    saxo_tradeable: 'unverified',
    subclass_envelope_measured: true,
    // Opt in explicitly, so a future multi-row pool built from this helper does
    // not silently exercise the fallback ceiling and duplicate-underlying rules
    fallback_default: false,
    provenance: {
      isin: 'XX0000000000',
      issuer: 'Leverage Shares',
      source_url: 'https://example.invalid/source',
      t212_source_url: 'https://www.trading212.com/trading-instruments/invest/TEST.GB',
      verified_on: '2026-08-17',
      saxo: { verified_on: '2026-09-05', gateway: 'sim', line: null },
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
      expect([true, false, 'unverified']).toContain(row.saxo_tradeable);
      expect(typeof row.subclass_envelope_measured).toBe('boolean');
      expect(typeof row.fallback_default).toBe('boolean');
      expect(row.provenance.isin).toBeTruthy();
      expect(row.provenance.issuer).toBeTruthy();
      expect(row.provenance.source_url).toMatch(/^https:\/\//);
      // Optional since #1220: a row added after the 2026-08-30 venue change
      // (3LUS) has no T212 evidence to cite, and inventing a URL in a file
      // whose whole discipline is provenance would be worse than its absence
      if (row.provenance.t212_source_url !== undefined) {
        expect(row.provenance.t212_source_url).toMatch(
          /^https:\/\/www\.trading212\.com\/trading-instruments\/invest\//,
        );
      }
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
    // ceiling
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
  // provider tests own the behavioural half

  it('the checked-in pool declares a non-empty fallback subset that is not the whole pool', () => {
    const fallback = LSE_ETP_POOL.filter((row) => row.fallback_default);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.length).toBeLessThanOrEqual(FALLBACK_DEFAULT_MAX_ROWS);
    expect(fallback.length).toBeLessThan(LSE_ETP_POOL.length);
  });

  it('every fallback row has a measured subclass envelope', () => {
    // ADR-0018 D3's bracket and D5's fraction were never measured against the
    // four #903 rows (3VT/3KOR/3KWE/3XLE). Degraded mode is the worst place
    // to discover that, so the subset is drawn from measured rows only
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
    // doubled exposure to one name in the mode with no screener to notice
    // This rule is the module's own, not the spec's — the throw says so
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
    // no screener running to notice
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

  // Rule 5 (#1100 review): docs/specs/universe-selector-spec.md "Fallback
  // behaviour" requires no fallback row be one gateAdmits excludes — a
  // Saxo-VERIFIED saxo_tradeable: false. Proven on a synthetic fixture so the
  // rule is pinned independently of which checked-in rows happen to be false
  it('assertValidPool rejects a fallback row that is Saxo-verified false — a fallback naming an instrument Saxo does not list', () => {
    // A second, non-fallback row carries saxo_tradeable: true so gateAdmits
    // genuinely disagrees across the pool (armed) — proving rule 5 fires on
    // its own, not riding on the pool-wide vacuous check the single excluded
    // fallback row would also trip alone
    const excluded = [
      makeRow({
        lse_ticker: '3EXC',
        screening_instrument: 'EXC',
        fallback_default: true,
        saxo_tradeable: false,
      }),
      makeRow({ lse_ticker: '3OTH', screening_instrument: 'OTH', saxo_tradeable: true }),
    ];
    expect(() => assertValidPool(excluded)).toThrow(/'3EXC'/);
    expect(() => assertValidPool(excluded)).toThrow(/saxo_tradeable/);
  });

  it('accepts a fallback row whose saxo_tradeable is unverified — the unarmed gate does not exclude it', () => {
    expect(() =>
      assertValidPool([
        makeRow({
          lse_ticker: '3OK',
          screening_instrument: 'OK',
          fallback_default: true,
          saxo_tradeable: 'unverified',
        }),
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
    // test branch that reads as coverage and covers nothing
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
// CALLER supplies, which #751 is the first ticket to make possible (#807)
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

// #1054 Part 1: `saxo_tradeable` is the field docs/specs/universe-selector-spec.md
// story 16 / #750 AC7 name as the liquidity gate — `t212_isa` above answers a
// different, no-longer-live question (does Trading 212 list it) and must
// never be read as the gate. #1032 item 3 captured Saxo's own instrument
// list (`GET /ref/v1/instruments`, SIM gateway, 2026-09-05) row by row, so
// every value below is sourced, and the gate is ARMED
describe('saxo_tradeable — the field the liquidity gate actually reads (#1054 Part 1, #1032 item 3)', () => {
  it('carries Saxo-sourced evidence on every checked-in row, and no row is left unverified', () => {
    for (const row of LSE_ETP_POOL) {
      expect(row.saxo_tradeable).not.toBe('unverified');
      expect(row.provenance.saxo.verified_on).toBe('2026-09-05');
      expect(row.provenance.saxo.gateway).toBe('sim');
    }
  });

  it("is true exactly when Saxo lists the row's OWN ticker line on LSE_ETF", () => {
    for (const row of LSE_ETP_POOL) {
      const { line } = row.provenance.saxo;
      expect(row.saxo_tradeable).toBe(line !== null);
      if (line !== null) {
        expect(line.symbol).toBe(`${row.lse_ticker}:xlon`);
        expect(line.exchange_id).toBe('LSE_ETF');
        expect(Number.isInteger(line.uic) && line.uic > 0).toBe(true);
        // Saxo quotes the GBX lines as GBP; the row's own currency field is
        // the listing-line currency, which is the same claim in that case
        expect(line.currency).toBe(row.currency === 'GBX' ? 'GBP' : row.currency);
      }
    }
  });

  it('records a sibling line only under a different ticker on the same ISIN', () => {
    for (const row of LSE_ETP_POOL) {
      const { line, sibling_line } = row.provenance.saxo;
      if (sibling_line === undefined) continue;
      expect(sibling_line.symbol).not.toBe(`${row.lse_ticker}:xlon`);
      expect(sibling_line.exchange_id).toBe('LSE_ETF');
      if (line !== null) expect(sibling_line.uic).not.toBe(line.uic);
    }
  });

  it('pins the 2026-09-05 SIM capture: 14 own-line hits, 7 sibling-only ISINs, 10 absent', () => {
    const own = LSE_ETP_POOL.filter((row) => row.provenance.saxo.line !== null);
    const siblingOnly = LSE_ETP_POOL.filter(
      (row) => row.provenance.saxo.line === null && row.provenance.saxo.sibling_line !== undefined,
    );
    const absent = LSE_ETP_POOL.filter(
      (row) => row.provenance.saxo.line === null && row.provenance.saxo.sibling_line === undefined,
    );
    expect(own.map((row) => row.lse_ticker).sort()).toEqual(
      [
        '3USL',
        '3LUS',
        'LQQ3',
        '3LTS',
        'NVD3',
        '3LNV',
        'MST3',
        '3LPA',
        'PLT3',
        '3LAL',
        'LCO3',
        '3LSQ',
        '3KOR',
        '3KWE',
      ].sort(),
    );
    expect(siblingOnly.map((row) => row.lse_ticker).sort()).toEqual(
      ['3LME', 'LAM3', 'LPP3', '3LNP', 'LAA3', '3LIP', '3FB'].sort(),
    );
    expect(absent.map((row) => row.lse_ticker).sort()).toEqual(
      ['3SPY', '3AAP', '3QQQ', '3LMO', '3AMZ', '3UBR', '3RAC', '3ARM', '3VT', '3XLE'].sort(),
    );
  });

  it('liquidityGateStatus reports the checked-in pool as armed', () => {
    const status = liquidityGateStatus(LSE_ETP_POOL);
    expect(status.state).toBe('armed');
  });

  it('every fallback row is Saxo-verified true, not merely not-verified-false', () => {
    for (const row of LSE_ETP_POOL.filter((r) => r.fallback_default)) {
      expect(row.saxo_tradeable).toBe(true);
    }
  });

  it('liquidityGateStatus reports armed when a verified true row and a verified false row both admit differently', () => {
    const pool = [
      makeRow({ lse_ticker: 'A1', screening_instrument: 'AAA', saxo_tradeable: true }),
      makeRow({ lse_ticker: 'A2', screening_instrument: 'BBB', saxo_tradeable: false }),
    ];
    expect(liquidityGateStatus(pool).state).toBe('armed');
  });

  it('liquidityGateStatus treats an empty pool as unarmed rather than throwing', () => {
    expect(liquidityGateStatus([]).state).toBe('unarmed');
  });

  it('defaults to the checked-in pool when called with no argument', () => {
    expect(liquidityGateStatus().state).toBe('armed');
  });

  describe('gateAdmits — the row-level predicate the pool-level status is built from', () => {
    it('admits an unverified row: the unarmed gate is pass-through, not a silent exclusion', () => {
      expect(gateAdmits(makeRow({ saxo_tradeable: 'unverified' }))).toBe(true);
    });

    it('admits a Saxo-verified true row', () => {
      expect(gateAdmits(makeRow({ saxo_tradeable: true }))).toBe(true);
    });

    it('excludes only a Saxo-verified false row', () => {
      expect(gateAdmits(makeRow({ saxo_tradeable: false }))).toBe(false);
    });
  });

  it('a mix of unverified and verified-true rows is vacuous (admits everything), not armed — gateAdmits agrees on every row even though saxo_tradeable itself is not constant', () => {
    // This is the case a `saxo_tradeable`-distinctness check gets wrong:
    // the raw field takes two different values across these rows, but
    // admit-unless-false admits both of them, so the gate excludes nothing
    const pool = [
      makeRow({ lse_ticker: 'A1', screening_instrument: 'AAA', saxo_tradeable: 'unverified' }),
      makeRow({ lse_ticker: 'A2', screening_instrument: 'BBB', saxo_tradeable: true }),
    ];
    const status = liquidityGateStatus(pool);
    expect(status.state).toBe('vacuous');
    expect(status.state === 'vacuous' && status.admits).toBe(true);
  });

  it('a mix of unverified and verified-false rows is armed — gateAdmits genuinely disagrees', () => {
    const pool = [
      makeRow({ lse_ticker: 'A1', screening_instrument: 'AAA', saxo_tradeable: 'unverified' }),
      makeRow({ lse_ticker: 'A2', screening_instrument: 'BBB', saxo_tradeable: false }),
    ];
    expect(liquidityGateStatus(pool).state).toBe('armed');
  });
});

// AC: "A test fails if the liquidity gate is constant across the whole pool"
// (no-op gate is a build break). The unarmed state (constant 'unverified') is
// the one exception — see the module doc's `saxo_tradeable` field comment for
// why that state is distinct from a constant verified value, which is a bug
describe('assertValidPool fails loud when the liquidity gate is constant (#1054)', () => {
  it('does not throw on the checked-in pool, whose gate is constant "unverified" — the explicit unarmed state', () => {
    expect(() => assertValidPool(LSE_ETP_POOL)).not.toThrow();
  });

  it('throws when saxo_tradeable is true on every row — a gate that excludes nothing is a bug, not configuration', () => {
    const allTrue = LSE_ETP_POOL.map((row) => ({ ...row, saxo_tradeable: true as const }));
    expect(() => assertValidPool(allTrue)).toThrow(/saxo_tradeable/);
    expect(() => assertValidPool(allTrue)).toThrow(/constant/);
  });

  it('throws when saxo_tradeable is false on every row — a gate that excludes everything is equally broken', () => {
    const allFalse = LSE_ETP_POOL.map((row) => ({ ...row, saxo_tradeable: false as const }));
    expect(() => assertValidPool(allFalse)).toThrow(/saxo_tradeable/);
    expect(() => assertValidPool(allFalse)).toThrow(/constant/);
  });

  it('does not throw when saxo_tradeable discriminates between rows', () => {
    const mixed = [
      makeRow({
        lse_ticker: 'A1',
        screening_instrument: 'AAA',
        saxo_tradeable: true,
        fallback_default: true,
      }),
      makeRow({ lse_ticker: 'A2', screening_instrument: 'BBB', saxo_tradeable: false }),
    ];
    expect(() => assertValidPool(mixed)).not.toThrow();
  });

  it('does not throw on a single-row pool whose lone value is "unverified"', () => {
    expect(() => assertValidPool([makeRow({ fallback_default: true })])).not.toThrow();
  });
});

describe('countRankableUnderlyings — the count #707 consumes, not #751', () => {
  it('returns 26 for the checked-in pool: QQQ, PLTR and NVDA each carry two ETP lines, SPY three', () => {
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBe(26);
  });

  it('clears the >= 25 distinct-underlying threshold #707 ranks against (#813)', () => {
    // The named acceptance criterion of #813, asserted rather than observed
    // This is the gate `docs/specs/universe-selector-spec.md` ("Candidate
    // pool") sets for where the monthly-quintile ranking earns its keep: at
    // 7 underlyings the quintiles held 1-2 names each and the statistic was
    // undefined rather than merely weak. It is deliberately a floor, not an
    // equality — rows may be added freely, but removing enough of them to
    // drop back under 25 must fail here rather than silently re-block #707
    // Note this counts UNDERLYINGS, not rows: 30 rows would not satisfy it
    // if they collapsed onto fewer than 25 distinct screening instruments
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBeGreaterThanOrEqual(25);
  });

  it('is strictly less than the row count, since some underlyings have more than one issuer line', () => {
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBeLessThan(LSE_ETP_POOL.length);
  });

  it('the pool has exactly 31 tradeable ETP lines — the count #751 consumes', () => {
    expect(LSE_ETP_POOL.length).toBe(31);
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
// those four rows off the SPY-measured envelope
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
    // instead of being sized off the SPY-measured index_etp_3x bracket
    for (const ticker of UNMEASURED_TICKERS) {
      expect(() => resolveSubclassBracket(ticker, subclassOf, ADR_0018_SUBCLASS_BRACKETS)).toThrow(
        SubclassBracketUnresolvableError,
      );
    }

    // The guard must not over-exclude: a measured index_etp_3x row (3USL)
    // still resolves successfully to the SPY-measured bracket
    const resolved = resolveSubclassBracket('3USL', subclassOf, ADR_0018_SUBCLASS_BRACKETS);
    expect(resolved).toBe(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x);

    // And a measured single_stock_etp_3x row resolves to its own bracket too
    const resolvedSingleStock = resolveSubclassBracket(
      '3LTS',
      subclassOf,
      ADR_0018_SUBCLASS_BRACKETS,
    );
    expect(resolvedSingleStock).toBe(ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x);
  });

  it('screening/ranking is unaffected: the full pool and its rankable-underlying count are unchanged by the sizing exclusion', () => {
    // The guard is sizing-only. #707's ranking precondition and #751's
    // tradeable-line count must not silently shrink because of it
    expect(LSE_ETP_POOL.length).toBe(31);
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBe(26);
  });
});

// #914/#960: the read-side resolution step both the fundamental analyst's
// fix and any future MI producer need — resolve an LSE wrapper to the US
// underlying MI is actually keyed on, falling back to the instrument itself
// for anything not in the pool
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

// #1220 (David's ruling, 2026-09-08: sterling-only for the live ramp). The
// pool's non-sterling rows are EXCLUDED from the tradeable universe, not
// deprioritised — an unmodelled GBP/USD leg on a GBP book is a cost the
// system cannot price, and #1310 owns the width consequence
describe('sterling-only tradeable universe (#1220)', () => {
  it('isSterlingQuoted agrees with the shared isBookCurrency on every pool row and every pence code', () => {
    // #1465: `isSterlingQuoted` now delegates to `isBookCurrency` directly, so
    // this is no longer pinning two hand-kept lists in agreement (#1100's
    // failure mode) — it guards against a future edit making `isSterlingQuoted`
    // stop delegating and drift again
    for (const row of LSE_ETP_POOL) {
      expect(isSterlingQuoted(row)).toBe(isBookCurrency(row.currency));
    }
    for (const code of ['GBX', 'gbx', 'GBp', 'p', 'GBP', 'gbp']) {
      expect(isSterlingQuoted(makeRow({ currency: code }))).toBe(true);
      expect(isBookCurrency(code)).toBe(true);
    }
    for (const code of ['USD', 'EUR', 'usd', 'CHF']) {
      expect(isSterlingQuoted(makeRow({ currency: code }))).toBe(false);
    }
  });

  it('tradeableUniverse excludes every USD and EUR row and keeps every GBX/GBP row the gate admits', () => {
    const tradeable = tradeableUniverse(LSE_ETP_POOL);
    for (const row of tradeable) {
      expect(isSterlingQuoted(row)).toBe(true);
      expect(gateAdmits(row)).toBe(true);
    }
    for (const row of LSE_ETP_POOL.filter((r) => !isSterlingQuoted(r))) {
      expect(tradeable).not.toContain(row);
    }
    // 3USL is the ruling's own worked example: Saxo-listed, envelope-measured,
    // and still out, because it is a USD line
    expect(tradeable.map((row) => row.lse_ticker)).not.toContain('3USL');
  });

  it('applies BOTH gates: a sterling row Saxo is verified not to list is still out', () => {
    const pool = [
      makeRow({
        lse_ticker: 'GBX1',
        screening_instrument: 'AAA',
        currency: 'GBX',
        saxo_tradeable: true,
      }),
      makeRow({
        lse_ticker: 'GBX2',
        screening_instrument: 'BBB',
        currency: 'GBX',
        saxo_tradeable: false,
      }),
      makeRow({
        lse_ticker: 'USD1',
        screening_instrument: 'CCC',
        currency: 'USD',
        saxo_tradeable: true,
      }),
    ];
    expect(tradeableUniverse(pool).map((row) => row.lse_ticker)).toEqual(['GBX1']);
  });

  it("the checked-in pool's tradeable universe is the five sterling Saxo-listed lines — the #1310 width problem, stated", () => {
    expect(
      tradeableUniverse()
        .map((row) => row.lse_ticker)
        .sort(),
    ).toEqual(['3KOR', '3KWE', '3LUS', 'LCO3', 'LQQ3'].sort());
  });

  it('assertValidPool rejects a non-sterling fallback row, naming the row and its currency', () => {
    // Rule 6. A fallback row the tradeable universe excludes is the silent
    // halt wearing the fallback's name — the same argument rule 5 makes for
    // the liquidity gate, one gate over
    const usdFallback = [
      makeRow({
        lse_ticker: '3USD',
        screening_instrument: 'AAA',
        currency: 'USD',
        saxo_tradeable: true,
        fallback_default: true,
      }),
      makeRow({ lse_ticker: '3OTH', screening_instrument: 'BBB', saxo_tradeable: false }),
    ];
    expect(() => assertValidPool(usdFallback)).toThrow(/'3USD'/);
    expect(() => assertValidPool(usdFallback)).toThrow(/'USD'/);
    expect(() => assertValidFallbackSubset(usdFallback)).toThrow(/sterling/);
  });

  it('accepts a GBX and a GBP fallback row — both are book currency, GBX by pence scaling (#1302)', () => {
    expect(() =>
      assertValidPool([
        makeRow({
          lse_ticker: 'GBX1',
          screening_instrument: 'AAA',
          currency: 'GBX',
          fallback_default: true,
        }),
        makeRow({
          lse_ticker: 'GBP1',
          screening_instrument: 'BBB',
          currency: 'GBP',
          fallback_default: true,
        }),
      ]),
    ).not.toThrow();
  });
});

// #1220 (b): the SPY fallback slot moves off 3USL (USD) onto 3LUS:xlon, the
// GBP line of the same ISIN Saxo already listed in the 2026-09-05 capture as
// 3USL's `sibling_line`
describe('the 3LUS SPY fallback slot (#1220)', () => {
  it('holds the SPY slot on 3LUS — the sterling line, at the Uic the sibling evidence recorded', () => {
    const spyFallback = LSE_ETP_POOL.filter(
      (row) => row.fallback_default && row.screening_instrument === 'SPY',
    );
    expect(spyFallback.map((row) => row.lse_ticker)).toEqual(['3LUS']);
    // GBX per the justETF listing table 3USL's own note cites; Saxo's search
    // endpoint reports GBP for it because it carries no quote unit
    expect(spyFallback[0]?.currency).toBe('GBX');
    expect(spyFallback[0]?.provenance.saxo.line?.currency).toBe('GBP');
    expect(spyFallback[0]?.provenance.saxo.line?.symbol).toBe('3LUS:xlon');
    expect(spyFallback[0]?.provenance.saxo.line?.uic).toBe(29049628);
    expect(spyFallback[0]?.provenance.isin).toBe('IE00B7Y34M31');
  });

  it('keeps 3USL as a pool row — the slot moved, the line was not deleted or re-keyed', () => {
    const usl = LSE_ETP_POOL.find((row) => row.lse_ticker === '3USL');
    expect(usl).toBeDefined();
    expect(usl?.fallback_default).toBe(false);
    expect(usl?.currency).toBe('USD');
  });

  it("leaves exactly two fallback rows, below the spec's 5-10 sizing guidance — the #1310 width problem", () => {
    const fallback = LSE_ETP_POOL.filter((row) => row.fallback_default).map(
      (row) => row.lse_ticker,
    );
    expect(fallback.sort()).toEqual(['3LUS', 'LQQ3'].sort());
  });
});
