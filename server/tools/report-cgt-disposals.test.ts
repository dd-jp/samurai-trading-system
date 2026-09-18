import { cgtReportForTaxYear } from '../pipeline/cgt/index.js';
import { openSharedStore, toStoredTimestamp } from '../shared/store/index.js';
import {
  assertLiveMode,
  buildCgtReport,
  currentTaxYearStartYear,
  formatCgtReport,
  parseTaxYearStartYear,
} from './report-cgt-disposals.js';

describe('parseTaxYearStartYear', () => {
  it('defaults to the current UK tax year when --tax-year is absent', () => {
    expect(parseTaxYearStartYear([], new Date('2025-06-01T00:00:00Z'))).toBe(2025);
    expect(parseTaxYearStartYear([], new Date('2025-02-01T00:00:00Z'))).toBe(2024);
  });

  it('parses an explicit --tax-year', () => {
    expect(parseTaxYearStartYear(['--tax-year', '2024-25'], new Date())).toBe(2024);
  });

  it('rejects a malformed or non-consecutive --tax-year rather than silently defaulting', () => {
    expect(() => parseTaxYearStartYear(['--tax-year', '2023'], new Date())).toThrow();
    expect(() => parseTaxYearStartYear(['--tax-year', '2023-25'], new Date())).toThrow();
  });

  it('rejects a tax year before the sourced Annual Exempt Amount, rather than guessing a historical figure', () => {
    expect(() => parseTaxYearStartYear(['--tax-year', '2023-24'], new Date())).toThrow(/sourced/i);
  });
});

describe('currentTaxYearStartYear', () => {
  it('is 6 April boundary-exact', () => {
    expect(currentTaxYearStartYear(new Date('2025-04-05T23:59:00Z'))).toBe(2024);
    expect(currentTaxYearStartYear(new Date('2025-04-06T00:00:00Z'))).toBe(2025);
  });
});

describe('assertLiveMode', () => {
  it('passes for live', () => {
    expect(() => assertLiveMode('live')).not.toThrow();
  });

  it('refuses a non-live store rather than printing paper/backtest fills as real disposals', () => {
    expect(() => assertLiveMode('paper')).toThrow(/live/i);
    expect(() => assertLiveMode('backtest')).toThrow(/live/i);
  });
});

describe('formatCgtReport', () => {
  it('always prints the not-tax-advice disclaimer, the HMRC citations, and the unconverted section, even for an empty report', () => {
    const report = cgtReportForTaxYear([], 2025);
    const text = formatCgtReport(
      report,
      [],
      'paper',
      '/tmp/samurai-paper.db',
      new Date('2025-06-01T00:00:00Z'),
    );

    expect(text).toContain('NOT TAX ADVICE');
    expect(text).toContain('CG51560');
    expect(text).toContain('CG51570');
    expect(text).toContain('CG51575');
    expect(text).toContain('mode=paper');
    expect(text).toContain('(no disposals in this tax year)');
    expect(text).toContain('UNCONVERTED');
    expect(text).toContain('(none this tax year)');
    expect(text).toContain('neither GBP nor a pence sub-unit (GBX/gbx/GBp/p)');
  });

  it('prints the matched acquisition date and flags an in-window Section 104 row as provisional', () => {
    const disposals = [
      {
        instrument: '3USL',
        disposalDate: new Date('2025-06-10T00:00:00Z'),
        acquisitionDate: new Date('2025-06-10T00:00:00Z'),
        quantity: 4,
        proceeds: 400,
        allowableCost: 380,
        gain: 20,
        rule: 'same-day' as const,
      },
      {
        instrument: '3USL',
        disposalDate: new Date('2025-06-20T00:00:00Z'),
        quantity: 6,
        proceeds: 600,
        allowableCost: 590,
        gain: 10,
        rule: 'section-104' as const,
      },
    ];
    const text = formatCgtReport(
      cgtReportForTaxYear(disposals, 2025),
      [],
      'live',
      '/tmp/samurai-live.db',
      new Date('2025-07-01T00:00:00Z'),
    );

    const row = (t: string, rule: string) =>
      t.split('\n').find((l) => l.startsWith('  3USL') && l.includes(rule));
    const sameDayRow = row(text, 'same-day');
    const poolRow = row(text, 'section-104');
    expect(sameDayRow).toContain('2025-06-10    2025-06-10');
    expect(sameDayRow).not.toContain('(provisional)');
    expect(poolRow).toContain('2025-06-20    -');
    expect(poolRow).toContain('(provisional)');

    const later = formatCgtReport(
      cgtReportForTaxYear(disposals, 2025),
      [],
      'live',
      '/tmp/samurai-live.db',
      new Date('2025-08-01T00:00:00Z'),
    );
    expect(row(later, 'section-104')).not.toContain('(provisional)');
  });
});

