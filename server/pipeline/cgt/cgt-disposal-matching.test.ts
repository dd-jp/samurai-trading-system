import {
  ANNUAL_EXEMPT_AMOUNT_GBP,
  ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR,
  type CgtFillLeg,
  cgtReportForTaxYear,
  disposalStillInThirtyDayWindow,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  matchDisposals,
  ukTaxYearBounds,
  ukTaxYearLabel,
  unconvertedCgtFillsInTaxYear,
} from './cgt-disposal-matching.js';

function leg(overrides: Partial<CgtFillLeg> & Pick<CgtFillLeg, 'kind' | 'date'>): CgtFillLeg {
  return {
    instrument: 'LSE:TEST',
    quantity: 10,
    grossAmount: 1000,
    charges: 1,
    idempotency_key: 'key-1',
    broker_fill_id: 'fill-1',
    ...overrides,
  };
}

describe('matchDisposals — same-day rule (CG51560)', () => {
  it('matches a same-day round trip as one disposal, cost/proceeds net of both legs charges', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-06-02T08:05:00Z'),
        grossAmount: 1000,
        charges: 1,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T14:00:00Z'),
        grossAmount: 1200,
        charges: 2,
      }),
    ];

    const [matched] = matchDisposals(fills);

    expect(matched.rule).toBe('same-day');
    expect(matched.quantity).toBe(10);
    expect(matched.proceeds).toBe(1198);
    expect(matched.allowableCost).toBe(1001);
    expect(matched.gain).toBe(197);
  });

  it('pools multiple same-day fills into one averaged same-day match before falling through', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-06-02T08:00:00Z'),
        quantity: 5,
        grossAmount: 500,
        charges: 0.5,
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-06-02T08:10:00Z'),
        quantity: 5,
        grossAmount: 520,
        charges: 0.5,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T15:00:00Z'),
        quantity: 10,
        grossAmount: 1100,
        charges: 1,
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('same-day');
    expect(matched[0].quantity).toBe(10);
    expect(matched[0].allowableCost).toBe(1021);
  });
});

describe('matchDisposals — 30-day / bed-and-breakfast rule (CG51560/CG51570)', () => {
  it('matches a disposal against an acquisition within the following 30 days, ahead of the S104 pool', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-10T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T10:00:00Z'),
        quantity: 10,
        grossAmount: 1200,
        charges: 2,
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-06-12T09:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 1,
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('30-day');
    expect(matched[0].allowableCost).toBe(901);
    expect(matched[0].proceeds).toBe(1198);
  });

  it('does NOT match against an acquisition more than 30 days after the disposal', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-10T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T10:00:00Z'),
        quantity: 10,
        grossAmount: 1200,
        charges: 2,
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-07-15T09:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 1,
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('section-104');
    expect(matched[0].allowableCost).toBe(500);
  });

  it('does NOT match against an acquisition before the disposal (direction matters)', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-05-20T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T10:00:00Z'),
        quantity: 10,
        grossAmount: 1200,
        charges: 2,
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('section-104');
  });
});

describe('matchDisposals — Section 104 pool (CG51575)', () => {
  it('prices a disposal at the pooled average cost of all prior unmatched acquisitions', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-10T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-02-10T08:00:00Z'),
        quantity: 10,
        grossAmount: 700,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T10:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 0,
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('section-104');
    expect(matched[0].allowableCost).toBe(600);
    expect(matched[0].gain).toBe(300);
  });

  it('throws when a disposal exceeds every recorded acquisition — a data-integrity guard, not a silent zero', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-10T08:00:00Z'),
        quantity: 5,
        grossAmount: 250,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-02T10:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 0,
      }),
    ];

    expect(() => matchDisposals(fills)).toThrow(/pool/i);
  });
});

describe('matchDisposals — 30-day window boundary', () => {
  it('matches an acquisition exactly 30 days after the disposal (inclusive)', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-01T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
        idempotency_key: 'acq-pool',
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-01T00:00:00Z'),
        quantity: 10,
        grossAmount: 1000,
        charges: 0,
        idempotency_key: 'disp-1',
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-07-01T00:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 0,
        idempotency_key: 'acq-plus30',
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('30-day');
  });

  it('does NOT match an acquisition 31 days after the disposal', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-01T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
        idempotency_key: 'acq-pool',
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-01T00:00:00Z'),
        quantity: 10,
        grossAmount: 1000,
        charges: 0,
        idempotency_key: 'disp-1',
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-07-02T00:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 0,
        idempotency_key: 'acq-plus31',
      }),
    ];

    const matched = matchDisposals(fills);

    expect(matched).toHaveLength(1);
    expect(matched[0].rule).toBe('section-104');
  });
});

describe('disposalStillInThirtyDayWindow', () => {
  it('is true up to and including the +30-day boundary, false the day after', () => {
    const disposalDate = new Date('2025-06-01T00:00:00.000Z');
    expect(disposalStillInThirtyDayWindow(disposalDate, new Date('2025-06-15T00:00:00Z'))).toBe(
      true,
    );
    expect(disposalStillInThirtyDayWindow(disposalDate, new Date('2025-07-01T00:00:00Z'))).toBe(
      true,
    );
    expect(disposalStillInThirtyDayWindow(disposalDate, new Date('2025-07-02T00:00:00Z'))).toBe(
      false,
    );
  });
});

