import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { composeV2Root, type V2Root } from './index.js';
import { CapitalConfigStore } from './risk/index.js';
import { RunLease } from './run-lease.js';

const D = '2026-10-02';
const clock = new SimulatedClock(new Date(`${D}T14:00:00.000Z`));
const dirs: string[] = [];
const roots: V2Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function dryRunRoot(): Promise<V2Root> {
  const directory = mkdtempSync(join(tmpdir(), 'v2-flatten-root-'));
  dirs.push(directory);
  const barStoreRoot = join(directory, 'parquet');
  const bars = await ParquetBarStore.open(barStoreRoot);
  const days = Array.from({ length: 40 }, (_, back) =>
    new Date(Date.UTC(2026, 9, 1) - back * 86_400_000).toISOString().slice(0, 10),
  ).reverse();
  await bars.write('alpaca', [
    {
      symbol: 'UP',
      bars: days.map((date) => ({
        date,
        open: 25,
        high: 25.25,
        low: 24.75,
        close: 25,
        volume: 1_000_000,
        rawClose: 25,
      })),
    },
  ]);
  bars.close();
  const write = (name: string, text: string) => {
    const path = join(directory, name);
    writeFileSync(path, text);
    return path;
  };
  const storePath = join(directory, 'v2.sqlite');
  const db = openSharedStore(storePath);
  new CapitalConfigStore(db, clock).setYear(2026, 10_000, 1_500);
  db.close();
  const root = composeV2Root({
    tradingDate: D,
    dryRun: true,
    storePath,
    clock,
    logger: { log: () => {} },
    barStoreRoot,
    constituentsPath: write('constituents.csv', 'date,tickers\n2016-01-04,"UP"\n'),
    fxPath: write('fx.csv', 'DATE,XUDLUSS\n31 Dec 2025,1.25\n'),
    spreadsPath: write('spreads.csv', 'symbol,sessions,median_half_spread_bps\n'),
    saxoSpreadsPath: join(directory, 'none.csv'),
    newsSource: { headlines: () => Promise.resolve([]) },
  });
  roots.push(root);
  return root;
}

function halt(root: V2Root): number {
  const { lastInsertRowid } = root.db
    .prepare(
      `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
       VALUES ('halt', 'Telegram flatten confirmed', 'telegram', 'flatten-root-1', ?)`,
    )
    .run(clock.now().toISOString());
  return Number(lastInsertRowid);
}

describe('V2Root.flatten (#1894)', () => {
  it('exits a held position through the composed risk gate and executor, under the run lease', async () => {
    const root = await dryRunRoot();
    root.books.applyFill('debate/primary', {
      instrument: 'UP',
      venue: 'alpaca',
      side: 'buy',
      leg: 'entry',
      qty: 4,
      priceGbp: 20,
      feeGbp: 0,
      clientOrderId: 'held-up',
      tradingDate: '2026-09-30',
      stopGbp: undefined,
      targetGbp: undefined,
    });
    const controlId = halt(root);

    const pass = await root.flatten({ controlId, tradingDate: D });

    const exitId = `v2-debate-primary-${D}-UP-exit`;
    expect(pass).toEqual({
      ran: true,
      result: {
        outcome: 'closed',
        detail:
          'cancelled 0 resting entries; 1 exits: submitted 0, simulated 0, dry-run 1, rejected 0',
      },
    });
    expect(root.journal.orderFor(exitId)).toMatchObject({
      leg: 'exit',
      side: 'sell',
      outcome: 'refused_dry_run',
      payload: { reason: 'manual_halt', size: 4, approval: `exit:${exitId}:4` },
    });
    expect(root.books.position('debate/primary', 'UP')?.exitClientOrderId).toBe(exitId);
    expect(
      root.db.prepare('SELECT event, outcome FROM v2_flattens ORDER BY flatten_id').all(),
    ).toEqual([
      { event: 'started', outcome: null },
      { event: 'finished', outcome: 'closed' },
    ]);
  });

  it('defers while the daily cycle holds the run lease', async () => {
    const root = await dryRunRoot();
    const controlId = halt(root);
    const release = new RunLease(root.db, clock).tryAcquire('cycle');

    const pass = await root.flatten({ controlId, tradingDate: D });

    release?.();
    expect(pass).toEqual({
      ran: false,
      reason: 'lease_held',
      detail: `cycle (pid ${process.pid})`,
    });
    expect(root.db.prepare('SELECT COUNT(*) AS n FROM v2_flattens').get()).toEqual({ n: 0 });
  });
});
