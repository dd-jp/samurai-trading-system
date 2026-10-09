import { randomUUID } from 'node:crypto';
import type { SignalEventWire, SignalStatusWire, SignalWire } from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import { digest } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';
import type { SignalPayload } from './payload.js';
import type { SignalVeto } from './veto.js';
import type { SignalWindow } from './window.js';

export const SIGNAL_LIST_MAX = 200;

export type SignalVetoVerdict = 'pass' | 'veto';

export interface SignalVetoRetry {
  readonly claimed: boolean;
  readonly veto: SignalVeto | undefined;
}

interface SignalRow {
  signal_id: string;
  symbol: string;
  entry_low: number;
  entry_high: number;
  entry_is_zone: number;
  targets: string;
  stop: number;
  size: number | null;
  trail_after: number | null;
  source: string | null;
  sent_at: string | null;
  received_at: string;
  session: SignalWire['session'];
  process_after: string;
}

const SIGNAL_COLUMNS = `signal_id, symbol, entry_low, entry_high, entry_is_zone, targets, stop, size,
  trail_after, source, sent_at, received_at, session, process_after`;

export interface RecordedSignal {
  readonly signal: SignalWire;
  readonly replayed: boolean;
}

export function payloadDigest(payload: SignalPayload, receivedAt: Date): string {
  return digest({ ...payload, sentAt: payload.sentAt ?? receivedAt.toISOString().slice(0, 10) });
}

