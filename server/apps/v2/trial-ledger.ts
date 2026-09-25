import { createHash } from 'node:crypto';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, toStoredTimestamp } from '../../shared/store/index.js';

export const V2_RESEARCH_STORE_PATH = 'data/samurai-v2-research.sqlite';
export const SESSION_B_TRIALS_PATH = 'data/backtest/momentum/trials.json';

export type TrialConfig = Readonly<Record<string, unknown>>;

export interface SessionBLedger {
  readonly entries: readonly {
    readonly trial: number;
    readonly config_hash: string;
    readonly config: TrialConfig & { readonly venue: string };
  }[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function trialHash(candidate: string, config: TrialConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ candidate, config })))
    .digest('hex')
    .slice(0, 16);
}

export class TrialLedger {
  readonly #db: StoreHandle;

  constructor(
    db: StoreHandle,
    private readonly clock: Clock,
    sessionB: SessionBLedger,
  ) {
    this.#db = guardedStore(db, 'v2');
    if (this.count() === 0) this.#seed(sessionB);
    else this.#assertSeeded(sessionB);
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM v2_trials').get() as { n: number }).n;
  }

  record(candidate: string, config: TrialConfig): number {
    const hash = trialHash(candidate, config);
    return this.#trialOf(hash) ?? this.#insert(this.count() + 1, candidate, hash, config, 'v2');
  }

  #seed(ledger: SessionBLedger): void {
    for (const entry of ledger.entries) {
      this.#insert(
        entry.trial,
        `momentum/${entry.config.venue}`,
        entry.config_hash,
        entry.config,
        'session-b',
      );
    }
  }

  #assertSeeded(ledger: SessionBLedger): void {
    for (const entry of ledger.entries) {
      if (this.#trialOf(entry.config_hash) !== entry.trial) {
        throw new Error(
          `TrialLedger: trial #${entry.trial} is not Session B's ${entry.config_hash}; the ledger must open with Session B's trials`,
        );
      }
    }
  }

  #trialOf(hash: string): number | undefined {
    const row = this.#db.prepare('SELECT trial FROM v2_trials WHERE config_hash = ?').get(hash) as
      | { trial: number }
      | undefined;
    return row?.trial;
  }

  #insert(
    trial: number,
    candidate: string,
    hash: string,
    config: TrialConfig,
    source: string,
  ): number {
    this.#db
      .prepare(
        `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trial,
        candidate,
        hash,
        JSON.stringify(canonical(config)),
        source,
        toStoredTimestamp(this.clock.now()),
      );
    return trial;
  }
}
