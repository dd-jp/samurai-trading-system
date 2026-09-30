import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
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
  db = openSharedStore(':memory:');
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
