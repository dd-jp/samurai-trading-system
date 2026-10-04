import type {
  JournalledOrder,
  JournalledReconcile,
  JournalledRefusal,
} from '../../../../contracts/index.js';
import type { Clock, LogEntry, Logger } from '../../../shared/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';

export const FAULT_KINDS = [
  'missed_stop',
  'reconcile_mismatch',
  'stuck_order',
  'refused_cycle',
  'stale_bar',
  'failed_broker_call',
  'missed_run',
  'token_failure',
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

// Q7(3) names missed_stop, reconcile_mismatch and stuck_order and #1878 adds the other five;
// counting all eight can only make the fault-free weeks harder to reach, never easier
const GATE_FAULT_KINDS: readonly FaultKind[] = FAULT_KINDS;

export interface Fault {
  readonly kind: FaultKind;
  readonly trading_date: string;
  readonly code: string;
  readonly detail: string;
}

export interface FaultSink {
  record(fault: Fault): void;
}

export interface FaultFreeWeeks {
  readonly weeks: number;
  readonly counted_days: number;
  readonly since: string | undefined;
  readonly last_fault: string | undefined;
}

export interface FaultKindCount {
  readonly kind: FaultKind;
  readonly count: number;
}

const REFUSAL_FAULTS: Readonly<Record<string, FaultKind>> = {
  MARK_FRESHNESS: 'stale_bar',
  CALENDAR_REFERENCE: 'stale_bar',
  REARM_BACKSTOP: 'missed_stop',
  SAXO_SESSION: 'token_failure',
};

const EVENT_FAULTS: Readonly<Record<string, FaultKind>> = {
  v2_fill_sweep_failed: 'failed_broker_call',
  v2_resume_flatten_failed: 'failed_broker_call',
  v2_cancel_failed: 'stuck_order',
  v2_pending_order_resolved: 'stuck_order',
  v2_simulated_flatten_stale: 'stuck_order',
  v2_rearm_backstop_failed: 'missed_stop',
  v2_reconcile_threw: 'reconcile_mismatch',
};

export function refusalFault(refusal: JournalledRefusal): Fault | undefined {
  const kind = REFUSAL_FAULTS[refusal.parameter];
  if (kind === undefined) return undefined;
  return {
    kind,
    trading_date: refusal.trading_date,
    code: refusal.parameter,
    detail: refusal.message,
  };
}

export function reconcileFaults(run: JournalledReconcile): Fault[] {
  const fault = (kind: FaultKind, code: string, detail: string): Fault => ({
    kind,
    trading_date: run.trading_date,
    code,
    detail: `${run.venue} ${run.source}: ${detail}`,
  });
  if (run.status === 'read_failed') {
    return [fault('failed_broker_call', 'BROKER_RECONCILE_READ', run.detail)];
  }
  if (run.status !== 'mismatch') return [];
  return [
    fault('reconcile_mismatch', 'BROKER_RECONCILE', run.detail),
    ...run.diffs
      .filter((diff) => diff.kind === 'position_unprotected')
      .map((diff) => fault('missed_stop', diff.kind, `${diff.instrument} held without a stop`)),
  ];
}

// A sizing refusal is journalled as 'rejected' too, but carries no approval: only an approved
// order the venue turned down is a failed broker call
export function orderFault(order: JournalledOrder): Fault | undefined {
  const approval = order.payload.approval;
  if (order.outcome !== 'rejected' || typeof approval !== 'string' || approval === '') {
    return undefined;
  }
  return {
    kind: 'failed_broker_call',
    trading_date: order.trading_date,
    code: `${order.leg}_rejected`,
    detail: `${order.client_order_id}: ${String(order.payload.detail)}`,
  };
}

export class FaultRecordingLogger implements Logger {
  constructor(
    private readonly inner: Logger,
    private readonly sink: FaultSink,
    private readonly tradingDate: () => string,
  ) {}

  log(entry: LogEntry): void {
    this.inner.log(entry);
    const code = String(entry.event);
    const kind = EVENT_FAULTS[code];
    if (kind === undefined) return;
    this.sink.record({ kind, trading_date: this.tradingDate(), code, detail: entry.message });
  }
}

const MS_PER_DAY = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function datesFrom(from: string, through: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= through; date = addDays(date, 1)) dates.push(date);
  return dates;
}

