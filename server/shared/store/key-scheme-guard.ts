import type { Database } from 'better-sqlite3';
import type { OrderState } from '../../../contracts/index.js';

export const TERMINAL_ORDER_STATES: readonly OrderState[] = [
  'closed',
  'cancelled',
  'rejected',
  'expired',
  'abandoned',
];

export interface StaleKeySchemeLot {
  idempotency_key: string;
  instrument: string;
  order_state: string;
}

export function findStaleKeySchemeLots(db: Database): StaleKeySchemeLot[] {
  const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');

  return db
    .prepare(
      `SELECT idempotency_key, instrument, order_state
         FROM open_positions
        WHERE key_scheme < 2
          AND order_state NOT IN (${placeholders})
        ORDER BY opened_at ASC`,
    )
    .all(...TERMINAL_ORDER_STATES) as StaleKeySchemeLot[];
}

export function assertNoStaleKeyScheme(db: Database): void {
  const stale = findStaleKeySchemeLots(db);
  if (stale.length === 0) return;

  const listed = stale
    .slice(0, 10)
    .map((lot) => `  ${lot.instrument} (${lot.order_state}) ${lot.idempotency_key}`)
    .join('\n');
  const more = stale.length > 10 ? `\n  ...and ${stale.length - 10} more` : '';

  throw new Error(
    `Refusing to start: ${stale.length} in-flight position(s) carry an idempotency key ` +
      `computed before #686 added the open/close discriminator.\n${listed}${more}\n\n` +
      'Their keys can never match one this build computes for the same instrument and bar, ' +
      'and because `open_positions`.idempotency_key IS the primary key, all three dedup ' +
      'layers share that one input — so a crash-replay spanning this deploy would place a ' +
      'DUPLICATE order with findByKey, the PK backstop and the broker client_order_id all ' +
      'passing it.\n\n' +
      'Fix: flatten the book and let the exits settle before starting this build, or start ' +
      'the run against a fresh store. Once every listed lot reaches a terminal state this ' +
      'check passes on its own and never fires again.',
  );
}