describe('cgtReportForTaxYear — Annual Exempt Amount sourcing', () => {
  it('refuses a tax year before the AEA is sourced for, rather than printing £3,000 under it', () => {
    expect(() => cgtReportForTaxYear([], ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR - 1)).toThrow(
      /sourced/i,
    );
  });

  it('accepts the first sourced tax year', () => {
    expect(() => cgtReportForTaxYear([], ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR)).not.toThrow();
  });
});

describe('unconvertedCgtFillsInTaxYear', () => {
  it('windows unconverted fills the same way cgtReportForTaxYear windows disposals', () => {
    const fills = [
      {
        instrument: 'LSE:USD',
        kind: 'acquisition' as const,
        date: new Date('2025-04-05T23:59:00Z'),
        quantity: 10,
        grossAmount: 1000,
        charges: 1,
        currency: 'USD',
        fxRateToGbpSource: 'not_reported_by_venue',
        idempotency_key: 'k1',
        broker_fill_id: 'f1',
      },
      {
        instrument: 'LSE:USD',
        kind: 'acquisition' as const,
        date: new Date('2025-04-06T00:00:00Z'),
        quantity: 10,
        grossAmount: 1000,
        charges: 1,
        currency: 'USD',
        fxRateToGbpSource: 'not_reported_by_venue',
        idempotency_key: 'k2',
        broker_fill_id: 'f2',
      },
    ];

    expect(unconvertedCgtFillsInTaxYear(fills, 2024)).toHaveLength(1);
    expect(unconvertedCgtFillsInTaxYear(fills, 2025)).toHaveLength(1);
  });
});

describe('matchDisposals — disposal ordering', () => {
  it('processes disposals in date order so the earlier disposal claims a shared 30-day acquisition first', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-01T08:00:00Z'),
        quantity: 10,
        grossAmount: 500,
        charges: 0,
        idempotency_key: 'acq-pool',
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-01T10:00:00Z'),
        quantity: 10,
        grossAmount: 1000,
        charges: 0,
        idempotency_key: 'disp-early',
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-06-05T10:00:00Z'),
        quantity: 10,
        grossAmount: 1100,
        charges: 0,
        idempotency_key: 'disp-late',
      }),
      leg({
        kind: 'acquisition',
        date: new Date('2025-06-10T08:00:00Z'),
        quantity: 10,
        grossAmount: 900,
        charges: 0,
        idempotency_key: 'acq-shared',
      }),
    ];

    const matched = matchDisposals(fills);
    expect(matched).toHaveLength(2);
    const [early, late] = matched;

    expect(early.rule).toBe('30-day');
    expect(late.rule).toBe('section-104');
  });
});

describe('tax-year windowing', () => {
  it('labels a date on or after 6 April as the tax year starting that April', () => {
    expect(ukTaxYearLabel(new Date('2025-04-06T00:00:00Z'))).toBe('2025-26');
    expect(ukTaxYearLabel(new Date('2025-04-05T23:59:00Z'))).toBe('2024-25');
  });

  it('bounds are half-open [6 Apr Y, 6 Apr Y+1)', () => {
    const { from, to } = ukTaxYearBounds(2025);
    expect(from.toISOString()).toBe('2025-04-06T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-04-06T00:00:00.000Z');
  });

  it('puts one disposal at 5 Apr 23:59 and one at 6 Apr 00:00 into different tax years', () => {
    const fills: CgtFillLeg[] = [
      leg({
        kind: 'acquisition',
        date: new Date('2025-01-01T08:00:00Z'),
        quantity: 20,
        grossAmount: 1000,
        charges: 0,
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-04-05T23:59:00Z'),
        quantity: 10,
        grossAmount: 600,
        charges: 0,
        idempotency_key: 'd1',
      }),
      leg({
        kind: 'disposal',
        date: new Date('2025-04-06T00:00:00Z'),
        quantity: 10,
        grossAmount: 700,
        charges: 0,
        idempotency_key: 'd2',
      }),
    ];
    const matched = matchDisposals(fills);

    const report2425 = cgtReportForTaxYear(matched, 2024);
    const report2526 = cgtReportForTaxYear(matched, 2025);

    expect(report2425.disposals).toHaveLength(1);
    expect(report2425.disposals[0].proceeds).toBe(600);
    expect(report2526.disposals).toHaveLength(1);
    expect(report2526.disposals[0].proceeds).toBe(700);

    expect(report2425.disposals[0].disposalDate.toISOString()).toBe('2025-04-05T00:00:00.000Z');
    expect(report2526.disposals[0].disposalDate.toISOString()).toBe('2025-04-06T00:00:00.000Z');
  });

  it('carries the annual exempt amount and HMRC citations as sourced constants, never a computed tax figure', () => {
    const report = cgtReportForTaxYear([], 2025);
    expect(report.annualExemptAmountGbp).toBe(ANNUAL_EXEMPT_AMOUNT_GBP);
    expect(HMRC_SAME_DAY_RULE_CITATION).toBe('CG51560');
    expect(HMRC_30_DAY_RULE_CITATION).toBe('CG51560/CG51570');
    expect(HMRC_SECTION_104_CITATION).toBe('CG51575');
  });
});
