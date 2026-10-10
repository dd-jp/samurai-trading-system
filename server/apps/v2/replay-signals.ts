import type { LatestQuote, LatestQuoteSource, SignalWire } from '../../../contracts/index.js';
import type { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import type { CycleComposition } from './compose.js';
import {
  type BookDivergence,
  type Row,
  type RowStage,
  reopenedSql,
  tableDivergences,
} from './replay-book.js';
import { SIGNALS_SLEEVE_ID } from './signal/index.js';
import { processSignal, type SignalProcessorDeps, sessionDate } from './signals/processor.js';
import { SignalStore } from './signals/store.js';
import { INTERRUPTED_VETO, type SignalVeto, type SignalVetoCall } from './signals/veto.js';

export interface SettledSignal {
  readonly signal_id: string;
  readonly status: string;
  readonly detail: string;
  readonly recorded_at: string;
}

export type SignalsNotReplayed = {
  readonly kind: 'signals_not_replayed';
  readonly tradingDate: string;
  readonly reason: 'unmarked' | 'before_mark';
  readonly events: number;
};

export interface SignalsReplay {
  readonly journal: StoreHandle;
  readonly copy: StoreHandle;
  readonly cycle: CycleComposition;
  readonly clock: SimulatedClock;
  readonly tradingDate: string;
  readonly markedAt: string;
  readonly startedAt: string;
  readonly constituents: (tradingDate: string) => readonly string[];
  readonly dryRun: boolean;
}

const SETTLED_SQL = `
  SELECT signal_id, status, detail, recorded_at FROM v2_signal_events
   WHERE status <> 'queued' AND recorded_at >= ? ORDER BY event_id`;

export function settledSignals(db: StoreHandle, tradingDate: string): SettledSignal[] {
  const rows = db.prepare(SETTLED_SQL).all(`${tradingDate}T00:00:00.000Z`) as SettledSignal[];
  return rows.filter((row) => sessionDate(new Date(row.recorded_at)) === tradingDate);
}

// A pass's own instant is not journalled, nor which signals it took, so a day replays only when
// every signal event follows the cycle's mark; one before it is flagged, not replayed
export function signalsGuard(
  events: readonly SettledSignal[],
  tradingDate: string,
  markedAt: string | undefined,
): SignalsNotReplayed | undefined {
  if (events.length === 0) return undefined;
  const reason =
    markedAt === undefined
      ? 'unmarked'
      : events.some((event) => event.recorded_at <= markedAt)
        ? 'before_mark'
        : undefined;
  return reason === undefined
    ? undefined
    : { kind: 'signals_not_replayed', tradingDate, reason, events: events.length };
}

const VETO_TABLES = { 1: 'v2_signal_vetoes', 2: 'v2_signal_veto_retry_verdicts' } as const;

// David 2026-10-10 (#2096): a verdict journalled after the pass settled was not the pass's own, so
// a live pass that failed before its veto diverges instead of replaying identical
export function journalledVeto(journal: StoreHandle, settledAt: string): SignalVetoCall {
  return (signalId, attempt) => {
    const row = journal
      .prepare(
        `SELECT kind, reason FROM ${VETO_TABLES[attempt]} WHERE signal_id = ? AND recorded_at <= ?`,
      )
      .get(signalId, settledAt) as SignalVeto | undefined;
    if (row === undefined) {
      return Promise.reject(
        new Error(
          `replay: no journalled attempt ${attempt} veto verdict for signal ${signalId} by ${settledAt}, and the replay makes no LLM call`,
        ),
      );
    }
    const interrupted = row.kind === 'unavailable' && row.reason === INTERRUPTED_VETO.reason;
    return Promise.resolve(interrupted ? INTERRUPTED_VETO : row);
  };
}

const QUOTE_SQL = `
  SELECT json_extract(d.payload, '$.entry_quote') AS quote
    FROM v2_decisions d JOIN v2_books b ON b.book_id = d.book_id
   WHERE b.sleeve_id = @sleeve AND d.trading_date = @date
     AND json_extract(d.payload, '$.signal_id') = @signal
     AND json_extract(d.payload, '$.entry_quote') IS NOT NULL
     AND d.recorded_at > @since AND d.recorded_at <= @until
   ORDER BY d.rowid LIMIT 1`;

// The quote a pass read is journalled on its decisions; a pass that failed before any decision
// left only its error, which the read re-raises
export function journalledQuotes(
  journal: StoreHandle,
  tradingDate: string,
  settled: SettledSignal,
  since: string,
): LatestQuoteSource {
  return {
    latestQuote: (symbol) => {
      const row = journal.prepare(QUOTE_SQL).get({
        sleeve: SIGNALS_SLEEVE_ID,
        date: tradingDate,
        signal: settled.signal_id,
        since,
        until: settled.recorded_at,
      }) as { quote: string } | undefined;
      if (row !== undefined) {
        const { ask, bid, quoted_at } = JSON.parse(row.quote) as LatestQuote;
        return Promise.resolve({ ask, bid, quoted_at });
      }
      const detail =
        settled.status === 'failed'
          ? settled.detail
          : `replay: no journalled ${symbol} quote for signal ${settled.signal_id} by ${settled.recorded_at}`;
      return Promise.reject(new Error(detail));
    },
  };
}

function restoreControls(replay: SignalsReplay, after: string, until: string): void {
  const rows = replay.journal
    .prepare(
      `SELECT control_id, action, reason, source, idempotency_key, set_at FROM v2_controls
        WHERE set_at > ? AND set_at <= ? ORDER BY control_id`,
    )
    .all(after, until);
  const insert = replay.copy.prepare(
    `INSERT INTO v2_controls (control_id, action, reason, source, idempotency_key, set_at)
     VALUES (@control_id, @action, @reason, @source, @idempotency_key, @set_at)`,
  );
  for (const row of rows) insert.run(row);
}

const QUOTED_DAY_SQL = `
  SELECT 1 FROM v2_decisions d JOIN v2_books b ON b.book_id = d.book_id
   WHERE b.sleeve_id = ? AND d.trading_date = ?
     AND json_extract(d.payload, '$.entry_quote') IS NOT NULL LIMIT 1`;

// A dry run reads quotes only when a quote source is injected, which its decisions then carry
function quoted(replay: SignalsReplay): boolean {
  if (!replay.dryRun) return true;
  return (
    replay.journal.prepare(QUOTED_DAY_SQL).get(SIGNALS_SLEEVE_ID, replay.tradingDate) !== undefined
  );
}

function depsFor(
  replay: SignalsReplay,
  store: SignalStore,
  quotes: LatestQuoteSource | undefined,
  settledAt: string,
): SignalProcessorDeps {
  const { cycle } = replay;
  return {
    cycle,
    latestReconcile: (date, venue) => cycle.journal.latestReconcile(date, venue),
    signals: store,
    faults: cycle.faults,
    veto: journalledVeto(replay.journal, settledAt),
    constituents: replay.constituents,
    calendar: { isOpen: () => true },
    quotes,
  };
}

function stepTo(replay: SignalsReplay, event: SettledSignal, restoredTo: string): string {
  const at = new Date(event.recorded_at);
  if (at > replay.clock.now()) replay.clock.advanceTo(at);
  if (event.recorded_at <= restoredTo) return restoredTo;
  restoreControls(replay, restoredTo, event.recorded_at);
  return event.recorded_at;
}

function signalOf(store: SignalStore, signalId: string): SignalWire {
  const signal = store.get(signalId);
  if (signal === undefined) throw new Error(`replay: no signal ${signalId}`);
  return signal;
}

export async function replaySignals(
  replay: SignalsReplay,
  events: readonly SettledSignal[],
): Promise<void> {
  const { journal, tradingDate } = replay;
  const store = new SignalStore(replay.copy, replay.clock);
  const settledAt = new Map<string, string>();
  const withQuotes = quoted(replay);
  let restoredTo = replay.startedAt;
  for (const event of events) {
    restoredTo = stepTo(replay, event, restoredTo);
    const since = settledAt.get(event.signal_id) ?? '';
    const quotes = withQuotes ? journalledQuotes(journal, tradingDate, event, since) : undefined;
    await processSignal(
      depsFor(replay, store, quotes, event.recorded_at),
      signalOf(store, event.signal_id),
      tradingDate,
    );
    settledAt.set(event.signal_id, event.recorded_at);
  }
}

interface SignalRows extends RowStage {
  readonly rows: (db: StoreHandle, window: RowWindow) => Row[];
}

interface RowWindow {
  readonly date: string;
  readonly mark: string;
  readonly ids: string;
  readonly until: string;
}

function numbered(rows: readonly Row[]): Row[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const nth = (seen.get(row.key) ?? 0) + 1;
    seen.set(row.key, nth);
    return { ...row, key: `${row.key}#${nth}` };
  });
}

