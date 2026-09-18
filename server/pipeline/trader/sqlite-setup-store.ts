import type { SetupNeighbor, SetupStore, SetupVector } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

export type SetupAssetClass = 'crypto' | 'stocks';

export interface SqliteSetupStoreOptions {
  instrument?: string;
  asset_class?: SetupAssetClass;
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
    private readonly db: StoreHandle,
    options: SqliteSetupStoreOptions = {},
  ) {
    this.instrument = options.instrument ?? DEFAULT_INSTRUMENT;
    this.assetClass = options.asset_class ?? DEFAULT_ASSET_CLASS;
    this.idempotencyKeyFor = options.idempotencyKeyFor ?? ((debateId) => debateId);
  }

  findNeighbors(_vector: SetupVector, asOf: Date): SetupNeighbor[] {
    const rows = this.db
      .prepare(
        `SELECT debate_features_json, market_features_json, r_multiple, closed_at
           FROM cosine_setups
          WHERE r_multiple IS NOT NULL
            AND closed_at IS NOT NULL
            AND closed_at <= ?`,
      )
      .all(toStoredTimestamp(asOf)) as SetupRow[];

    return rows.map((row) => ({
      vector: {
        debate_features: JSON.parse(row.debate_features_json) as number[],
        market_features: JSON.parse(row.market_features_json) as number[],
      },
      r_multiple: row.r_multiple,
      closed_at: fromStoredTimestamp(row.closed_at),
    }));
  }

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
        toStoredTimestamp(decidedAt),
      );
  }

  labelSetup(debate_id: string, r_multiple: number, closed_at: Date): void {
    const result = this.db
      .prepare(
        `UPDATE cosine_setups
            SET r_multiple = ?, closed_at = ?
          WHERE debate_id = ? AND r_multiple IS NULL`,
      )
      .run(r_multiple, toStoredTimestamp(closed_at), debate_id);

    if (result.changes === 0) {
      throw new Error(
        `SqliteSetupStore.labelSetup: no pending setup for debate_id '${debate_id}' — ` +
          'either it was never written or has already been labelled.',
      );
    }
  }
}
