import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupTargets,
  execRunner,
  litestreamFor,
  replicateOnce,
  restoreMissing,
} from '../../server/apps/v2/backup.js';
import { composeV2Root } from '../../server/apps/v2/index.js';
import { CapitalConfigStore } from '../../server/apps/v2/risk/index.js';
import { SimulatedClock } from '../../server/shared/index.js';
import { openSharedStore, type StoreHandle } from '../../server/shared/store/index.js';

const dir = mkdtempSync(join(tmpdir(), 'restore-drill-'));
const paper = join(dir, 'paper.sqlite');
const control = join(dir, 'control.sqlite');
const research = join(dir, 'research.sqlite');
const root = `drill/restore-${Math.floor(Date.now() / 1000)}`;
const env = { ...process.env, LITESTREAM_REPLICA_ROOT: root, SAMURAI_RESEARCH_STORE: research };
const tool = litestreamFor(env, execRunner);
const targets = backupTargets(paper, env);
const quiet = { log: () => {} };
const DAYS = ['2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22'];
const NEXT = '2026-09-23';

function dump(path: string): string {
  const db = openSharedStore(path);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  const out = tables.map(({ name }) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ]);
  db.close();
  return JSON.stringify(out);
}

function normalised(path: string): string {
  return dump(path)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid')
    .replace(new RegExp(`${new Date().toISOString().slice(0, 10)}T[0-9:.]+Z`, 'g'), 'wall-clock')
    .replace(/"latency_ms":\d+/g, '"latency_ms":0')
    .replace(/\["_litestream_seq",\[[^\]]*\]\],?/g, '');
}

function rowCounts(path: string): Record<string, number> {
  const db = openSharedStore(path);
  const counts: Record<string, number> = {};
  for (const table of ['v2_decisions', 'v2_orders', 'llm_spend', 'capital_config']) {
    try {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch {
      counts[table] = -1;
    }
  }
  db.close();
  return counts;
}

async function cycle(storePath: string, date: string) {
  const store: StoreHandle = openSharedStore(storePath);
  const root = composeV2Root({
    tradingDate: date,
    dryRun: true,
    store,
    clock: new SimulatedClock(new Date(`${date}T07:00:00.000Z`)),
    logger: quiet,
  });
  try {
    return await root.run();
  } finally {
    root.close();
  }
}

const seed = openSharedStore(paper);
new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-09-01T07:00:00.000Z'))).setYear(
  2026,
  2_000,
  1_500,
);
seed.close();
const research0 = openSharedStore(research);
research0.exec('CREATE TABLE IF NOT EXISTS drill_marker (v TEXT)');
research0.prepare('INSERT INTO drill_marker VALUES (?)').run('research-row');
research0.close();

console.log('replica root', root);
for (const date of DAYS) {
  const report = await cycle(paper, date);
  await replicateOnce(tool, targets, quiet);
  console.log(
    date,
    'decisions',
    report.decisions,
    'entries',
    report.entries,
    'refusals',
    report.dry_run_refusals,
    'replicated',
  );
}
copyFileSync(paper, control);
console.log('before delete', rowCounts(paper));
const beforePaper = dump(paper);
const beforeResearch = dump(research);
for (const path of [paper, research])
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
console.log('deleted, exists:', existsSync(paper), existsSync(research));
await restoreMissing(tool, targets, quiet);
console.log('restored, exists:', existsSync(paper), existsSync(research));
console.log(
  'paper identical:',
  dump(paper) === beforePaper,
  'research identical:',
  dump(research) === beforeResearch,
);
await restoreMissing(tool, targets, quiet);
console.log('second restore left stores untouched:', dump(paper) === beforePaper);
const restoredReport = await cycle(paper, NEXT);
const controlReport = await cycle(control, NEXT);
console.log(
  NEXT,
  'reports identical:',
  JSON.stringify(restoredReport) === JSON.stringify(controlReport),
  'decisions',
  restoredReport.decisions,
);
console.log(
  'stores identical after next cycle:',
  dump(paper) === dump(control),
  'identical but for UUIDs and wall-clock stamps:',
  normalised(paper) === normalised(control),
);
await replicateOnce(tool, targets, quiet);
console.log('post-restore replicate ok');
