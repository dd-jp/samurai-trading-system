import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BAR_STORE_ROOT } from '../../../providers/bar-store/index.js';
import { migratedTemplate, openSharedStore } from '../../../shared/store/index.js';
import { listMigrations, MIGRATIONS_DIR } from '../../../shared/store/migrate.js';
import { FX_SNAPSHOT_PATH } from '../data/index.js';
import { FX_PATH, V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { researchStorePath } from '../trial-ledger.js';
import {
  composeV2Dashboard,
  DASHBOARD_SCHEMA_VERSION,
  parseDashboardArgs,
  readFxOrNone,
  reloadingFx,
  reloadingFxMarket,
} from './main.js';

const DEFAULT_PATHS = {
  barStoreRoot: DEFAULT_BAR_STORE_ROOT,
  fxPath: FX_PATH,
  researchStorePath: researchStorePath({}),
  bundleRoot: 'dist/client',
};
const TEST_FX_DIR = mkdtempSync(join(tmpdir(), 'v2-dashboard-fx-'));
const PATHS = { ...DEFAULT_PATHS, fxPath: join(TEST_FX_DIR, 'fx.csv') };
copyFileSync(FX_SNAPSHOT_PATH, PATHS.fxPath);
afterAll(() => rmSync(TEST_FX_DIR, { recursive: true, force: true }));
const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };
const dirs: string[] = [];
function migratedStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-'));
  dirs.push(dir);
  const path = join(dir, 'v2.sqlite');
  writeFileSync(path, migratedTemplate().serialize());
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseDashboardArgs', () => {
  it('defaults to the paper store on loopback', () => {
    expect(parseDashboardArgs([], {})).toEqual({
      ...DEFAULT_PATHS,
      storePath: V2_STORE_PATH,
      mode: 'paper',
      host: '127.0.0.1',
      port: 8788,
    });
  });

  it('reads the dry-run store, an explicit store, HOST and V2_DASHBOARD_PORT', () => {
    expect(parseDashboardArgs(['--dry-run'], {})).toMatchObject({
      storePath: V2_DRY_RUN_STORE_PATH,
      mode: 'dry-run',
    });
    expect(
      parseDashboardArgs(['--store', 'x.sqlite'], { HOST: '0.0.0.0', V2_DASHBOARD_PORT: '9000' }),
    ).toEqual({
      ...DEFAULT_PATHS,
      storePath: 'x.sqlite',
      mode: 'paper',
      host: '0.0.0.0',
      port: 9000,
    });
  });

  it.each([
    ['0', 0],
    ['65535', 65_535],
  ])('accepts the boundary port %j', (raw, port) => {
    expect(parseDashboardArgs([], { V2_DASHBOARD_PORT: raw }).port).toBe(port);
  });

  it.each(['abc', '1.5', '-1', '65536'])('refuses a bad port %j', (port) => {
    expect(() => parseDashboardArgs([], { V2_DASHBOARD_PORT: port })).toThrow(/V2_DASHBOARD_PORT/);
  });

  it('refuses --store with --dry-run, which always reads the dry-run store', () => {
    expect(() => parseDashboardArgs(['--dry-run', '--store', 'x.sqlite'], {})).toThrow(
      /--store and --dry-run are exclusive/,
    );
  });

  it('refuses an unknown flag', () => {
    expect(() => parseDashboardArgs(['--live'], {})).toThrow();
  });
});

