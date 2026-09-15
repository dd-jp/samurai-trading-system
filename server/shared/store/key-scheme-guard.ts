/**
 * The #686 rollout guard.
 *
 * ## What it protects
 *
 * #686 added a `side` ('open' | 'close') discriminator to the idempotency-key
 * payload. A key computed before that change can never match one computed after
 * it for the same `(instrument, bar)`.
 *
 * That matters because the three dedup layers are **not independent**:
 * `open_positions`'s PRIMARY KEY *is* `idempotency_key`, so `findByKey`, the
 * primary-key backstop and the broker's `client_order_id` are one mechanism
 * wearing three hats. They share a single input. A crash-replay spanning the
 * cutover therefore misses in `findByKey`, raises no primary-key conflict, and
 * presents the broker an id it has not seen — **a double order with all three
 * layers passing it**. There is no layer left to catch it, which is why this has
 * to be caught before the process starts rather than defended against at
 * runtime.
 *
 * ## Why refuse rather than repair
 *
 * The pre-cutover key cannot be recomputed. Deriving it needs the bar, and while
 * `decision_timestamp` holds it, re-deriving and rewriting a primary key that a
 * live broker order is already keyed against trades a detectable failure for a
 * silent one. Draining is the honest fix and it is cheap: flatten the book, or
 * start the run on a fresh store.
 *
 * Migration `0027_open_positions_key_scheme.sql` stamps every row that existed
 * at cutover with `key_scheme = 1`; everything written since defaults to 2.
 */
import type { Database } from 'better-sqlite3';
import type { OrderState } from '../../../contracts/index.js';

/**
 * `order_state`s that are finished — excluded from `getOpenPositions()`
 * (execution-spec.md).
 *
 * Lives here, in the layer both readers may import, rather than being copied:
 * `pipeline/execution/sqlite-shared-store.ts` imports it too. A second copy
 * would be a list two modules must agree on with nothing enforcing it, and the
 * disagreement is silent — a state missing here makes this guard block on a
 * finished lot forever, and a state missing there leaks terminal rows into the
 * open book.
 */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = [
  'closed',
  'cancelled',
  'rejected',
  'expired',
  'abandoned',
];

/**
 * `order_state`s a crash can strand: written ahead, or acked by the venue but
 * not advanced since. `reconcile()`'s bracket pass revisits exactly these and
 * adopts broker truth for them.
 *
 * Lives here for the same reason `TERMINAL_ORDER_STATES` does — two stages
 * read it and neither owns it (coding-standards.md "A port consumed by more
 * than one stage… moves to `shared/` when the second consumer arrives").
 * `pipeline/execution/reconcile.ts` picks its worklist from it;
 * `pipeline/risk-manager/portfolio-view.ts` derives the states whose unfilled
 * remainder is reserved against the entry caps from it (#1019), because the
 * only safe reservation is one the reconcile pass can release.
 */
export const IN_FLIGHT_ORDER_STATES: readonly OrderState[] = ['pending', 'submitted'];

/** A lot still in flight whose key predates the #686 derivation. */
export interface StaleKeySchemeLot {
  idempotency_key: string;
  instrument: string;
  order_state: string;
}

/** Non-terminal lots still carrying a pre-#686 key, oldest first. */
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

/**
 * Throws when the store holds in-flight lots keyed under the old derivation.
 *
 * Called from the composition root BEFORE the tick loop is armed. A terminal
 * lot is harmless — nothing will ever replay a decision for it — so only
 * non-terminal rows block, which is what makes this a one-time drain rather
 * than a permanent obstacle.
 */
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