export class SignalStore {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  record(payload: SignalPayload, receivedAt: Date, window: SignalWindow): RecordedSignal {
    const key = payloadDigest(payload, receivedAt);
    const existing = this.#idForDigest(key);
    if (existing !== undefined) return { signal: this.#wireFor(existing), replayed: true };
    const signalId = randomUUID();
    const processAfter = toStoredTimestamp(window.processAfter);
    this.db.transaction(() => {
      this.#insert(signalId, key, payload, receivedAt, window);
      this.appendEvent(signalId, 'queued', `${window.session}: process after ${processAfter}`);
    })();
    return { signal: this.#wireFor(signalId), replayed: false };
  }

  appendEvent(signalId: string, status: SignalStatusWire, detail: string): void {
    this.db
      .prepare(
        `INSERT INTO v2_signal_events (signal_id, status, detail, recorded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(signalId, status, detail, toStoredTimestamp(this.clock.now()));
  }

  get(signalId: string): SignalWire | undefined {
    return this.#row(signalId) === undefined ? undefined : this.#wireFor(signalId);
  }

  list(limit: number): readonly SignalWire[] {
    const rows = this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM v2_signals
         ORDER BY received_at DESC, signal_id DESC LIMIT ?`,
      )
      .all(Math.min(limit, SIGNAL_LIST_MAX)) as SignalRow[];
    return rows.map((row) => this.#toWire(row));
  }

  due(now: Date): readonly SignalWire[] {
    const rows = this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM v2_signals s
         WHERE process_after <= ?
           AND (SELECT status FROM v2_signal_events e WHERE e.signal_id = s.signal_id
                ORDER BY event_id DESC LIMIT 1) IN ('queued', 'failed')
         ORDER BY process_after, received_at, signal_id`,
      )
      .all(toStoredTimestamp(now)) as SignalRow[];
    return rows.map((row) => this.#toWire(row));
  }

  vetoVerdicts(limit: number): readonly SignalVetoVerdict[] {
    const rows = this.db
      .prepare(
        `SELECT substr(detail, 6, 4) AS verdict FROM v2_signal_events
         WHERE status = 'processed' AND (detail LIKE 'veto pass: %' OR detail LIKE 'veto veto: %')
         ORDER BY event_id DESC LIMIT ?`,
      )
      .all(limit) as { verdict: SignalVetoVerdict }[];
    return rows.map((row) => row.verdict);
  }

  recordVeto(signalId: string, veto: SignalVeto): void {
    this.#insertVeto('v2_signal_vetoes', signalId, veto);
  }

  vetoFor(signalId: string): SignalVeto | undefined {
    return this.db
      .prepare('SELECT kind, reason FROM v2_signal_vetoes WHERE signal_id = ?')
      .get(signalId) as SignalVeto | undefined;
  }

  claimVetoRetry(signalId: string): void {
    this.db
      .prepare('INSERT INTO v2_signal_veto_retries (signal_id, claimed_at) VALUES (?, ?)')
      .run(signalId, toStoredTimestamp(this.clock.now()));
  }

  recordRetryVeto(signalId: string, veto: SignalVeto): void {
    this.#insertVeto('v2_signal_veto_retry_verdicts', signalId, veto);
  }

  vetoRetry(signalId: string): SignalVetoRetry {
    const row = this.db
      .prepare(
        `SELECT v.kind, v.reason FROM v2_signal_veto_retries r
         LEFT JOIN v2_signal_veto_retry_verdicts v ON v.signal_id = r.signal_id
         WHERE r.signal_id = ?`,
      )
      .get(signalId) as { kind: SignalVeto['kind'] | null; reason: string | null } | undefined;
    if (row === undefined) return { claimed: false, veto: undefined };
    if (row.kind === null) return { claimed: true, veto: undefined };
    return { claimed: true, veto: { kind: row.kind, reason: row.reason as string } };
  }

  #insertVeto(
    table: 'v2_signal_vetoes' | 'v2_signal_veto_retry_verdicts',
    signalId: string,
    veto: SignalVeto,
  ): void {
    this.db
      .prepare(`INSERT INTO ${table} (signal_id, kind, reason, recorded_at) VALUES (?, ?, ?, ?)`)
      .run(signalId, veto.kind, veto.reason, toStoredTimestamp(this.clock.now()));
  }

  #idForDigest(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT signal_id FROM v2_signals WHERE payload_digest = ?')
      .get(key) as { signal_id: string } | undefined;
    return row?.signal_id;
  }

  #insert(
    signalId: string,
    key: string,
    payload: SignalPayload,
    receivedAt: Date,
    window: SignalWindow,
  ): void {
    this.db
      .prepare(
        `INSERT INTO v2_signals (signal_id, payload_digest, symbol, entry_low, entry_high,
           entry_is_zone, targets, stop, size, trail_after, source, sent_at, received_at, session,
           process_after, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signalId,
        key,
        payload.symbol,
        payload.entryLow,
        payload.entryHigh,
        payload.entryIsZone ? 1 : 0,
        JSON.stringify(payload.targets),
        payload.stop,
        payload.size ?? null,
        payload.trailAfter ?? null,
        payload.source ?? null,
        payload.sentAt ?? null,
        toStoredTimestamp(receivedAt),
        window.session,
        toStoredTimestamp(window.processAfter),
        JSON.stringify(payload),
      );
  }

  #row(signalId: string): SignalRow | undefined {
    return this.db
      .prepare(`SELECT ${SIGNAL_COLUMNS} FROM v2_signals WHERE signal_id = ?`)
      .get(signalId) as SignalRow | undefined;
  }

  #wireFor(signalId: string): SignalWire {
    const row = this.#row(signalId);
    if (row === undefined) throw new Error(`SignalStore: no signal ${signalId}`);
    return this.#toWire(row);
  }

  #events(signalId: string): SignalEventWire[] {
    return this.db
      .prepare(
        `SELECT status, detail, recorded_at FROM v2_signal_events
         WHERE signal_id = ? ORDER BY event_id`,
      )
      .all(signalId) as SignalEventWire[];
  }

  #toWire(row: SignalRow): SignalWire {
    const events = this.#events(row.signal_id);
    return {
      signal_id: row.signal_id,
      symbol: row.symbol,
      entry: row.entry_is_zone === 1 ? [row.entry_low, row.entry_high] : row.entry_low,
      targets: JSON.parse(row.targets) as number[],
      stop: row.stop,
      size: row.size,
      trail_after: row.trail_after,
      source: row.source,
      sent_at: row.sent_at,
      received_at: row.received_at,
      session: row.session,
      process_after: row.process_after,
      status: events.at(-1)?.status ?? 'queued',
      events,
    };
  }
}