describe('buildCgtReport — the composed read → match → window chain, against :memory:', () => {
  it('reads a same-day round trip through the whole chain and prices it in the report', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO closed_trades (
         idempotency_key, debate_id, instrument, asset_class, side, entry, stop,
         filled_size, realized_pnl_net, fees_total, opened_at, closed_at,
         close_reason, arm, modelled_cost_charged
       ) VALUES ('k1', 'debate-1', 'LSE:TEST', 'stocks', 'buy', 100, 90, 10, 197, 3, ?, ?, 'target', 'live', 1)`,
    ).run(
      toStoredTimestamp(new Date('2025-06-02T08:00:00Z')),
      toStoredTimestamp(new Date('2025-06-02T14:00:00Z')),
    );
    db.prepare(
      `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, fee_currency)
       VALUES ('k1', 'f1', 'entry', 100, 10, 1, ?, 'GBP')`,
    ).run(toStoredTimestamp(new Date('2025-06-02T08:05:00Z')));
    db.prepare(
      `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, fee_currency)
       VALUES ('k1', 'f2', 'target', 120, 10, 2, ?, 'GBP')`,
    ).run(toStoredTimestamp(new Date('2025-06-02T14:00:00Z')));

    const { report, unconverted } = buildCgtReport(db, 2025);

    expect(report.disposals).toHaveLength(1);
    expect(report.disposals[0].rule).toBe('same-day');
    expect(report.totalGain).toBe(197);
    expect(unconverted).toHaveLength(0);
  });

  it('carries an unconverted USD fill through to the report separately from the matched total', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO open_positions (
         idempotency_key, debate_id, instrument, asset_class, side, intent_type,
         requested_size, filled_size, avg_entry_price, stop, target, order_state,
         broker_order_ids, opened_at, decision_timestamp, arm
       ) VALUES ('k2', 'debate-1', 'LSE:USD3X', 'stocks', 'buy', 'entry', 10, 10, 100, 90, 120, 'filled', '[]', ?, ?, 'live')`,
    ).run(
      toStoredTimestamp(new Date('2025-06-01T08:00:00Z')),
      toStoredTimestamp(new Date('2025-06-01T08:00:00Z')),
    );
    db.prepare(
      `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, fee_currency)
       VALUES ('k2', 'f1', 'entry', 50, 20, 1, ?, 'USD')`,
    ).run(toStoredTimestamp(new Date('2025-06-01T08:00:00Z')));

    const { report, unconverted } = buildCgtReport(db, 2025);

    expect(report.disposals).toHaveLength(0);
    expect(unconverted).toHaveLength(1);
    expect(unconverted[0].currency).toBe('USD');
    expect(unconverted[0].fxRateToGbpSource).toBe('no_rate_stored');

    const text = formatCgtReport(
      report,
      unconverted,
      'live',
      '/tmp/samurai-live.db',
      new Date('2025-07-01T00:00:00Z'),
    );
    const uncRow = text.split('\n').find((l) => l.includes('LSE:USD3X'));
    expect(uncRow).toContain('USD');
    expect(uncRow).toContain('no_rate_stored');
  });
});
