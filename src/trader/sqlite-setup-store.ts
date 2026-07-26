/**
 * SQLite-backed `SetupStore` over the `cosine_setups` table (#198) — the real
 * store behind `FixtureSetupStore`. The Trader writes at decision time
 * (`writeSetup`) and reads precedents (`findNeighbors`); the Feedback Loop
 * labels on trade close (`labelSetup`). See docs/specs/shared-sqlite-store-spec.md
 * ("Feedback Loop" schema section) and docs/specs/trader-spec.md
 * ("Module: Cosine Precedent Retrieval").
 *
 * Two conventions this module fixes:
 *
 * 1. **Timestamps are ISO-8601 UTC TEXT** (`Date.toISOString()`), on write and
 *    on the `asOf` bind alike. `closed_at <= ?` is a string comparison, which
 *    is only correct under one canonical, fixed-width format.
 * 2. **`instrument`/`asset_class`/`idempotency_key` come from the constructor**,
 *    not from `writeSetup`. The `SetupStore` port (src/shared/types.ts) carries
 *    only `debate_id`/vector/`decided_at`, but all three columns are NOT NULL
 *    (and `asset_class` is CHECKed). They exist for retrieval scoping and FL's
 *    trade-close join — neither of which the port exercises today
 *    (`findNeighbors` takes no instrument; `onTradeClose` joins on `debate_id`).
 *    Rather than widen the shared port, the caller supplies them at construction;
 *    `idempotency_key` defaults to the `debate_id`. Revisit when a real Trader
 *    composition root exists and can pass per-write scoping.
 */

import type { SharedStore } from '../shared/store/open-shared-store.js';
import type { SetupNeighbor, SetupStore, SetupVector } from '../shared/types.js';

export type SetupAssetClass = 'crypto' | 'stocks';

export interface SqliteSetupStoreOptions {
  /** Retrieval-scoping column; see the note above on why it is not per-write. */
  instrument?: string;
  asset_class?: SetupAssetClass;
  /** FL's trade-close join column; defaults to the row's own `debate_id`. */
  idempotencyKeyFor?: (debateId: string) => string;
}

interface SetupRow {
  debate_features_json: string;
  market_features_json: string;
  r_multiple: number;
  closed_at: string;
}

const DEFAULT_INSTRUMENT = 'UNKNOWN';
const DEFAULT_ASSET_CLASS: SetupAssetClass = 'stocks';

export class SqliteSetupStore implements SetupStore {
  private readonly instrument: string;
  private readonly assetClass: SetupAssetClass;
  private readonly idempotencyKeyFor: (debateId: string) => string;

  constructor(
    private readonly db: SharedStore,
    options: SqliteSetupStoreOptions = {},
  ) {
    this.instrument = options.instrument ?? DEFAULT_INSTRUMENT;
    this.assetClass = options.asset_class ?? DEFAULT_ASSET_CLASS;
    this.idempotencyKeyFor = options.idempotencyKeyFor ?? ((debateId) => debateId);
  }

  /**
   * Candidate set only — setups already closed as of `asOf`. Cosine scoring,
   * the similarity threshold and top-k stay in `retrieveCosinePrecedent`.
   * `closed_at IS NOT NULL` is what enforces no-lookahead: an unlabelled row
   * has a NULL `closed_at`, and `NULL <= ?` is NULL (never true), but the
   * explicit predicate keeps the intent legible rather than incidental.
   */
  findNeighbors(_vector: SetupVector, asOf: Date): SetupNeighbor[] {
    const rows = this.db
      .prepare(
        `SELECT debate_features_json, market_features_json, r_multiple, closed_at
           FROM cosine_setups
          WHERE r_multiple IS NOT NULL
            AND closed_at IS NOT NULL
            AND closed_at <= ?`,
      )
      .all(asOf.toISOString()) as SetupRow[];

    return rows.map((row) => ({
      vector: {
        debate_features: JSON.parse(row.debate_features_json) as number[],
        market_features: JSON.parse(row.market_features_json) as number[],
      },
      r_multiple: row.r_multiple,
      closed_at: new Date(row.closed_at),
    }));
  }

  /**
   * One row per `debate_id` (PK). A duplicate write for the same debate is a
   * bug (replayed decision), so the PK violation is surfaced as a named error
   * rather than an upsert.
   */
  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void {
    try {
      this.db
        .prepare(
          `INSERT INTO cosine_setups (
             debate_id, idempotency_key, instrument, asset_class,
             debate_features_json, market_features_json, r_multiple, closed_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          debateId,
          this.idempotencyKeyFor(debateId),
          this.instrument,
          this.assetClass,
          JSON.stringify(vector.debate_features),
          JSON.stringify(vector.market_features),
          decidedAt.toISOString(),
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteSetupStore.writeSetup: a setup already exists for debate_id '${debateId}' — ` +
            'one row per debate (cosine_setups PK); a repeat write is a replayed decision.',
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * Sets `r_multiple`/`closed_at` together, exactly once. The guard is in the
   * UPDATE's own WHERE (`r_multiple IS NULL`), not a read-then-write, so a
   * second label cannot slip through between the check and the write: zero
   * changed rows means either unknown or already-labelled, both of which are
   * bugs per `SetupStore.labelSetup`.
   */
  labelSetup(debate_id: string, r_multiple: number, closed_at: Date): void {
    const result = this.db
      .prepare(
        `UPDATE cosine_setups
            SET r_multiple = ?, closed_at = ?
          WHERE debate_id = ? AND r_multiple IS NULL`,
      )
      .run(r_multiple, closed_at.toISOString(), debate_id);

    if (result.changes === 0) {
      throw new Error(
        `SqliteSetupStore.labelSetup: no pending setup for debate_id '${debate_id}' — ` +
          'either it was never written or has already been labelled.',
      );
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}
