import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { setExitCodeWhenInvoked, writeOrFail } from '../../tools/cli-entrypoint.js';
import type { BarsSource } from './data/index.js';
import { type OutcomeRebuild, rebuildDecisionOutcomes } from './decision-outcomes.js';
import { barsSourceFor, V2_STORE_PATH } from './index.js';

async function primedBars(barStoreRoot: string): Promise<BarsSource> {
  const { bars, prime } = barsSourceFor({ barStoreRoot }, { log: () => {} });
  await prime();
  return bars;
}

export function formatOutcomeRebuild(rebuild: OutcomeRebuild): string {
  return [
    `settled ${rebuild.settled} closed trades (${rebuild.written} new)`,
    ...rebuild.pending.map(
      (row) => `pending ${row.bookId} ${row.instrument} ${row.exitOrderId}: ${row.reason}`,
    ),
    ...rebuild.unmatched.map((key) => `unmatched ${key}: no entry decision in the journal`),
  ].join('\n');
}

export async function settleOutcomes(
  storePath: string,
  barStoreRoot: string,
  loadBars: (root: string) => Promise<BarsSource> = primedBars,
): Promise<string> {
  const bars = await loadBars(barStoreRoot);
  const db = openSharedStore(storePath);
  try {
    return formatOutcomeRebuild(rebuildDecisionOutcomes(guardedStore(db, 'v2'), bars));
  } finally {
    db.close();
  }
}

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  settle = settleOutcomes,
): Promise<number> {
  const [storePath = V2_STORE_PATH, barStoreRoot = DEFAULT_BAR_STORE_ROOT] = argv;
  return writeOrFail(write, () => settle(storePath, barStoreRoot));
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