function query(sql: string): (db: StoreHandle, window: RowWindow) => Row[] {
  return (db, window) => numbered(db.prepare(sql).all(window) as Row[]);
}

const SIGNALS_BOOKS = `SELECT book_id FROM v2_books WHERE sleeve_id = '${SIGNALS_SLEEVE_ID}'`;
const REOPENED = reopenedSql('>');

const SIGNAL_ROWS: readonly SignalRows[] = [
  {
    stage: 'signal_events',
    presence: true,
    rows: (db, window) =>
      numbered(
        settledSignals(db, window.date)
          .filter((event) => event.recorded_at > window.mark)
          .map((event) => ({ key: event.signal_id, outcome: `${event.status}: ${event.detail}` })),
      ),
  },
  {
    stage: 'signal_vetoes',
    presence: true,
    rows: query(`
      SELECT key, kind, reason FROM (
        SELECT signal_id, signal_id || '|claim ' || attempt AS key, NULL AS kind, NULL AS reason,
               claimed_at AS at FROM v2_signal_veto_claims
        UNION ALL SELECT signal_id, signal_id || '|verdict 1', kind, reason, recorded_at
          FROM v2_signal_vetoes
        UNION ALL SELECT signal_id, signal_id || '|verdict 2', kind, reason, recorded_at
          FROM v2_signal_veto_retry_verdicts)
       WHERE signal_id IN (SELECT value FROM json_each(@ids)) AND at <= @until
       ORDER BY key`),
  },
  {
    stage: 'signal_decisions',
    presence: true,
    rows: query(`
      SELECT book_id || '|' || instrument || '|' || COALESCE(json_extract(payload, '$.signal_id'), '')
               AS key,
             venue, inputs_hash, direction, confidence, action, reason, size_shares, stop_price,
             payload
        FROM v2_decisions
       WHERE trading_date = @date AND recorded_at > @mark AND book_id IN (${SIGNALS_BOOKS})
       ORDER BY rowid`),
  },
  {
    stage: 'signal_refusals',
    presence: true,
    rows: query(`
      SELECT scope || '|' || parameter || '|' || COALESCE(book_id, '-') || '|' ||
               COALESCE(instrument, '-') AS key, ticket, message
        FROM v2_refusals
       WHERE trading_date = @date AND recorded_at > @mark
         AND (scope = 'signal' OR book_id IN (${SIGNALS_BOOKS}))
       ORDER BY refusal_id`),
  },
  {
    stage: 'signal_orders',
    presence: true,
    rows: query(`
      SELECT o.client_order_id AS key,
             (SELECT d.book_id || '|' || d.instrument FROM v2_decisions d
               WHERE d.decision_id = o.decision_id) AS decision,
             o.book_id, o.instrument, o.venue, o.leg, o.side, o.dry_run,
             CASE WHEN ${REOPENED.condition} THEN ${REOPENED.outcome} ELSE o.outcome END AS outcome,
             CASE WHEN ${REOPENED.condition} THEN json_remove(o.payload, '$.cancelled')
                  ELSE o.payload END AS payload
        FROM v2_orders o JOIN v2_books b ON b.book_id = o.book_id
       WHERE o.trading_date = @date AND o.recorded_at > @mark AND o.leg = 'entry'
         AND b.sleeve_id = '${SIGNALS_SLEEVE_ID}'
       ORDER BY o.rowid`),
  },
  {
    stage: 'signal_faults',
    presence: true,
    rows: query(`
      SELECT code || '|' || detail AS key FROM v2_faults
       WHERE trading_date = @date AND kind = 'veto_rate' ORDER BY fault_id`),
  },
];

export function signalDivergences(
  replay: Pick<SignalsReplay, 'journal' | 'copy' | 'tradingDate' | 'markedAt'>,
  events: readonly SettledSignal[],
): BookDivergence[] {
  const window: RowWindow = {
    date: replay.tradingDate,
    mark: replay.markedAt,
    ids: JSON.stringify([...new Set(events.map((event) => event.signal_id))]),
    until: events.at(-1)?.recorded_at ?? replay.markedAt,
  };
  return SIGNAL_ROWS.flatMap((spec) =>
    tableDivergences(spec, spec.rows(replay.journal, window), spec.rows(replay.copy, window)),
  );
}