// The paper cycle's launchd job runs Monday to Friday (ops/launchd/com.samurai.v2-paper.plist)
function isScheduledRunDay(date: string): boolean {
  const weekday = new Date(date).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function missedRunDates(
  lastMarked: string | undefined,
  today: string,
  isSkippedDay: (date: string) => boolean,
): string[] {
  if (lastMarked === undefined) return [];
  return datesFrom(addDays(lastMarked, 1), addDays(today, -1)).filter(
    (date) => isScheduledRunDay(date) && !isSkippedDay(date),
  );
}

export interface ControlEvent {
  readonly action: 'pause' | 'halt' | 'resume';
  readonly set_at: string;
}

// Doc 66 U6: a day that spent any time paused or halted does not count toward the fault-free
// weeks. The count stops over it; it does not restart
export function pausedDates(events: readonly ControlEvent[], asOf: string): ReadonlySet<string> {
  const { intervals, from } = events.reduce(scanControl, NO_PAUSE);
  const closed = from === undefined ? intervals : [...intervals, { from, through: asOf }];
  return new Set(closed.flatMap((interval) => datesFrom(interval.from, interval.through)));
}

interface PauseInterval {
  readonly from: string;
  readonly through: string;
}

interface PauseScan {
  readonly intervals: readonly PauseInterval[];
  readonly from: string | undefined;
}

const NO_PAUSE: PauseScan = { intervals: [], from: undefined };

function scanControl(scan: PauseScan, event: ControlEvent): PauseScan {
  const date = event.set_at.slice(0, 10);
  if (event.action !== 'resume') return { intervals: scan.intervals, from: scan.from ?? date };
  if (scan.from === undefined) return scan;
  return { intervals: [...scan.intervals, { from: scan.from, through: date }], from: undefined };
}

const DAYS_PER_WEEK = 7;

export function countedFaultFreeDays(
  since: string | undefined,
  asOf: string,
  paused: ReadonlySet<string>,
): number {
  if (since === undefined) return 0;
  return datesFrom(since, asOf).filter((date) => !paused.has(date)).length;
}

export class FaultLedger implements FaultSink {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly logger?: Logger | undefined,
  ) {}

  // A fault write sits on the exit and resting-stop paths, so it must never throw into them
  record(fault: Fault): void {
    try {
      this.db
        .prepare(
          `INSERT INTO v2_faults (kind, trading_date, code, detail, recorded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (kind, trading_date, code, detail) DO NOTHING`,
        )
        .run(
          fault.kind,
          fault.trading_date,
          fault.code,
          fault.detail,
          toStoredTimestamp(this.clock.now()),
        );
    } catch (error) {
      this.#logUnrecorded(fault.trading_date, `${fault.kind} ${fault.code}`, error);
    }
  }

  // Runs ahead of the cycle's exits, so it must never throw into them either
  recordMissedRuns(
    lastMarked: () => string | undefined,
    today: string,
    isSkippedDay: (date: string) => boolean,
  ): void {
    try {
      for (const date of missedRunDates(lastMarked(), today, isSkippedDay)) {
        this.record({
          kind: 'missed_run',
          trading_date: date,
          code: 'CYCLE_NOT_RUN',
          detail: `no cycle marked ${date}; the next ran ${today}`,
        });
      }
    } catch (error) {
      this.#logUnrecorded(today, 'missed_run CYCLE_NOT_RUN', error);
    }
  }

  #logUnrecorded(tradingDate: string, what: string, error: unknown): void {
    this.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'error',
      event: 'v2_fault_record_failed',
      message: `${what} not recorded: ${describeThrownSafely(error)}`,
    });
  }

  faultsOn(tradingDate: string): readonly Fault[] {
    return this.db
      .prepare(
        `SELECT kind, trading_date, code, detail FROM v2_faults WHERE trading_date = ?
         ORDER BY fault_id`,
      )
      .all(tradingDate) as Fault[];
  }

  // By recorded_at, not trading_date: a missed run is recorded today against a past date
  kindsRecordedBetween(after: string, through: string): readonly FaultKindCount[] {
    return this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM v2_faults WHERE recorded_at > ? AND recorded_at <= ?
         GROUP BY kind ORDER BY count DESC, kind`,
      )
      .all(after, through) as FaultKindCount[];
  }

  faultFreeWeeks(asOf: string): FaultFreeWeeks {
    const lastFault = this.#lastGateFault(asOf);
    const since = lastFault === undefined ? this.#paperStart() : addDays(lastFault, 1);
    const events = this.db
      .prepare('SELECT action, set_at FROM v2_controls ORDER BY control_id')
      .all() as ControlEvent[];
    const countedDays = countedFaultFreeDays(since, asOf, pausedDates(events, asOf));
    return {
      weeks: Math.floor(countedDays / DAYS_PER_WEEK),
      counted_days: countedDays,
      since,
      last_fault: lastFault,
    };
  }

  #lastGateFault(asOf: string): string | undefined {
    const placeholders = GATE_FAULT_KINDS.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT MAX(trading_date) AS date FROM v2_faults
         WHERE trading_date <= ? AND kind IN (${placeholders})`,
      )
      .get(asOf, ...GATE_FAULT_KINDS) as { date: string | null };
    return row.date ?? undefined;
  }

  #paperStart(): string | undefined {
    const row = this.db.prepare('SELECT MIN(trading_date) AS date FROM v2_book_days').get() as {
      date: string | null;
    };
    return row.date ?? undefined;
  }
}
