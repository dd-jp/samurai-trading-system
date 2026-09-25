import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { CapitalConfigError, CapitalConfigStore } from './capital-config.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

function store() {
  const db = openSharedStore(':memory:');
  return { db, capital: new CapitalConfigStore(db, clock) };
}

describe('CapitalConfigStore', () => {
  it('sets a year from 1 January and answers only for dates inside that year', () => {
    const { db, capital } = store();
    expect(capital.setYear(2026, 2_000, 1_500)).toEqual({
      year: 2026,
      effectiveFrom: '2026-01-01',
      startCapitalGbp: 2_000,
      lossCapGbp: 1_500,
    });
    expect(capital.inForce('2026-01-01')).toMatchObject({ year: 2026, lossCapGbp: 1_500 });
    expect(capital.inForce('2026-12-31')).toMatchObject({ year: 2026 });
    expect(capital.inForce('2025-12-31')).toBeUndefined();
    expect(capital.inForce('2027-01-04')).toBeUndefined();
    expect(capital.lastKnown('2027-01-04')).toMatchObject({ year: 2026 });
    expect(capital.lastKnown('2025-12-31')).toBeUndefined();
    expect(db.prepare('SELECT recorded_at FROM v2_capital_config').get()).toEqual({
      recorded_at: '2026-09-25T12:00:00.000Z',
    });
  });

  it('refuses a second set of the same year and malformed settings', () => {
    const { capital } = store();
    capital.setYear(2026, 2_000, 1_500);
    expect(() => capital.setYear(2026, 2_000, 1_000)).toThrow(
      /2026 is already set; mid-year the cap may only be tightened/,
    );
    for (const year of [2026.5, 26, 1999, 2101, -2026]) {
      expect(() => capital.setYear(year, 2_000, 1_500)).toThrow(
        /year must be an integer from 2000 to 2100/,
      );
    }
    expect(capital.setYear(2000, 2_000, 1_500).effectiveFrom).toBe('2000-01-01');
    expect(capital.setYear(2100, 2_000, 1_500).effectiveFrom).toBe('2100-01-01');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => capital.setYear(2027, bad, 1_500)).toThrow(/start capital must be a positive/);
      expect(() => capital.setYear(2027, 2_000, bad)).toThrow(/loss cap must be a positive/);
    }
    expect(() => capital.setYear(2027, 0, 1_500)).toThrow(CapitalConfigError);
    expect(capital.inForce('2027-06-01')).toBeUndefined();
  });

  it('tightens from a future date, keeps start capital, and leaves earlier dates on the old cap', () => {
    const { capital } = store();
    capital.setYear(2026, 2_000, 1_500);
    expect(capital.tighten('2026-09-25', 900)).toEqual({
      year: 2026,
      effectiveFrom: '2026-09-25',
      startCapitalGbp: 2_000,
      lossCapGbp: 900,
    });
    expect(capital.inForce('2026-09-24')?.lossCapGbp).toBe(1_500);
    expect(capital.inForce('2026-09-25')?.lossCapGbp).toBe(900);
    expect(capital.lastKnown('2027-02-01')?.lossCapGbp).toBe(900);
    expect(capital.tighten('2026-10-01', 899)).toMatchObject({ lossCapGbp: 899 });
    expect(capital.inForce('2026-09-30')?.lossCapGbp).toBe(900);
    expect(capital.inForce('2026-10-01')?.lossCapGbp).toBe(899);
  });

  it('refuses a loosening, an equal cap, a past or non-advancing date, and a year never set', () => {
    const { capital } = store();
    capital.setYear(2026, 2_000, 1_500);
    expect(() => capital.tighten('2026-10-01', 1_501)).toThrow(
      /does not tighten £1500; loosening mid-year is refused/,
    );
    expect(() => capital.tighten('2026-10-01', 1_500)).toThrow(/loosening mid-year is refused/);
    expect(() => capital.tighten('2026-09-24', 900)).toThrow(/takes effect from today on/);
    capital.tighten('2026-10-01', 900);
    expect(() => capital.tighten('2026-10-01', 800)).toThrow(/and after 2026-10-01/);
    expect(() => capital.tighten('2026-09-30', 800)).toThrow(/and after 2026-10-01/);
    expect(() => capital.tighten('2027-02-01', 800)).toThrow(/2027 has no cap to tighten/);
    for (const malformed of [
      '2026-1-01',
      'x2026-10-02',
      '2026-10-02x',
      '2026-13-01',
      '2026-02-30',
    ]) {
      expect(() => capital.tighten(malformed, 800)).toThrow(
        /effective date must be a real YYYY-MM-DD date/,
      );
    }
    expect(() => capital.tighten('2026-10-02', 0)).toThrow(/loss cap must be a positive/);
    expect(capital.inForce('2026-12-31')?.lossCapGbp).toBe(900);
  });

  it('is append-only and pins each row to its own year in the schema', () => {
    const { db, capital } = store();
    capital.setYear(2026, 2_000, 1_500);
    expect(() => db.prepare('UPDATE v2_capital_config SET loss_cap_gbp = 9999').run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_capital_config').run()).toThrow(/append-only/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
           VALUES (2027, '2026-12-31', 1, 1, 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
