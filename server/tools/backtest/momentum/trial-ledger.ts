import type { TrialConfig } from './grid.js';
import { trialHash } from './grid.js';

export interface LedgerEntry {
  readonly trial: number;
  readonly config_hash: string;
  readonly config: TrialConfig;
}

export interface TrialLedger {
  readonly entries: readonly LedgerEntry[];
}

export function ledgerFromGrid(grid: readonly TrialConfig[]): TrialLedger {
  const entries = grid.map((config) => ({
    trial: config.trial,
    config_hash: trialHash(config),
    config,
  }));
  assertNumberedFromOne(entries);
  return { entries };
}

export function mergeLedger(existing: TrialLedger, grid: readonly TrialConfig[]): TrialLedger {
  const incoming = ledgerFromGrid(grid);
  const byTrial = new Map(existing.entries.map((entry) => [entry.trial, entry]));
  for (const entry of incoming.entries) {
    const previous = byTrial.get(entry.trial);
    if (previous !== undefined && previous.config_hash !== entry.config_hash) {
      throw new Error(
        `trial ledger: trial #${entry.trial} already recorded with hash ${previous.config_hash}; ` +
          `a changed config is a new trial number, not a rewrite`,
      );
    }
    byTrial.set(entry.trial, entry);
  }
  const entries = [...byTrial.values()].sort((a, b) => a.trial - b.trial);
  assertNumberedFromOne(entries);
  return { entries };
}

export function distinctTrialCount(ledger: TrialLedger): number {
  return new Set(ledger.entries.map((entry) => entry.config_hash)).size;
}

function assertNumberedFromOne(entries: readonly LedgerEntry[]): void {
  entries.forEach((entry, index) => {
    if (entry.trial !== index + 1) {
      throw new Error(
        `trial ledger: expected trial #${index + 1} at position ${index}, got #${entry.trial}`,
      );
    }
  });
  const hashes = new Set(entries.map((entry) => entry.config_hash));
  if (hashes.size !== entries.length) throw new Error('trial ledger: duplicate config hashes');
}
