import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardedStore, type StoreHandle } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { parseSignalPayload, type SignalPayload } from './payload.js';
import { payloadDigest, SIGNAL_LIST_MAX, SignalStore } from './store.js';
import type { SignalWindow } from './window.js';

const RECEIVED = new Date('2026-09-30T12:00:00.000Z');
const OPEN = new Date('2026-09-30T13:30:00.000Z');
const QUEUED: SignalWindow = { session: 'out_of_session', processAfter: OPEN };

function payload(value: Record<string, unknown>): SignalPayload {
  const parsed = parseSignalPayload({
    symbol: 'INTC',
    entry: 24.5,
    targets: [26, 28],
    stop: 23,
    ...value,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.payload;
}

let db: StoreHandle;
let now: Date;
let store: SignalStore;

beforeEach(() => {
  db = migratedMemoryStore();
  now = new Date('2026-09-30T12:00:01.000Z');
  store = new SignalStore(guardedStore(db, 'v2', { enabled: true }), { now: () => now });
});

afterEach(() => db.close());

describe('SignalStore.record', () => {
  it('stores a new signal with a queued event', () => {
    const { signal, replayed } = store.record(
      payload({
        size: 0.5,
        trail_after: 27,
        source: 'desk',
        received_at: '2026-09-30T07:59:00-04:00',
      }),
      RECEIVED,
      QUEUED,
    );
    expect(replayed).toBe(false);
    expect(signal).toMatchObject({
      symbol: 'INTC',
      entry: 24.5,
      targets: [26, 28],
      stop: 23,
      size: 0.5,
      trail_after: 27,
      source: 'desk',
      sent_at: '2026-09-30T11:59:00.000Z',
      received_at: '2026-09-30T12:00:00.000Z',
      session: 'out_of_session',
      process_after: '2026-09-30T13:30:00.000Z',
      status: 'queued',
      events: [
        {
          status: 'queued',
          detail: 'out_of_session: process after 2026-09-30T13:30:00.000Z',
          recorded_at: '2026-09-30T12:00:01.000Z',
        },
      ],
    });
    expect(signal.signal_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns optional fields as null and a zone as [low, high]', () => {
    const { signal } = store.record(payload({ entry: [24, 25] }), RECEIVED, QUEUED);
    expect(signal).toMatchObject({
      entry: [24, 25],
      size: null,
      trail_after: null,
      source: null,
      sent_at: null,
    });
  });

  it('replays the stored signal for the same payload on the same day', () => {
    const first = store.record(payload({}), RECEIVED, QUEUED);
    const again = store.record(payload({}), new Date('2026-09-30T19:00:00.000Z'), {
      session: 'in_session',
      processAfter: new Date('2026-09-30T19:00:00.000Z'),
    });
    expect(again).toEqual({ signal: first.signal, replayed: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_signal_events').get()).toEqual({ n: 1 });
  });

  it('stores the same unstamped payload again on a later day', () => {
    const first = store.record(payload({}), RECEIVED, QUEUED);
    const later = store.record(payload({}), new Date('2026-10-01T12:00:00.000Z'), QUEUED);
    expect(later.replayed).toBe(false);
    expect(later.signal.signal_id).not.toBe(first.signal.signal_id);
  });

  it('stores a payload whose sender stamp differs as a new signal', () => {
    store.record(payload({ received_at: '2026-09-30T11:00:00Z' }), RECEIVED, QUEUED);
    expect(
      store.record(payload({ received_at: '2026-09-30T11:01:00Z' }), RECEIVED, QUEUED).replayed,
    ).toBe(false);
  });
});

describe('payloadDigest', () => {
  it('keys an unstamped payload on the UTC receipt date', () => {
    const p = payload({});
    expect(payloadDigest(p, RECEIVED)).toBe(payloadDigest(p, new Date('2026-09-30T23:59:59.000Z')));
    expect(payloadDigest(p, RECEIVED)).not.toBe(
      payloadDigest(p, new Date('2026-10-01T00:00:00.000Z')),
    );
  });

  it('keys a stamped payload on its stamp, not the receipt date', () => {
    const p = payload({ received_at: '2026-09-30T11:00:00Z' });
    expect(payloadDigest(p, RECEIVED)).toBe(payloadDigest(p, new Date('2026-10-02T00:00:00.000Z')));
  });
});

describe('SignalStore events', () => {
  it('reports the latest event as the status', () => {
    const { signal } = store.record(payload({}), RECEIVED, QUEUED);
    now = new Date('2026-09-30T13:30:05.000Z');
    store.appendEvent(signal.signal_id, 'refused', 'not_us_equity_universe');
    const read = store.get(signal.signal_id);
    expect(read?.status).toBe('refused');
    expect(read?.events.map((event) => event.status)).toEqual(['queued', 'refused']);
    expect(read?.events[1]).toEqual({
      status: 'refused',
      detail: 'not_us_equity_universe',
      recorded_at: '2026-09-30T13:30:05.000Z',
    });
  });

  it('returns undefined for an unknown id', () => {
    expect(store.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('SignalStore.list', () => {
  it('lists newest first and honours the limit', () => {
    const symbols = ['AAA', 'BBB', 'CCC'];
    for (const [index, symbol] of symbols.entries()) {
      store.record(payload({ symbol }), new Date(RECEIVED.getTime() + index * 1_000), QUEUED);
    }
    expect(store.list(10).map((signal) => signal.symbol)).toEqual(['CCC', 'BBB', 'AAA']);
    expect(store.list(2).map((signal) => signal.symbol)).toEqual(['CCC', 'BBB']);
  });

  it(`never returns more than ${SIGNAL_LIST_MAX} rows`, () => {
    for (let index = 0; index <= SIGNAL_LIST_MAX; index++) {
      store.record(payload({ stop: 1 + index / 1_000 }), RECEIVED, QUEUED);
    }
    expect(store.list(SIGNAL_LIST_MAX + 50)).toHaveLength(SIGNAL_LIST_MAX);
  });
});

describe('SignalStore.due', () => {
  it('returns queued signals whose process time has come, oldest first', () => {
    const later = store.record(payload({ symbol: 'AMD' }), RECEIVED, {
      session: 'out_of_session',
      processAfter: new Date('2026-09-30T13:31:00.000Z'),
    }).signal;
    const first = store.record(payload({}), RECEIVED, QUEUED).signal;
    const done = store.record(payload({ symbol: 'NVDA' }), RECEIVED, QUEUED).signal;
    store.appendEvent(done.signal_id, 'processed', 'submitted');
    const notYet = store.record(payload({ symbol: 'MU' }), RECEIVED, {
      session: 'out_of_session',
      processAfter: new Date('2026-10-01T13:30:00.000Z'),
    }).signal;

    expect(store.due(new Date('2026-09-30T13:29:59.999Z'))).toEqual([]);
    expect(store.due(OPEN).map((signal) => signal.signal_id)).toEqual([first.signal_id]);
    const due = store.due(new Date('2026-09-30T20:00:00.000Z')).map((s) => s.signal_id);
    expect(due).toEqual([first.signal_id, later.signal_id]);
    expect(due).not.toContain(notYet.signal_id);
  });

  it('keeps a failed signal due so a later pass retries it (David 2026-10-05, #2024)', () => {
    const failed = store.record(payload({}), RECEIVED, QUEUED).signal;
    store.appendEvent(failed.signal_id, 'failed', 'disk full');
    const refused = store.record(payload({ symbol: 'AMD' }), RECEIVED, QUEUED).signal;
    store.appendEvent(refused.signal_id, 'failed', 'disk full');
    store.appendEvent(refused.signal_id, 'refused', 'dropped: window ended');

    expect(store.due(OPEN).map((signal) => signal.signal_id)).toEqual([failed.signal_id]);
  });
});

describe('SignalStore.vetoVerdicts', () => {
  it('reads the newest processed verdicts first, skipping unavailable and other details', () => {
    const details = [
      'veto pass: fine; entries 1',
      'veto veto: stop in noise; entries 1',
      'veto unavailable: llm_spend_cap:monthly; entries 1',
      'already_submitted: an entry order for this signal exists',
      'veto pass: fine again; entries 1',
    ];
    for (const [index, detail] of details.entries()) {
      const { signal } = store.record(payload({ symbol: `A${'BCDEF'[index]}` }), RECEIVED, QUEUED);
      store.appendEvent(signal.signal_id, 'processed', detail);
    }
    const refused = store.record(payload({ symbol: 'ZZ' }), RECEIVED, QUEUED).signal;
    store.appendEvent(refused.signal_id, 'refused', 'veto veto: not a processed event');

    expect(store.vetoVerdicts(20)).toEqual(['pass', 'veto', 'pass']);
    expect(store.vetoVerdicts(2)).toEqual(['pass', 'veto']);
  });
});

describe('SignalStore veto journal (#2024)', () => {
  it('reads back the one verdict journalled for a signal and refuses a second', () => {
    const { signal } = store.record(payload({}), RECEIVED, QUEUED);
    const other = store.record(payload({ symbol: 'AMD' }), RECEIVED, QUEUED).signal;
    expect(store.vetoFor(signal.signal_id)).toBeUndefined();

    store.recordVeto(signal.signal_id, { kind: 'veto', reason: 'stop in noise' });

    expect(store.vetoFor(signal.signal_id)).toEqual({ kind: 'veto', reason: 'stop in noise' });
    expect(store.vetoFor(other.signal_id)).toBeUndefined();
    expect(db.prepare('SELECT recorded_at FROM v2_signal_vetoes').get()).toEqual({
      recorded_at: '2026-09-30T12:00:01.000Z',
    });
    expect(() => store.recordVeto(signal.signal_id, { kind: 'pass', reason: 'rewritten' })).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("UPDATE v2_signal_vetoes SET kind = 'pass'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_signal_vetoes').run()).toThrow(/append-only/);
  });
});

describe('SignalStore veto retry journal (David 2026-10-09, #2024)', () => {
  it('reads unclaimed, then claimed without a verdict, then the verdict, refusing a second of each', () => {
    const { signal } = store.record(payload({}), RECEIVED, QUEUED);
    const id = signal.signal_id;
    store.recordVeto(id, { kind: 'unavailable', reason: 'llm_call_failed: timeout' });
    expect(store.vetoRetry(id)).toEqual({ claimed: false, veto: undefined });

    store.claimVetoRetry(id);
    expect(store.vetoRetry(id)).toEqual({ claimed: true, veto: undefined });
    expect(() => store.claimVetoRetry(id)).toThrow(/append-only/);

    now = new Date('2026-09-30T12:00:31.000Z');
    store.recordRetryVeto(id, { kind: 'pass', reason: 'fine' });
    expect(store.vetoRetry(id)).toEqual({ claimed: true, veto: { kind: 'pass', reason: 'fine' } });
    expect(db.prepare('SELECT claimed_at FROM v2_signal_veto_retries').get()).toEqual({
      claimed_at: '2026-09-30T12:00:01.000Z',
    });
    expect(db.prepare('SELECT recorded_at FROM v2_signal_veto_retry_verdicts').get()).toEqual({
      recorded_at: '2026-09-30T12:00:31.000Z',
    });
    expect(() => store.recordRetryVeto(id, { kind: 'veto', reason: 'rewritten' })).toThrow(
      /append-only/,
    );
    for (const table of ['v2_signal_veto_retries', 'v2_signal_veto_retry_verdicts']) {
      expect(() => db.prepare(`UPDATE ${table} SET signal_id = 'x'`).run()).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
    }
  });

  it('refuses a retry verdict without a claim, and a claim without a first verdict', () => {
    const { signal } = store.record(payload({}), RECEIVED, QUEUED);
    expect(() => store.claimVetoRetry(signal.signal_id)).toThrow(/FOREIGN KEY/);
    store.recordVeto(signal.signal_id, { kind: 'unavailable', reason: 'llm_call_failed: x' });
    expect(() => store.recordRetryVeto(signal.signal_id, { kind: 'pass', reason: 'y' })).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('v2_signals append-only', () => {
  it('refuses updates and deletes on both tables', () => {
    store.record(payload({}), RECEIVED, QUEUED);
    expect(() => db.prepare("UPDATE v2_signals SET symbol = 'X'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM v2_signals').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE v2_signal_events SET detail = 'x'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_signal_events').run()).toThrow(/append-only/);
  });

  it('refuses an event for an unknown status', () => {
    const { signal } = store.record(payload({}), RECEIVED, QUEUED);
    expect(() => store.appendEvent(signal.signal_id, 'cancelled' as never, 'not a status')).toThrow(
      /CHECK/,
    );
  });
});
