import type { HeartbeatWire, NextCycleWire, PanelWire } from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { bothVenuesClosed } from '../data/index.js';

const LAST_CYCLE = `
  SELECT trading_date, recorded_at FROM v2_book_days ORDER BY recorded_at DESC LIMIT 1`;

const LAST_CYCLE_DAY = `
  SELECT MAX(trading_date) AS trading_date FROM (
    SELECT trading_date FROM v2_book_days
    UNION ALL
    SELECT trading_date FROM v2_refusals WHERE scope = 'cycle' AND parameter = 'venues_closed'
  )`;

const LAST_PING = `
  SELECT outcome, pinged_at FROM v2_heartbeat_pings ORDER BY ping_id DESC LIMIT 1`;

function nextDay(date: string): string {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function nextCycleDate(after: string): string {
  let date = nextDay(after);
  while (bothVenuesClosed(date)) date = nextDay(date);
  return date;
}

function nextDue(db: StoreHandle): PanelWire<NextCycleWire> {
  const last = db.prepare(LAST_CYCLE_DAY).get() as { trading_date: string | null };
  return last.trading_date === null
    ? { status: 'empty' }
    : { status: 'fed', due_date: nextCycleDate(last.trading_date) };
}

function lastPing(db: StoreHandle): HeartbeatWire['last_ping'] {
  const row = db.prepare(LAST_PING).get() as
    | { outcome: 'success' | 'fail'; pinged_at: string }
    | undefined;
  return row === undefined ? { status: 'empty' } : { status: 'fed', ...row };
}

export function heartbeatWire(db: StoreHandle): HeartbeatWire {
  const last = db.prepare(LAST_CYCLE).get() as
    | { trading_date: string; recorded_at: string }
    | undefined;
  return {
    last_cycle: last === undefined ? { status: 'empty' } : { status: 'fed', ...last },
    next_due: nextDue(db),
    last_ping: lastPing(db),
  };
}
