/**
 * `SqliteAlertDeliveryLog` (#1108) — direct unit coverage over its own
 * `:memory:` DB, mirroring sqlite-audit-log.test.ts's shape.
 */
import { openSharedStore } from '../../shared/store/index.js';
import { type AlertDeliveryFailure, SqliteAlertDeliveryLog } from './alert-delivery-log.js';

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

function makeStore(): SqliteAlertDeliveryLog {
  return new SqliteAlertDeliveryLog(openSharedStore(':memory:'));
}

describe('SqliteAlertDeliveryLog', () => {
  it('counts zero with no rows recorded', () => {
    expect(makeStore().countFailures()).toBe(0);
  });

  it('counts one row per recordFailure() call', () => {
    const log = makeStore();

    log.recordFailure(failure());
    log.recordFailure(failure({ chat_id: '-100200301' }));

    expect(log.countFailures()).toBe(2);
  });

  it('answers the count of the 2026-09-04 session-style burst — ten failed sends', () => {
    const log = makeStore();

    for (let i = 0; i < 10; i++) {
      log.recordFailure(failure({ body: `alert #${i}`, timestamp: new Date(2026, 8, 4, 14, i) }));
    }

    expect(log.countFailures()).toBe(10);
  });

  it('returns recent failures newest first', () => {
    const log = makeStore();

    log.recordFailure(failure({ body: 'first', timestamp: new Date('2026-09-04T14:00:00Z') }));
    log.recordFailure(failure({ body: 'second', timestamp: new Date('2026-09-04T14:05:00Z') }));

    expect(log.getRecentFailures(10).map((row) => row.body)).toEqual(['second', 'first']);
  });

  it('bounds getRecentFailures by the given limit', () => {
    const log = makeStore();
    log.recordFailure(failure({ body: 'a', timestamp: new Date('2026-09-04T14:00:00Z') }));
    log.recordFailure(failure({ body: 'b', timestamp: new Date('2026-09-04T14:01:00Z') }));

    expect(log.getRecentFailures(1).map((row) => row.body)).toEqual(['b']);
  });

  it('round-trips every field, including the timestamp', () => {
    const log = makeStore();
    const entry = failure({ chat_id: '-999', method: 'sendMessage', error: 'boom' });
    log.recordFailure(entry);

    expect(log.getRecentFailures(1)).toEqual([entry]);
  });
});
