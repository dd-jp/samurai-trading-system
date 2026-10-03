import { describe, expect, it } from 'vitest';
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
      if (row.provenance.t212_source_url !== undefined) {
        expect(row.provenance.t212_source_url).toMatch(
          /^https:\/\/www\.trading212\.com\/trading-instruments\/invest\//,
        );
      }
      expect(row.provenance.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('is at least the 11 tradeable ETP lines verified for this pass, seeding a line-count universe known to exceed 25', () => {
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
  it('the checked-in pool declares a non-empty fallback subset that is not the whole pool', () => {
    const fallback = LSE_ETP_POOL.filter((row) => row.fallback_default);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.length).toBeLessThanOrEqual(FALLBACK_DEFAULT_MAX_ROWS);
    expect(fallback.length).toBeLessThan(LSE_ETP_POOL.length);
  });

  it('every fallback row has a measured subclass envelope', () => {
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
    const doubled = [
      makeRow({ lse_ticker: '3SPY', screening_instrument: 'SPY', fallback_default: true }),
      makeRow({ lse_ticker: '3USL', screening_instrument: 'SPY', fallback_default: true }),
    ];
    expect(() => assertValidPool(doubled)).toThrow(/'3SPY' and '3USL'/);
    expect(() => assertValidPool(doubled)).toThrow(/own invariant/);
  });

  it('assertValidPool rejects a fallback row whose subclass envelope was never measured', () => {
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

  it('assertValidPool rejects a fallback row that is Saxo-verified false — a fallback naming an instrument Saxo does not list', () => {
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

describe('identity distinctness is enforced, not merely observed', () => {
  it('assertValidPool rejects a caller-supplied row whose lse_ticker equals its screening_instrument, naming the row', () => {
    const collapsed = makeRow({ lse_ticker: 'SPY', screening_instrument: 'SPY' });
    expect(() => assertValidPool([...LSE_ETP_POOL, collapsed])).toThrow(/'SPY'/);
    expect(() => assertValidPool([collapsed])).toThrow(/same identity/);
  });

  it('assertValidPool treats a case-only or whitespace-only difference as the SAME identity, not two', () => {
    expect(() =>
      assertValidPool([makeRow({ lse_ticker: '3USL', screening_instrument: '3usl' })]),
    ).toThrow(/same identity/);
    expect(() =>
      assertValidPool([makeRow({ lse_ticker: '3USL', screening_instrument: ' 3USL ' })]),
    ).toThrow(/same identity/);
  });

  it('assertValidPool accepts a genuinely distinct pair even when one string contains the other', () => {
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

  it('a subclassOf map built via liveSizingSubclassFor, keyed on lse_ticker, omits the 4 unmeasured rows entirely', () => {
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
  });

  it('screening/ranking is unaffected: the full pool and its rankable-underlying count are unchanged by the sizing exclusion', () => {
    expect(LSE_ETP_POOL.length).toBe(31);
    expect(countRankableUnderlyings(LSE_ETP_POOL)).toBe(26);
  });
});

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

describe('sterling-only tradeable universe (#1220)', () => {
  it('isSterlingQuoted agrees with the shared isBookCurrency on every pool row and every pence code', () => {
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

describe('the 3LUS SPY fallback slot (#1220)', () => {
  it('holds the SPY slot on 3LUS — the sterling line, at the Uic the sibling evidence recorded', () => {
    const spyFallback = LSE_ETP_POOL.filter(
      (row) => row.fallback_default && row.screening_instrument === 'SPY',
    );
    expect(spyFallback.map((row) => row.lse_ticker)).toEqual(['3LUS']);
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
