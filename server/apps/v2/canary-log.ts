import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, toStoredTimestamp } from '../../shared/store/index.js';

export type CanaryKind = 'shift' | 'random';

export interface CanaryRun {
  readonly candidate: string;
  readonly candidateHash: string;
  readonly kind: CanaryKind;
  readonly seed: number | undefined;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface CanaryRow {
  readonly run_id: number;
  readonly candidate: string;
  readonly candidate_hash: string;
  readonly kind: CanaryKind;
  readonly seed: number | null;
  readonly result: string;
  readonly recorded_at: string;
}

export class CanaryLog {
  readonly #db: StoreHandle;

  constructor(
    db: StoreHandle,
    private readonly clock: Clock,
  ) {
    this.#db = guardedStore(db, 'v2');
  }

  record(run: CanaryRun): void {
    this.#db
      .prepare(
        `INSERT INTO v2_canary_runs (candidate, candidate_hash, kind, seed, result, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.candidate,
        run.candidateHash,
        run.kind,
        run.seed ?? null,
        JSON.stringify(run.result),
        toStoredTimestamp(this.clock.now()),
      );
  }

  list(): readonly CanaryRow[] {
    return this.#db
      .prepare(
        `SELECT run_id, candidate, candidate_hash, kind, seed, result, recorded_at
         FROM v2_canary_runs ORDER BY run_id`,
      )
      .all() as CanaryRow[];
  }
}
