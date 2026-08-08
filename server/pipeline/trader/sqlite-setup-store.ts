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
 *    not from `writeSetup`. The `SetupStore` port (server/shared/types.ts) carries
 *    only `debate_id`/vector/`decided_at`, but all three columns are NOT NULL
 *    (and `asset_class` is CHECKed). They exist for retrieval scoping and FL's
 *    trade-close join — neither of which the port exercises today
 *    (`findNeighbors` takes no instrument; `onTradeClose` joins on `debate_id`).
 *    Rather than widen the shared port, the caller supplies them at construction;
 *    `idempotency_key` defaults to the `debate_id`. Revisit when a real Trader
 *    composition root exists and can pass per-write scoping.
 */

import type { SetupNeighbor, SetupStore, SetupVector } from '../../shared/index.js';
import type { SharedStore } from '../../shared/store/index.js';

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
   * One row per `debate_id` (PK), first-write-wins.
   *
   * This used to throw on a repeat, on the reasoning that a duplicate write
   * "is a bug (replayed decision)". #432 made `decide()` its caller, and that
   * reasoning does not survive the move: `decide` runs the same code path in
   * live and in replay (ADR-0003 replay-from-log), and a crash-restart that
   * re-decides the same bar produces the same deterministic `debate_id`. A
   * throw there kills the tick over a row that already holds exactly the
   * values the second write would have supplied — `debate_id` is a hash of the
   * debate's inputs, so an identical debate embeds an identical vector.
   *
   * `ON CONFLICT DO NOTHING`, the same choice and the same reason as
   * `SqliteVerdictLogStore.writeLog` and `SqliteTuningStore.seedAnalystWeight`:
   * the row that exists is the record, and a later write must not be able to
   * erase it — including its `created_at`, which is the only evidence of when
   * the decision was actually made.
   */
  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void {
    this.db
      .prepare(
        `INSERT INTO cosine_setups (
             debate_id, idempotency_key, instrument, asset_class,
             debate_features_json, market_features_json, r_multiple, closed_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(debate_id) DO NOTHING`,
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
