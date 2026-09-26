import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSharedStore } from '../../../shared/store/index.js';
import { V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { composeV2Dashboard, parseDashboardArgs } from './main.js';

const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };
const dirs: string[] = [];

function migratedStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-'));
  dirs.push(dir);
  const path = join(dir, 'v2.sqlite');
  openSharedStore(path).close();
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseDashboardArgs', () => {
  it('defaults to the paper store on loopback', () => {
    expect(parseDashboardArgs([], {})).toEqual({
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
    ).toEqual({ storePath: 'x.sqlite', mode: 'paper', host: '0.0.0.0', port: 9000 });
  });

  it.each(['abc', '1.5', '-1', '65536'])('refuses a bad port %j', (port) => {
    expect(() => parseDashboardArgs([], { V2_DASHBOARD_PORT: port })).toThrow(/V2_DASHBOARD_PORT/);
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
      { storePath, mode: 'paper', host: '127.0.0.1', port: 0 },
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
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('closes the store when the server refuses to start without a token', () => {
    const storePath = migratedStore();
    expect(() =>
      composeV2Dashboard({ storePath, mode: 'paper', host: '127.0.0.1', port: 0 }, {}, clock),
    ).toThrow(/SAMURAI_DASHBOARD_TOKEN is not set/);
  });

  it('refuses a store that does not exist rather than creating an empty one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-'));
    dirs.push(dir);
    expect(() =>
      composeV2Dashboard(
        { storePath: join(dir, 'missing.sqlite'), mode: 'paper', host: '127.0.0.1', port: 0 },
        { SAMURAI_DASHBOARD_TOKEN: 'tok-123456' },
        clock,
      ),
    ).toThrow();
  });
});
