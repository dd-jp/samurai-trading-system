import { existsSync } from 'node:fs';
import {
  type CandidateTrialsWire,
  type NotYetFedWire,
  type PanelWire,
  type ResearchLedgerWire,
  type ResearchWire,
  type TrialWire,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import {
  openReadOnlyStore,
  type StoreHandle,
  toStoredTimestamp,
} from '../../../shared/store/index.js';

const LOOP_OWNER: NotYetFedWire = {
  status: 'not-yet-fed',
  owner: 'G11 not ruled',
  ticket: '#1717',
};

function hasTrialsTable(db: StoreHandle): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v2_trials'").get() !==
    undefined
  );
}

function byCandidate(trials: readonly TrialWire[]): CandidateTrialsWire[] {
  const counts = new Map<string, number>();
  for (const trial of trials) counts.set(trial.candidate, (counts.get(trial.candidate) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([candidate, count]) => ({ candidate, trials: count }));
}

function ledgerOf(db: StoreHandle): PanelWire<ResearchLedgerWire> {
  if (!hasTrialsTable(db)) return { status: 'empty' };
  const trials = db
    .prepare(
      'SELECT trial, candidate, config_hash, source, recorded_at FROM v2_trials ORDER BY trial',
    )
    .all() as TrialWire[];
  if (trials.length === 0) return { status: 'empty' };
  return {
    status: 'fed',
    total_trials: trials.length,
    by_candidate: byCandidate(trials),
    trials,
  };
}

export class ResearchReader {
  constructor(
    private readonly storePath: string,
    private readonly clock: Clock,
  ) {}

  read(): ResearchWire {
    return {
      contract_version: V2_CONTRACT_VERSION,
      generated_at: toStoredTimestamp(this.clock.now()),
      ledger: this.#ledger(),
      proposals: LOOP_OWNER,
      promotions: LOOP_OWNER,
      demotions: LOOP_OWNER,
    };
  }

  #ledger(): PanelWire<ResearchLedgerWire> {
    if (!existsSync(this.storePath)) return { status: 'empty' };
    const db = openReadOnlyStore(this.storePath);
    try {
      return ledgerOf(db);
    } finally {
      db.close();
    }
  }
}
