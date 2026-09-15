/**
 * `SqliteAlertDeliveryLog` (#1108) — direct unit coverage over its own
 * `:memory:` DB, mirroring sqlite-audit-log.test.ts's shape
 */
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, openSharedStore } from '../../shared/store/index.js';
import {
  ALERT_DELIVERY_FAILURE_WINDOW_MS,
  type AlertDeliveryFailure,
  SqliteAlertDeliveryLog,
} from './alert-delivery-log.js';

const ASOF = new Date('2026-09-04T15:00:00Z');
const ALERT_CHAT_ID = '-100200300';
const HEARTBEAT_CHAT_ID = '-100200301';

function failure(overrides: Partial<AlertDeliveryFailure> = {}): AlertDeliveryFailure {
  return {
    chat_id: ALERT_CHAT_ID,
    method: 'sendMessage',
    body: 'Samurai TRADER DEGRADED: AAPL reported timeout on 3 consecutive tick(s).',
    error: 'Telegram Bot API transport failure: fetch failed (sendMessage)',
    timestamp: new Date('2026-09-04T14:00:00Z'),
    ...overrides,
  };
}

function makeStore(): { log: SqliteAlertDeliveryLog; db: StoreHandle } {
  const db = openSharedStore(':memory:');
  return { log: new SqliteAlertDeliveryLog(db), db };
}

