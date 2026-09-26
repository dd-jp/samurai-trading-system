import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Clock } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore, toStoredTimestamp } from '../../shared/store/index.js';

export const SESSION_B_TRIALS_PATH = 'data/backtest/momentum/trials.json';

export type TrialConfig = Readonly<Record<string, unknown>>;

export interface TrialRow {
  readonly trial: number;
  readonly candidate: string;
  readonly config_hash: string;
  readonly source: string;
  readonly recorded_at: string;
}

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

  list(): readonly TrialRow[] {
    return this.#db
      .prepare(
        'SELECT trial, candidate, config_hash, source, recorded_at FROM v2_trials ORDER BY trial',
      )
      .all() as TrialRow[];
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

export function sessionBLedger(path: string = SESSION_B_TRIALS_PATH): SessionBLedger {
  return JSON.parse(readFileSync(path, 'utf8')) as SessionBLedger;
}

// One ledger per machine, outside every checkout: a store under a worktree's data/ would count
// only that worktree's trials and deflate the DSR over too few
export function researchStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SAMURAI_RESEARCH_STORE ?? join(homedir(), 'samurai-research', 'samurai-v2-research.sqlite')
  );
}

export function main(storePath: string = researchStorePath()): number {
  mkdirSync(dirname(storePath), { recursive: true });
  const db = openSharedStore(storePath);
  try {
    const ledger = new TrialLedger(db, new SystemClock(), sessionBLedger());
    process.stdout.write(
      `${JSON.stringify({ trials_counted: ledger.count(), trials: ledger.list() }, null, 2)}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
