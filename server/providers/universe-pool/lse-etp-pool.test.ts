import { describe, expect, it } from 'vitest';
import {
  assertKnownSubclass,
  assertValidPool,
  buildRoutingMap,
  KNOWN_SUBCLASSES,
  LSE_ETP_POOL,
  type LseEtpPoolRow,
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
  it('is non-empty and every row has all eight required fields plus provenance', () => {
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
      expect(row.provenance.isin).toBeTruthy();
      expect(row.provenance.issuer).toBeTruthy();
      expect(row.provenance.source_url).toMatch(/^https:\/\//);
      expect(row.provenance.t212_source_url).toMatch(
        /^https:\/\/www\.trading212\.com\/trading-instruments\/invest\//,
      );
      expect(row.provenance.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('is at least the 11 rows verified for this pass, seeding a universe known to exceed 25', () => {
    // A first pass of this file stopped at 6 rows and asserted
    // `toBeLessThan(25)` as a pool-count finding. That assertion encoded a
    // research-coverage artifact (currency-line doubt applied inconsistently
    // across candidate rows) as if it were a property of the universe, and
    // was wrong: re-running the same T212-instrument-page bar against the
    // dropped candidates immediately produced five more verified rows, and a
    // plain search of GraniteShares' own catalogue surfaced an 18-ticker 3x
    // single-stock line before Leverage Shares' or WisdomTree's ranges were
    // even considered. The verified-tradeable universe across the three named
    // issuers is materially above 25 — see the module doc's provenance
    // section. This file ships 11 fully-verified rows as a seed, not a claim
    // of completeness, so the test asserts a floor rather than a ceiling.
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
      if (row.screening_instrument === row.lse_ticker) continue;
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

describe('t212_isa is populated for every row', () => {
  it('is a boolean, not undefined, on every row', () => {
    for (const row of LSE_ETP_POOL) {
      expect(row.t212_isa === true || row.t212_isa === false).toBe(true);
    }
  });
});
