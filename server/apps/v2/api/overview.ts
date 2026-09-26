import {
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
import { CapitalConfigStore, ControlStore, dailyCapGbp, sizeStepMarksGbp } from '../risk/index.js';
import { SqliteMonthlySpendCap, utcMonthStart } from '../signal/index.js';

const CONTROL_HISTORY_ROWS = 20;
const SCHEDULE_OWNER = { status: 'not-yet-fed', owner: 'Step 3e', ticket: '#1784' } as const;

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
  SELECT d.book_id, b.sleeve_id, b.variant, d.trading_date, d.equity_gbp, d.ytd_loss_gbp,
         d.size_multiplier, d.entries_blocked,
         COALESCE(
           (SELECT p.equity_gbp FROM v2_book_days p
             WHERE p.book_id = d.book_id AND p.trading_date < d.trading_date
             ORDER BY p.trading_date DESC LIMIT 1),
           b.start_capital_gbp) AS previous_equity_gbp
    FROM v2_book_days d JOIN v2_books b USING (book_id)
   WHERE d.trading_date = (SELECT MAX(trading_date) FROM v2_book_days)
   ORDER BY b.sleeve_id, b.variant <> 'primary', d.book_id`;

const LATEST_PRIMARY_DECISIONS = `
  SELECT d.trading_date, d.book_id, d.instrument, d.venue, d.direction, d.action, d.reason,
         d.confidence
    FROM v2_decisions d JOIN v2_books b USING (book_id)
   WHERE b.variant = 'primary'
     AND d.trading_date = (SELECT MAX(d2.trading_date) FROM v2_decisions d2
                             JOIN v2_books b2 USING (book_id) WHERE b2.variant = 'primary')
   ORDER BY d.book_id, d.instrument`;

function isPrimary(row: BookDayRow): boolean {
  return row.variant === 'primary';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function bookWire(row: BookDayRow): LossBudgetBookWire {
  return {
    book_id: row.book_id,
    sleeve_id: row.sleeve_id,
    variant: row.variant,
    trading_date: row.trading_date,
    ytd_loss_gbp: row.ytd_loss_gbp,
    size_multiplier: row.size_multiplier,
    entries_blocked: row.entries_blocked === 1,
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
  ) {
    this.capital = new CapitalConfigStore(db, clock);
    this.controls = new ControlStore(db);
    this.spendCap = new SqliteMonthlySpendCap(db, clock);
  }

  read(): V2OverviewWire {
    const bookDays = this.db.prepare(LATEST_BOOK_DAYS).all() as BookDayRow[];
    return {
      contract_version: V2_CONTRACT_VERSION,
      generated_at: this.clock.now().toISOString(),
      mode: this.mode,
      loss_budget: this.lossBudget(bookDays),
      control: this.control(bookDays),
      decisions: this.decisions(),
      llm_spend: this.llmSpend(),
      heartbeat: this.heartbeat(),
    };
  }

  lossBudget(bookDays: readonly BookDayRow[]): PanelWire<LossBudgetWire> {
    const [first] = bookDays;
    if (first === undefined) return { status: 'empty' };
    const capital = this.capital.inForce(first.trading_date);
    if (capital === undefined) {
      return { status: 'not-yet-fed', owner: 'npm run v2:capital (D8)', ticket: '#1745' };
    }
    const primaries = bookDays.filter(isPrimary);
    return {
      status: 'fed',
      year: capital.year,
      trading_date: first.trading_date,
      start_capital_gbp: capital.startCapitalGbp,
      loss_cap_gbp: capital.lossCapGbp,
      step_marks_gbp: sizeStepMarksGbp(capital.lossCapGbp),
      daily_cap_gbp: dailyCapGbp(capital),
      ytd_loss_gbp: sum(primaries.map((row) => row.ytd_loss_gbp)),
      day_loss_gbp: sum(primaries.map((row) => row.previous_equity_gbp - row.equity_gbp)),
      books: bookDays.map(bookWire),
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
    const [first] = rows;
    if (first === undefined) return { status: 'empty' };
    return {
      status: 'fed',
      trading_date: first.trading_date,
      decisions: rows.map(({ trading_date: _date, ...row }) => ({
        ...row,
        vetoed: row.action === 'skip' && row.reason.startsWith('vetoed:'),
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
      spent_usd: verdict.spent_usd,
      budget_usd: verdict.budget_usd,
      calls_stopped: !verdict.admitted,
      by_model: byModel,
      by_day: byDay,
    };
  }

  heartbeat(): HeartbeatWire {
    const last = this.db
      .prepare(
        'SELECT trading_date, recorded_at FROM v2_book_days ORDER BY recorded_at DESC LIMIT 1',
      )
      .get() as { trading_date: string; recorded_at: string } | undefined;
    return {
      last_cycle: last === undefined ? { status: 'empty' } : { status: 'fed', ...last },
      next_due: SCHEDULE_OWNER,
      last_ping: SCHEDULE_OWNER,
    };
  }
}