describe('composeV2Dashboard', () => {
  it('serves the store it was pointed at, writing controls through the dashboard owner', async () => {
    const storePath = migratedStore();
    const env = { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' };
    const { server, db } = composeV2Dashboard(
      { ...PATHS, storePath, mode: 'paper', host: '127.0.0.1', port: 0 },
      env,
      clock,
    );
    try {
      await server.start();
      const response = await fetch(`${server.url}/api/v2/controls`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-123456', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', reason: 'check', idempotency_key: 'key-0001' }),
      });
      expect(response.status).toBe(201);
      expect(db.prepare('SELECT action FROM v2_controls').all()).toEqual([{ action: 'pause' }]);
      const overview = await fetch(`${server.url}/api/v2/overview`, {
        headers: { Authorization: 'Bearer tok-123456' },
      });
      expect(await overview.json()).toMatchObject({ control: { state: 'paused' } });
    } finally {
      await server.stop();
      db.close();
    }
  });

  it.each([
    ['NODE_ENV', 'production'],
    ['SAMURAI_MODE', 'live'],
    ['SAMURAI_STORE_GUARD', 'off'],
  ])('keeps the write guard on when %s=%s switches it off elsewhere', (name, value) => {
    vi.stubEnv(name, value);
    const { db, store } = composeV2Dashboard(
      { ...PATHS, storePath: migratedStore(), mode: 'paper', host: '127.0.0.1', port: 0 },
      { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' },
      clock,
    );
    try {
      expect(() => store.prepare('DELETE FROM v2_book_days').run()).toThrow(/v2_book_days/);
    } finally {
      db.close();
    }
  });

  it('closes the store when the server refuses to start without a token', () => {
    const storePath = migratedStore();
    expect(() =>
      composeV2Dashboard(
        { ...PATHS, storePath, mode: 'paper', host: '127.0.0.1', port: 0 },
        {},
        clock,
      ),
    ).toThrow(/SAMURAI_DASHBOARD_TOKEN is not set/);
  });

  it('starts without the FX file, so the controls stay up, with USD marks unavailable', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { server, db } = composeV2Dashboard(
      {
        ...PATHS,
        fxPath: join(tmpdir(), 'no-such-fx.csv'),
        storePath: migratedStore(),
        mode: 'paper',
        host: '127.0.0.1',
        port: 0,
      },
      { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' },
      clock,
    );
    try {
      db.prepare(
        `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
         VALUES ('debate/primary', 'debate', 'primary', 1000, 1000, 'x')`,
      ).run();
      db.prepare(
        `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
           size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
         VALUES ('debate/primary', '2026-10-05', 1000, 1000, 0, 0, 1, 0, 0, 'x')`,
      ).run();
      await server.start();
      const response = await fetch(`${server.url}/api/v2/overview`, {
        headers: { Authorization: 'Bearer tok-123456' },
      });
      expect(await response.json()).toMatchObject({ positions: { status: 'fed', fx: null } });
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/no FX rates/));
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('reads --bars, --fx, --research and --bundle', () => {
    expect(
      parseDashboardArgs(
        ['--bars', 'b', '--fx', 'f.csv', '--research', 'r.sqlite', '--bundle', 'web'],
        {},
      ),
    ).toMatchObject({
      barStoreRoot: 'b',
      fxPath: 'f.csv',
      researchStorePath: 'r.sqlite',
      bundleRoot: 'web',
    });
  });

  it('defaults the research store to SAMURAI_RESEARCH_STORE, as the trial ledger does', () => {
    expect(
      parseDashboardArgs([], { SAMURAI_RESEARCH_STORE: '/r/ledger.sqlite' }).researchStorePath,
    ).toBe('/r/ledger.sqlite');
  });

  it('serves the journal and the research store it was pointed at', async () => {
    const storePath = migratedStore();
    const research = join(dirname(storePath), 'research.sqlite');
    const ledger = openSharedStore(research);
    ledger
      .prepare(
        `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
         VALUES (1, 'trend', 'h1', '{}', 'v2', 'x')`,
      )
      .run();
    ledger.close();
    const { server, db } = composeV2Dashboard(
      {
        ...PATHS,
        researchStorePath: research,
        storePath,
        mode: 'paper',
        host: '127.0.0.1',
        port: 0,
      },
      { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' },
      clock,
    );
    try {
      db.prepare(
        `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
         VALUES ('2026-10-05', 'cycle', 'P', '#1', 'm', 'x')`,
      ).run();
      await server.start();
      const headers = { Authorization: 'Bearer tok-123456' };
      const journal = await fetch(`${server.url}/api/v2/journal?limit=1`, { headers });
      expect(await journal.json()).toMatchObject({
        days: [{ trading_date: '2026-10-05', refusals: [{ parameter: 'P' }] }],
      });
      const served = await fetch(`${server.url}/api/v2/research`, { headers });
      expect(await served.json()).toMatchObject({ ledger: { status: 'fed', total_trials: 1 } });
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('refuses a store that does not exist rather than creating an empty one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-'));
    dirs.push(dir);
    expect(() =>
      composeV2Dashboard(
        {
          ...PATHS,
          storePath: join(dir, 'missing.sqlite'),
          mode: 'paper',
          host: '127.0.0.1',
          port: 0,
        },
        { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' },
        clock,
      ),
    ).toThrow();
  });
});

describe('readFxOrNone', () => {
  it('restores a deleted FX file from its snapshot before reading it (#2000)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-fx-seed-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'fx.snapshot.csv'), 'DATE,XUDLUSS\n24 Sep 2026,1.322\n');
    const path = join(dir, 'fx.csv');
    expect(readFxOrNone(path)).toEqual([{ date: '2026-09-24', gbpUsd: 1.322 }]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('reloadingFx', () => {
  it('re-reads the file only when it changes, and reads a missing file as no rates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-fx-'));
    dirs.push(dir);
    const path = join(dir, 'fx.csv');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fx = reloadingFx(path);
    expect(fx()).toEqual([]);
    writeFileSync(path, 'DATE,XUDLUSS\n24 Sep 2026,1.322\n');
    const first = fx();
    expect(first).toEqual([{ date: '2026-09-24', gbpUsd: 1.322 }]);
    expect(fx()).toBe(first);
    writeFileSync(path, 'DATE,XUDLUSS\n24 Sep 2026,1.322\n25 Sep 2026,1.3301\n');
    expect(fx().at(-1)).toEqual({ date: '2026-09-25', gbpUsd: 1.3301 });
    rmSync(path);
    expect(fx()).toEqual([]);
    const unread = stderr.mock.calls.filter(([text]) => String(text).includes(path));
    expect(unread).toHaveLength(2);
    stderr.mockRestore();
  });
});

describe('the dashboard schema floor', () => {
  it('is at least the migration that adds the heartbeat ping table the overview reads', () => {
    const ping = listMigrations(MIGRATIONS_DIR).find((m) =>
      m.filename.includes('v2_heartbeat_pings'),
    );
    expect(ping).toBeDefined();
    expect(DASHBOARD_SCHEMA_VERSION).toBeGreaterThanOrEqual(ping?.version ?? Infinity);
  });
});

describe('reloadingFxMarket (#2009)', () => {
  it('prices the year start from the latest series the reload hands it, not the startup copy', () => {
    let series: ReturnType<typeof readFxOrNone> = [{ date: '2026-12-19', gbpUsd: 1.31 }];
    const fx = vi.fn(() => series);
    const market = reloadingFxMarket(fx);
    expect(market.gbpUsdAtYearStart(2027)).toBe(1.31);
    expect(market.gbpUsdYearStartFixDate?.(2027)).toBe('2026-12-19');
    series = [...series, { date: '2026-12-31', gbpUsd: 1.32 }];
    expect(market.gbpUsdAtYearStart(2027)).toBe(1.32);
    expect(market.gbpUsdYearStartFixDate?.(2027)).toBe('2026-12-31');
    series = [];
    expect(() => market.gbpUsdAtYearStart(2027)).toThrow(/no GBPUSD/);
  });
});
