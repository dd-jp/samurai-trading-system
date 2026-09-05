/**
 * `SqliteAlertDeliveryLog` (#1108) — direct unit coverage over its own
 * `:memory:` DB, mirroring sqlite-audit-log.test.ts's shape.
 */
import type { SharedStore } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import { type AlertDeliveryFailure, SqliteAlertDeliveryLog } from './alert-delivery-log.js';

const ASOF = new Date('2026-09-04T15:00:00Z');

function failure(overrides: Partial<AlertDeliveryFailure> = {}): AlertDeliveryFailure {
  return {
    chat_id: '-100200300',
    method: 'sendMessage',
    body: 'Samurai TRADER DEGRADED: AAPL reported timeout on 3 consecutive tick(s).',
    error: 'Telegram Bot API transport failure: fetch failed (sendMessage)',
    timestamp: new Date('2026-09-04T14:00:00Z'),
    ...overrides,
  };
}

function makeStore(): { log: SqliteAlertDeliveryLog; db: SharedStore } {
  const db = openSharedStore(':memory:');
  return { log: new SqliteAlertDeliveryLog(db), db };
}

describe('SqliteAlertDeliveryLog', () => {
  it('counts zero with no rows recorded', () => {
    expect(makeStore().log.countFailures(ASOF)).toBe(0);
  });

  it('counts one row per recordFailure() call', () => {
    const { log } = makeStore();

    log.recordFailure(failure());
    log.recordFailure(failure({ chat_id: '-100200301' }));

    expect(log.countFailures(ASOF)).toBe(2);
  });

  it('excludes rows recorded after asOf', () => {
    const { log } = makeStore();

    log.recordFailure(failure({ timestamp: new Date('2026-09-04T14:00:00Z') }));
    log.recordFailure(failure({ timestamp: new Date('2026-09-04T16:00:00Z') }));

    expect(log.countFailures(ASOF)).toBe(1);
  });

  it('answers the count of the 2026-09-04 session-style burst — ten failed sends', () => {
    const { log } = makeStore();

    for (let i = 0; i < 10; i++) {
      log.recordFailure(failure({ body: `alert #${i}`, timestamp: new Date(2026, 8, 4, 14, i) }));
    }

    expect(log.countFailures(ASOF)).toBe(10);
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
  // error with token-bearing text, which can't detect a swap).
  it('round-trips every column to a distinct value, catching a body/error/method transposition', () => {
    const { log, db } = makeStore();
    const entry: AlertDeliveryFailure = {
      chat_id: '-100999888',
      method: 'sendApprovalButtons',
      body: 'ROUND-TRIP-BODY-MARKER: approve TSLA entry?',
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
});
