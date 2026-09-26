import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SystemClock } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { DEFAULT_BUNDLE_ROOT } from './bundle.js';
import { composeV2Dashboard } from './main.js';

export const FIXTURE_TRADING_DATE = '2026-10-05';

const BOOKS = [
  { bookId: 'debate/primary', variant: 'primary', equity: 1_940, ytdLoss: 60 },
  { bookId: 'debate/no-veto', variant: 'no-veto', equity: 1_880, ytdLoss: 120 },
] as const;

export function seedFixtureStore(db: StoreHandle): void {
  db.prepare(
    `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
     VALUES (2026, '2026-01-01', 2000, 1500, '2026-01-01T00:00:00.000Z')`,
  ).run();
  for (const { bookId, variant, equity, ytdLoss } of BOOKS) {
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, 'debate', ?, 2000, ?, '2026-09-01T00:00:00.000Z')`,
    ).run(bookId, variant, equity - 300);
    db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
         size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
       VALUES (?, ?, ?, ?, 300, ?, 1, 0, 0, ?)`,
    ).run(
      bookId,
      FIXTURE_TRADING_DATE,
      equity,
      equity - 300,
      ytdLoss,
      `${FIXTURE_TRADING_DATE}T21:40:00.000Z`,
    );
  }
  db.prepare(
    `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
       client_order_id, exit_client_order_id, opened_date, marks_held, updated_at)
     VALUES ('debate/primary', 'AAPL', 'alpaca', 2, 150, 135, NULL, 'fixture-aapl', NULL, '2026-10-01', 3,
       '2026-10-05T21:40:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash, direction,
       confidence, action, reason, size_shares, stop_price, payload, recorded_at)
     VALUES ('fixture-aapl', 'debate/primary', ?, 'AAPL', 'alpaca', 'h', 'long', 0.68, 'enter_long',
       'debate consensus', 2, 135, '{}', ?)`,
  ).run(FIXTURE_TRADING_DATE, `${FIXTURE_TRADING_DATE}T21:40:00.000Z`);
}

export function createFixtureStore(): { storePath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-fixture-'));
  const storePath = join(dir, 'v2.sqlite');
  const db = openSharedStore(storePath);
  try {
    seedFixtureStore(db);
  } finally {
    db.close();
  }
  return { storePath, dir };
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const { storePath, dir } = createFixtureStore();
  const { server } = composeV2Dashboard(
    {
      storePath,
      barStoreRoot: join(dir, 'bars'),
      fxPath: join(dir, 'no-fx.csv'),
      researchStorePath: join(dir, 'research.sqlite'),
      bundleRoot: env.V2_BUNDLE_ROOT ?? DEFAULT_BUNDLE_ROOT,
      mode: 'paper',
      host: env.HOST ?? '127.0.0.1',
      port: Number(env.PORT ?? 0),
    },
    env,
    new SystemClock(),
  );
  await server.start();
  process.stdout.write(`v2 dashboard fixture on ${server.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