describe('SqliteAlertDeliveryLog', () => {
  it('counts zero with no rows recorded', () => {
    expect(makeStore().log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(0);
  });

  it('counts one row per recordFailure() call on the same chat', () => {
    const { log } = makeStore();

    log.recordFailure(failure());
    log.recordFailure(failure());

    expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(2);
  });

  // #1108 third review pass: the CI-bot finding this closes. Heartbeat sends
  // (#342) are recorded into the same table as escalation sends — #342's
  // isolation only stops a heartbeat failure from advancing or triggering
  // the escalation-chat alert in telegram-bot-api-client.ts, it does not stop
  // the row from being written — so an unfiltered COUNT(*) would let a
  // heartbeat outage falsely degrade the "alert channel" tile. `chatId` is
  // the fix: a heartbeat-chat row must not count, an alert-chat row must
  it('excludes a non-alert (heartbeat) chat_id row from the count, and counts an alert-chat row', () => {
    const { log } = makeStore();

    log.recordFailure(failure({ chat_id: HEARTBEAT_CHAT_ID }));
    log.recordFailure(failure({ chat_id: ALERT_CHAT_ID }));

    expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(1);
    // The heartbeat row is still durably recorded — just not counted toward
    // the alert-channel tile. Same table, different chat, both rows present.
    expect(log.countFailures(ASOF, HEARTBEAT_CHAT_ID)).toBe(1);
  });

  // Pins the UPPER bound specifically — #1131 adds a lower bound alongside
  // this one, so this test alone no longer proves `countFailures` is
  // bounded at all; the window tests below pin the lower bound
  it('excludes rows recorded after asOf', () => {
    const { log } = makeStore();

    log.recordFailure(failure({ timestamp: new Date('2026-09-04T14:00:00Z') }));
    log.recordFailure(failure({ timestamp: new Date('2026-09-04T16:00:00Z') }));

    expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(1);
  });

  // #1131: the count used to have no lower bound at all, so a failure from
  // months ago counted toward "is the alert channel down" forever. These pin
  // the trailing-window lower bound that fixes that — mutate the bound away
  // (drop the `timestamp > ?` clause) and the first assertion here goes red
  describe('windowing (#1131)', () => {
    it('excludes a row older than the trailing window', () => {
      const { log } = makeStore();
      const justOutside = new Date(ASOF.getTime() - ALERT_DELIVERY_FAILURE_WINDOW_MS - 1);

      log.recordFailure(failure({ timestamp: justOutside }));

      expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(0);
    });

    it('includes a row just inside the trailing window', () => {
      const { log } = makeStore();
      const justInside = new Date(ASOF.getTime() - ALERT_DELIVERY_FAILURE_WINDOW_MS + 1);

      log.recordFailure(failure({ timestamp: justInside }));

      expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(1);
    });

    // #1313: the two cases above sit one millisecond either side of the edge,
    // so neither says what happens AT it. Mutating `timestamp > ?` to
    // `timestamp >= ?` left all of them green. These two pin both ends of the
    // half-open window `countFailures`'s doc now states
    it('excludes a row at exactly the window edge — the lower bound is exclusive', () => {
      const { log } = makeStore();
      const onTheEdge = new Date(ASOF.getTime() - ALERT_DELIVERY_FAILURE_WINDOW_MS);

      log.recordFailure(failure({ timestamp: onTheEdge }));

      expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(0);
    });

    it('includes a row recorded at exactly asOf — the upper bound is inclusive', () => {
      const { log } = makeStore();

      log.recordFailure(failure({ timestamp: ASOF }));

      expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(1);
    });

    it('self-clears: a failure ages out of the count as `asOf` advances past the window, with no delete', () => {
      const { log } = makeStore();
      const failedAt = new Date('2026-09-04T14:00:00Z');
      log.recordFailure(failure({ timestamp: failedAt }));

      const stillWithinWindow = new Date(failedAt.getTime() + ALERT_DELIVERY_FAILURE_WINDOW_MS - 1);
      const pastWindow = new Date(failedAt.getTime() + ALERT_DELIVERY_FAILURE_WINDOW_MS + 1);

      expect(log.countFailures(stillWithinWindow, ALERT_CHAT_ID)).toBe(1);
      expect(log.countFailures(pastWindow, ALERT_CHAT_ID)).toBe(0);
    });
  });

  it('answers the count of the 2026-09-04 session-style burst — ten failed sends', () => {
    const { log } = makeStore();

    // `Date.UTC(...)`, not `new Date(2026, 8, ...)` (#1108 third review pass):
    // the latter is HOST-LOCAL time, while `ASOF` above is a fixed UTC
    // instant — on any machine west of UTC-1 (US timezones, say) `new
    // Date(2026, 8, 4, 14, i)` lands after `ASOF` and every row here would be
    // silently excluded, failing this assertion only on CI/dev machines set
    // to those zones. Every other timestamp in this file is already an ISO
    // string for the same reason
    for (let i = 0; i < 10; i++) {
      log.recordFailure(
        failure({ body: `alert #${i}`, timestamp: new Date(Date.UTC(2026, 8, 4, 14, i)) }),
      );
    }

    expect(log.countFailures(ASOF, ALERT_CHAT_ID)).toBe(10);
  });

  it('masks a bot-token-shaped string in body/error before it reaches the table (#1108 finding 6)', () => {
    const { log, db } = makeStore();
    log.recordFailure(
      failure({
        body: 'posting to https://api.telegram.org/bot123456789:AAFakeTokenValueHere/sendMessage',
        error:
          'TypeError: Failed to parse URL from ' +
          'https://api.telegram.org/bot123456789:AAFakeTokenValueHere/sendMessage',
      }),
    );

    const [row] = db.prepare('SELECT body, error FROM alert_delivery_failures').all() as Array<{
      body: string;
      error: string;
    }>;
    expect(row?.body).not.toContain('AAFakeTokenValueHere');
    expect(row?.error).not.toContain('AAFakeTokenValueHere');
    expect(row?.body).toContain('[REDACTED]');
    expect(row?.error).toContain('[REDACTED]');
  });

  // #1108 finding 4: the deleted round-trip test left nothing pinning that
  // each column lands in the right place. Every field below is a DISTINCT
  // value, so a body/error (or method) transposition in the INSERT's
  // parameter order fails this even though every other test in the file
  // would still pass (the finding-6/blocker tests above both seed body AND
  // error with token-bearing text, which can't detect a swap)
  it('round-trips every column to a distinct value, catching a body/error/method transposition', () => {
    const { log, db } = makeStore();
    const entry: AlertDeliveryFailure = {
      chat_id: '-100999888',
      method: 'sendDocument',
      body: 'ROUND-TRIP-BODY-MARKER: TSLA entry filled',
      error: 'ROUND-TRIP-ERROR-MARKER: fetch failed',
      timestamp: new Date('2026-09-04T13:30:00Z'),
    };

    log.recordFailure(entry);

    const [row] = db
      .prepare('SELECT chat_id, method, body, error, timestamp FROM alert_delivery_failures')
      .all() as Array<{
      chat_id: string;
      method: string;
      body: string;
      error: string;
      timestamp: string;
    }>;
    expect(row?.chat_id).toBe(entry.chat_id);
    expect(row?.method).toBe(entry.method);
    expect(row?.body).toBe(entry.body);
    expect(row?.error).toBe(entry.error);
    expect(fromStoredTimestamp(row?.timestamp ?? '')).toEqual(entry.timestamp);
  });

  // #1131: mirrors mi-archive-store.test.ts's coverage of
  // `MiArchiveStore.purgeOlderThan`, the pattern this method copies
  describe('pruneOlderThan (#1131)', () => {
    it('deletes rows strictly older than cutoff and returns the count removed', () => {
      const { log, db } = makeStore();
      log.recordFailure(failure({ timestamp: new Date('2026-08-01T00:00:00.000Z') }));
      log.recordFailure(failure({ timestamp: new Date('2026-08-02T00:00:00.000Z') }));
      log.recordFailure(failure({ timestamp: new Date('2026-09-04T00:00:00.000Z') }));

      const removed = log.pruneOlderThan(new Date('2026-08-15T00:00:00.000Z'));

      expect(removed).toBe(2);
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM alert_delivery_failures').get() as {
        n: number;
      };
      expect(remaining.n).toBe(1);
    });

    it('keeps a row exactly at cutoff (strictly-older, not older-or-equal)', () => {
      const { log, db } = makeStore();
      const cutoff = new Date('2026-08-15T00:00:00.000Z');
      log.recordFailure(failure({ timestamp: cutoff }));

      const removed = log.pruneOlderThan(cutoff);

      expect(removed).toBe(0);
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM alert_delivery_failures').get() as {
        n: number;
      };
      expect(remaining.n).toBe(1);
    });

    it('is a no-op returning 0 on an empty table', () => {
      const { log } = makeStore();
      expect(log.pruneOlderThan(new Date('2026-09-04T00:00:00.000Z'))).toBe(0);
    });
  });
});
