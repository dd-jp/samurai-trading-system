import {
  type CapitalYear,
  type ControlRowWire,
  type ControlWire,
  type DecisionsWire,
  type HeartbeatWire,
  type LlmSpendWire,
  type LossBudgetBookWire,
  type LossBudgetWire,
  type ManualControl,
  type PanelWire,
  type SleeveAction,
  V2_CONTRACT_VERSION,
  type V2ModeWire,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import { type StoreHandle, toStoredTimestamp } from '../../../shared/store/index.js';
import {
  CapitalConfigStore,
  ControlStore,
  dailyCapGbp,
  sizeStepMarksGbp,
  sleeveCapitalYear,
} from '../risk/index.js';
import { SLEEVE_SPECS_BY_ID, SqliteMonthlySpendCap, utcMonthStart } from '../signal/index.js';
import { heartbeatWire } from './heartbeat-feed.js';
import { vetoOf } from './journal-reader.js';
import { type Holdings, type PositionsPanel, readHoldings } from './positions.js';

const CONTROL_HISTORY_ROWS = 20;

interface BookDayRow {
  book_id: string;
  sleeve_id: string;
  variant: string;
  trading_date: string;
  equity_gbp: number;
  previous_equity_gbp: number;
  ytd_loss_gbp: number;
  size_multiplier: number;
  entries_blocked: number;
}

interface DecisionRow {
  trading_date: string;
  book_id: string;
  instrument: string;
  venue: string;
  direction: string;
  action: SleeveAction;
  reason: string;
  confidence: number;
}

const LATEST_BOOK_DAYS = `
  WITH latest AS (SELECT book_id, MAX(trading_date) AS trading_date FROM v2_book_days GROUP BY book_id)
  SELECT d.book_id, b.sleeve_id, b.variant, d.trading_date, d.equity_gbp, d.ytd_loss_gbp,
         d.size_multiplier, d.entries_blocked,
         COALESCE(
           (SELECT p.equity_gbp FROM v2_book_days p
             WHERE p.book_id = d.book_id AND p.trading_date < d.trading_date
             ORDER BY p.trading_date DESC LIMIT 1),
           d.equity_gbp) AS previous_equity_gbp
    FROM v2_book_days d JOIN latest USING (book_id, trading_date) JOIN v2_books b USING (book_id)
   ORDER BY b.sleeve_id, b.variant <> 'primary', d.book_id`;

const LATEST_PRIMARY_DECISIONS = `
  WITH latest AS (SELECT book_id, MAX(trading_date) AS trading_date FROM v2_decisions GROUP BY book_id)
  SELECT d.trading_date, d.book_id, d.instrument, d.venue, d.direction, d.action, d.reason,
         d.confidence
    FROM v2_decisions d JOIN latest USING (book_id, trading_date) JOIN v2_books b USING (book_id)
   WHERE b.variant = 'primary'
   ORDER BY d.book_id, d.instrument`;

function isPrimary(row: BookDayRow): boolean {
  return row.variant === 'primary';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function dayLoss(row: BookDayRow): number {
  return row.previous_equity_gbp - row.equity_gbp;
}

function latestDate(rows: readonly { trading_date: string }[]): string {
  return rows.reduce((latest, row) => (row.trading_date > latest ? row.trading_date : latest), '');
}

interface SleeveCaps {
  readonly lossCapGbp: number;
  readonly stepMarksGbp: readonly [number, number, number];
  readonly dailyCapGbp: number;
}

// An unregistered sleeve_id shows no scaled figures rather than falling back to the account's
function sleeveCapsFor(sleeveId: string, capital: CapitalYear): SleeveCaps | undefined {
  const spec = SLEEVE_SPECS_BY_ID[sleeveId];
  if (spec === undefined) return undefined;
  const sleeveCapital = sleeveCapitalYear(spec, capital);
  return {
    lossCapGbp: sleeveCapital.lossCapGbp,
    stepMarksGbp: sizeStepMarksGbp(sleeveCapital.lossCapGbp),
    dailyCapGbp: dailyCapGbp(sleeveCapital),
  };
}

function bookWire(row: BookDayRow, capital: CapitalYear): LossBudgetBookWire {
  const caps = sleeveCapsFor(row.sleeve_id, capital);
  return {
    book_id: row.book_id,
    sleeve_id: row.sleeve_id,
    variant: row.variant,
    trading_date: row.trading_date,
    ytd_loss_gbp: row.ytd_loss_gbp,
    day_loss_gbp: dayLoss(row),
    size_multiplier: row.size_multiplier,
    entries_blocked: row.entries_blocked === 1,
    loss_cap_gbp: caps?.lossCapGbp ?? null,
    step_marks_gbp: caps?.stepMarksGbp ?? null,
    daily_cap_gbp: caps?.dailyCapGbp ?? null,
  };
}

function displayState(control: ManualControl, lossBudgetHalted: boolean): ControlWire['state'] {
  if (lossBudgetHalted) return 'halted-loss-budget';
  if (control.state === 'halted') return 'halted-manual';
  return control.state;
}

export class OverviewReader {
  private readonly capital: CapitalConfigStore;
  private readonly controls: ControlStore;
  private readonly spendCap: SqliteMonthlySpendCap;

  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly mode: V2ModeWire,
    private readonly positions: PositionsPanel,
  ) {
    this.capital = new CapitalConfigStore(db, clock);
    this.controls = new ControlStore(db);
    this.spendCap = new SqliteMonthlySpendCap(db, clock);
  }

  async read(): Promise<V2OverviewWire> {
    const { overview, holdings } = this.db.transaction(() => this.#snapshot())();
    return { ...overview, positions: await this.positions.present(holdings) };
  }

  #snapshot(): { overview: Omit<V2OverviewWire, 'positions'>; holdings: Holdings } {
    const bookDays = this.db.prepare(LATEST_BOOK_DAYS).all() as BookDayRow[];
    const overview = {
      contract_version: V2_CONTRACT_VERSION,
      generated_at: this.clock.now().toISOString(),
      mode: this.mode,
      loss_budget: this.lossBudget(bookDays),
      control: this.control(bookDays),
      decisions: this.decisions(),
      llm_spend: this.llmSpend(),
      heartbeat: this.heartbeat(),
    };
    return { overview, holdings: readHoldings(this.db) };
  }

  lossBudget(bookDays: readonly BookDayRow[]): PanelWire<LossBudgetWire> {
    if (bookDays.length === 0) return { status: 'empty' };
    const tradingDate = latestDate(bookDays);
    const capital = this.capital.lastKnown(tradingDate);
    if (capital === undefined) {
      return { status: 'not-yet-fed', owner: 'npm run v2:capital (D8)', ticket: '#1745' };
    }
    const primaries = bookDays.filter(isPrimary);
    return {
      status: 'fed',
      year: capital.year,
      capital_stale: capital.year !== Number(tradingDate.slice(0, 4)),
      trading_date: tradingDate,
      start_capital_gbp: capital.startCapitalGbp,
      loss_cap_gbp: capital.lossCapGbp,
      step_marks_gbp: sizeStepMarksGbp(capital.lossCapGbp),
      daily_cap_gbp: dailyCapGbp(capital),
      ytd_loss_gbp: sum(primaries.map((row) => row.ytd_loss_gbp)),
      day_loss_gbp: sum(primaries.map(dayLoss)),
      books: bookDays.map((row) => bookWire(row, capital)),
    };
  }

  control(bookDays: readonly BookDayRow[]): ControlWire {
    const manual = this.controls.current();
    const history = this.db
      .prepare(
        'SELECT control_id, action, reason, source, set_at FROM v2_controls ORDER BY control_id DESC LIMIT ?',
      )
      .all(CONTROL_HISTORY_ROWS) as ControlRowWire[];
    const primaries = bookDays.filter(isPrimary);
    const halted = primaries.filter((row) => row.size_multiplier === 0).map((row) => row.book_id);
    return {
      state: displayState(manual, primaries.length > 0 && halted.length === primaries.length),
      in_force: manual.state === 'running' ? null : (history[0] ?? null),
      loss_budget_halted_books: halted,
      history,
    };
  }

  decisions(): PanelWire<DecisionsWire> {
    const rows = this.db.prepare(LATEST_PRIMARY_DECISIONS).all() as DecisionRow[];
    if (rows.length === 0) return { status: 'empty' };
    return {
      status: 'fed',
      trading_date: latestDate(rows),
      decisions: rows.map((row) => ({
        ...row,
        vetoed: vetoOf(row.action, row.reason) !== null,
      })),
    };
  }

  llmSpend(): PanelWire<LlmSpendWire> {
    const verdict = this.spendCap.check();
    const since = toStoredTimestamp(utcMonthStart(this.clock.now()));
    const byModel = this.db
      .prepare(
        `SELECT model, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM llm_spend
          WHERE timestamp >= ? GROUP BY model ORDER BY cost_usd DESC, model`,
      )
      .all(since) as LlmSpendWire['by_model'];
    const byDay = this.db
      .prepare(
        `SELECT substr(timestamp, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM llm_spend WHERE timestamp >= ? GROUP BY day ORDER BY day`,
      )
      .all(since) as LlmSpendWire['by_day'];
    return {
      status: 'fed',
      month_start: since,
      spent_usd: Number.isFinite(verdict.spent_usd) ? verdict.spent_usd : null,
      budget_usd: verdict.budget_usd,
      calls_stopped: !verdict.admitted,
      by_model: byModel,
      by_day: byDay,
    };
  }

  heartbeat(): HeartbeatWire {
    return heartbeatWire(this.db);
  }
}
