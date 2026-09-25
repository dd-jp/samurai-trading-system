import type { CapitalYear } from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';

export class CapitalConfigError extends Error {
  constructor(message: string) {
    super(`capital config: ${message}`);
    this.name = 'CapitalConfigError';
  }
}

interface CapitalRow {
  year: number;
  effective_from: string;
  start_capital_gbp: number;
  loss_cap_gbp: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromRow(row: CapitalRow): CapitalYear {
  return {
    year: row.year,
    effectiveFrom: row.effective_from,
    startCapitalGbp: row.start_capital_gbp,
    lossCapGbp: row.loss_cap_gbp,
  };
}

function assertPositive(label: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new CapitalConfigError(`${label} must be a positive number (got ${value})`);
  }
}

export class CapitalConfigStore {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  setYear(year: number, startCapitalGbp: number, lossCapGbp: number): CapitalYear {
    if (!Number.isInteger(year))
      throw new CapitalConfigError(`year must be an integer (got ${year})`);
    assertPositive('start capital', startCapitalGbp);
    assertPositive('loss cap', lossCapGbp);
    if (this.#latestOfYear(year) !== undefined) {
      throw new CapitalConfigError(
        `${year} is already set; mid-year the cap may only be tightened (doc 66 D8, Q13)`,
      );
    }
    return this.#insert({
      year,
      effectiveFrom: `${String(year).padStart(4, '0')}-01-01`,
      startCapitalGbp,
      lossCapGbp,
    });
  }

  tighten(effectiveFrom: string, lossCapGbp: number): CapitalYear {
    if (!ISO_DATE.test(effectiveFrom)) {
      throw new CapitalConfigError(`effective date must be YYYY-MM-DD (got ${effectiveFrom})`);
    }
    assertPositive('loss cap', lossCapGbp);
    const year = Number(effectiveFrom.slice(0, 4));
    const latest = this.#latestOfYear(year);
    if (latest === undefined) throw new CapitalConfigError(`${year} has no cap to tighten`);
    if (effectiveFrom < this.#today() || effectiveFrom <= latest.effectiveFrom) {
      throw new CapitalConfigError(
        `a tightening takes effect from today on and after ${latest.effectiveFrom} (got ${effectiveFrom})`,
      );
    }
    if (lossCapGbp >= latest.lossCapGbp) {
      throw new CapitalConfigError(
        `£${lossCapGbp} does not tighten £${latest.lossCapGbp}; loosening mid-year is refused (doc 66 Q13)`,
      );
    }
    return this.#insert({ ...latest, effectiveFrom, lossCapGbp });
  }

  inForce(tradingDate: string): CapitalYear | undefined {
    const row = this.db
      .prepare(
        `SELECT year, effective_from, start_capital_gbp, loss_cap_gbp FROM v2_capital_config
         WHERE year = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(Number(tradingDate.slice(0, 4)), tradingDate) as CapitalRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  lastKnown(tradingDate: string): CapitalYear | undefined {
    const row = this.db
      .prepare(
        `SELECT year, effective_from, start_capital_gbp, loss_cap_gbp FROM v2_capital_config
         WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(tradingDate) as CapitalRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #latestOfYear(year: number): CapitalYear | undefined {
    const row = this.db
      .prepare(
        `SELECT year, effective_from, start_capital_gbp, loss_cap_gbp FROM v2_capital_config
         WHERE year = ? ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(year) as CapitalRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #insert(setting: CapitalYear): CapitalYear {
    this.db
      .prepare(
        `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        setting.year,
        setting.effectiveFrom,
        setting.startCapitalGbp,
        setting.lossCapGbp,
        toStoredTimestamp(this.clock.now()),
      );
    return setting;
  }

  #today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}
