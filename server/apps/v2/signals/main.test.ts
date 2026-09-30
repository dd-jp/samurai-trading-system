import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { composeSignals, main, parsePort, parseSignalsArgs } from './main.js';

const clock = { now: () => new Date('2026-09-30T15:00:00.000Z') };
const dirs: string[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-signals-'));
  dirs.push(dir);
  return join(dir, 'v2.sqlite');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseSignalsArgs', () => {
  it('defaults to the paper store on port 8789', () => {
    expect(parseSignalsArgs([], {})).toEqual({ storePath: V2_STORE_PATH, port: 8789 });
  });

  it('reads --dry-run, --store and V2_SIGNALS_PORT', () => {
    expect(parseSignalsArgs(['--dry-run'], {})).toEqual({
      storePath: V2_DRY_RUN_STORE_PATH,
      port: 8789,
    });
    expect(parseSignalsArgs(['--store', 'x.sqlite'], { V2_SIGNALS_PORT: '9001' })).toEqual({
      storePath: 'x.sqlite',
      port: 9001,
    });
  });

  it('refuses --store with --dry-run and unknown flags', () => {
    expect(() => parseSignalsArgs(['--dry-run', '--store', 'x.sqlite'], {})).toThrow(/exclusive/);
    expect(() => parseSignalsArgs(['--host', '0.0.0.0'], {})).toThrow();
  });
});

describe('parsePort', () => {
  it.each([
    ['0', 0],
    ['65535', 65_535],
  ])('accepts %j', (raw, port) => {
    expect(parsePort(raw)).toBe(port);
  });

  it.each(['-1', '65536', '80.5', 'http'])('refuses %j', (raw) => {
    expect(() => parsePort(raw)).toThrow(/V2_SIGNALS_PORT/);
  });
});

describe('composeSignals', () => {
  it('migrates the store and serves signals on loopback', async () => {
    const { server, db } = composeSignals({ storePath: tempStorePath(), port: 0 }, clock);
    try {
      await server.start();
      const reply = await fetch(`${server.url}/api/v2/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'INTC', entry: 24.5, targets: [26], stop: 23 }),
      });
      expect(reply.status).toBe(201);
      expect(db.prepare('SELECT symbol FROM v2_signals').all()).toEqual([{ symbol: 'INTC' }]);
    } finally {
      await server.stop();
      db.close();
    }
  });
});

describe('main', () => {
  it('prints the Swagger URL and stops on SIGTERM', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = process.listenerCount('SIGTERM');
    await main(['--store', tempStorePath()], { V2_SIGNALS_PORT: '0' });
    expect(String(write.mock.calls[0]?.[0])).toMatch(
      /^v2 signals API on http:\/\/127\.0\.0\.1:\d+ \(Swagger UI at http:\/\/127\.0\.0\.1:\d+\/docs\)\n$/,
    );
    process.emit('SIGTERM');
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
    }
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('closes the store and rethrows when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await expect(
        main(['--store', tempStorePath()], { V2_SIGNALS_PORT: String(port) }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
