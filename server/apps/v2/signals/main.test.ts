import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { FLATTEN_POLL_MS } from '../flatten.js';
import { V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { SIGNALS_BEAT_EVERY_MS, SIGNALS_PASS_STUCK_MS } from './liveness.js';
import { SIGNAL_POLL_MS } from './loop.js';
import { composeSignals, main, parsePort, parseSignalsArgs, signalsHeartbeat } from './main.js';

const rootMock = vi.hoisted(() => ({
  hang: false,
  flatten: undefined as (() => Promise<unknown>) | undefined,
}));

vi.mock('../index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../index.js')>();
  return {
    ...real,
    composeV2Root: (...args: Parameters<typeof real.composeV2Root>) =>
      rootMock.hang || rootMock.flatten !== undefined
        ? {
            processSignals: () => new Promise<never>(() => {}),
            flatten: rootMock.flatten,
            close: () => {},
          }
        : real.composeV2Root(...args),
  };
});

const clock = { now: () => new Date('2026-09-30T15:00:00.000Z') };
const dirs: string[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-signals-'));
  dirs.push(dir);
  return join(dir, 'v2.sqlite');
}

function seedHalt(storePath: string): void {
  const db = openSharedStore(storePath);
  db.prepare(
    `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
     VALUES ('halt', 'Telegram flatten confirmed', 'telegram', 'signals-main-halt', ?)`,
  ).run(clock.now().toISOString());
  db.close();
}

afterEach(() => {
  rootMock.hang = false;
  rootMock.flatten = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseSignalsArgs', () => {
  it('defaults to the paper store on port 8789', () => {
    expect(parseSignalsArgs([], {})).toEqual({
      storePath: V2_STORE_PATH,
      port: 8789,
      dryRun: false,
    });
  });

  it('reads --dry-run, --store and V2_SIGNALS_PORT', () => {
    expect(parseSignalsArgs(['--dry-run'], {})).toEqual({
      storePath: V2_DRY_RUN_STORE_PATH,
      port: 8789,
      dryRun: true,
    });
    expect(parseSignalsArgs(['--store', 'x.sqlite'], { V2_SIGNALS_PORT: '9001' })).toEqual({
      storePath: 'x.sqlite',
      port: 9001,
      dryRun: false,
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
  it('migrates the store, serves signals on loopback, and a new signal starts a processor pass', async () => {
    const logs: LogEntry[] = [];
    const { server, db, loop } = composeSignals(
      { storePath: tempStorePath(), port: 0, dryRun: false },
      clock,
      {},
      { log: (entry) => logs.push(entry) },
    );
    try {
      await server.start();
      const reply = await fetch(`${server.url}/api/v2/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'INTC', entry: 24.5, targets: [26], stop: 23 }),
      });
      expect(reply.status).toBe(201);
      expect(db.prepare('SELECT symbol FROM v2_signals').all()).toEqual([{ symbol: 'INTC' }]);
      await loop.tick();
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'v2_signal_pass_failed',
          message: expect.stringContaining('refuses a paper run without NOUS_BASE_URL'),
        }),
      );
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('pings fail through its heartbeat after five failed passes in a row', async () => {
    const beats: string[] = [];
    const logs: LogEntry[] = [];
    const failedPasses = () => logs.filter((e) => e.event === 'v2_signal_pass_failed').length;
    const { server, db, loop } = composeSignals(
      { storePath: tempStorePath(), port: 0, dryRun: false },
      clock,
      {},
      { log: (entry) => logs.push(entry) },
      (outcome) => {
        beats.push(outcome);
        return Promise.resolve();
      },
    );
    try {
      await server.start();
      await fetch(`${server.url}/api/v2/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'INTC', entry: 24.5, targets: [26], stop: 23 }),
      });
      await loop.tick();
      while (failedPasses() < 4) await loop.tick();
      expect(failedPasses()).toBe(4);
      expect(beats).toEqual([]);
      await loop.tick();
      expect(failedPasses()).toBe(5);
      expect(beats).toEqual(['fail']);
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('holds its success ping while a pass hangs past the bound', async () => {
    rootMock.hang = true;
    let nowMs = clock.now().getTime();
    const beats: string[] = [];
    const { server, db, liveness } = composeSignals(
      { storePath: tempStorePath(), port: 0, dryRun: false },
      { now: () => new Date(nowMs) },
      {},
      { log: () => {} },
      (outcome) => {
        beats.push(outcome);
        return Promise.resolve();
      },
    );
    try {
      await server.start();
      await fetch(`${server.url}/api/v2/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'INTC', entry: 24.5, targets: [26], stop: 23 }),
      });
      nowMs += SIGNALS_BEAT_EVERY_MS;
      liveness.beat();
      expect(beats).toEqual(['success']);
      nowMs += SIGNALS_PASS_STUCK_MS;
      liveness.beat();
      expect(beats).toEqual(['success']);
    } finally {
      await server.stop();
      db.close();
    }
  });
});

describe('composeSignals flatten poller (#1894)', () => {
  it('opens a root for a new flatten and routes its failure through the alerts logger, then flushes', async () => {
    const storePath = tempStorePath();
    seedHalt(storePath);
    const alerted: LogEntry[] = [];
    let flushes = 0;
    const { db, flatten } = composeSignals(
      { storePath, port: 0, dryRun: false },
      clock,
      {},
      { log: () => {} },
      undefined,
      {
        logger: { log: (entry) => alerted.push(entry) },
        flush: () => {
          flushes += 1;
          return Promise.resolve();
        },
        notify: () => Promise.resolve(),
      },
    );
    try {
      await flatten.tick();
      expect(alerted).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'v2_flatten_failed',
          message: expect.stringContaining('refuses a paper run without NOUS_BASE_URL'),
        }),
      );
      expect(flushes).toBe(1);
    } finally {
      db.close();
    }
  });
});

const NOUS_ENV = { NOUS_BASE_URL: 'https://nous.test/v1', NOUS_API_KEY: 'present' };
const noPinCheck = () => Promise.resolve();

describe('main', () => {
  it('refuses a paper run without Nous keys before checking pins or binding', async () => {
    const pinCheck = vi.fn(noPinCheck);
    await expect(
      main(['--store', tempStorePath()], { V2_SIGNALS_PORT: '0' }, pinCheck),
    ).rejects.toThrow(/without NOUS_BASE_URL/);
    expect(pinCheck).not.toHaveBeenCalled();
  });

  it('does not bind when the pin check fails', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      main(['--store', tempStorePath()], { ...NOUS_ENV, V2_SIGNALS_PORT: '0' }, () =>
        Promise.reject(new Error('pin drift')),
      ),
    ).rejects.toThrow('pin drift');
    expect(write).not.toHaveBeenCalled();
  });

  it('prints the Swagger URL and stops on SIGTERM', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = process.listenerCount('SIGTERM');
    const pinCheck = vi.fn(noPinCheck);
    await main(['--store', tempStorePath()], { ...NOUS_ENV, V2_SIGNALS_PORT: '0' }, pinCheck);
    expect(pinCheck).toHaveBeenCalledWith(false, expect.objectContaining(NOUS_ENV));
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
        main(
          ['--store', tempStorePath()],
          { ...NOUS_ENV, V2_SIGNALS_PORT: String(port) },
          noPinCheck,
        ),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  describe('liveness ping', () => {
    const PING_URL = 'https://hc-ping.test/signals-check';
    const okFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200 });

    async function bootAndRun(
      env: NodeJS.ProcessEnv,
      fetchImpl: ReturnType<typeof okFetch>,
      runMs: number,
    ): Promise<string[]> {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const sigintBefore = new Set(process.listeners('SIGINT'));
      await main(
        ['--store', tempStorePath()],
        { ...NOUS_ENV, V2_SIGNALS_PORT: '0', ...env },
        noPinCheck,
        fetchImpl,
      );
      await vi.advanceTimersByTimeAsync(runMs);
      process.emit('SIGTERM');
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
      }
      return stderr.mock.calls.map(([chunk]) => String(chunk));
    }

    it('pings the signals check only after a full interval of uptime', async () => {
      const fetchImpl = okFetch();
      await bootAndRun(
        { HEALTHCHECKS_SIGNALS_PING_URL: PING_URL },
        fetchImpl,
        SIGNALS_BEAT_EVERY_MS - SIGNAL_POLL_MS,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('then pings it once per interval', async () => {
      const fetchImpl = okFetch();
      await bootAndRun(
        { HEALTHCHECKS_SIGNALS_PING_URL: PING_URL },
        fetchImpl,
        SIGNALS_BEAT_EVERY_MS * 2 + SIGNAL_POLL_MS,
      );
      expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
        [PING_URL, 'POST'],
        [PING_URL, 'POST'],
      ]);
    });

    it('warns once at start and never pings when the URL is unset', async () => {
      const fetchImpl = okFetch();
      const lines = await bootAndRun({}, fetchImpl, SIGNALS_BEAT_EVERY_MS * 2);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(lines.filter((line) => line.includes('v2_signals_heartbeat_unset'))).toHaveLength(1);
    });
  });

  it('polls for a flatten at start and every minute, and sends its result to Telegram', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const storePath = tempStorePath();
    seedHalt(storePath);
    const flatten = vi
      .fn()
      .mockRejectedValueOnce(new Error('lease table locked'))
      .mockResolvedValue({ ran: true, result: { outcome: 'closed', detail: 'nothing held' } });
    rootMock.flatten = flatten;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sigintBefore = new Set(process.listeners('SIGINT'));
    await main(
      ['--store', storePath],
      {
        ...NOUS_ENV,
        V2_SIGNALS_PORT: '0',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '42',
      },
      noPinCheck,
      fetchImpl,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(flatten).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FLATTEN_POLL_MS);
    expect(flatten).toHaveBeenCalledTimes(2);
    process.emit('SIGTERM');
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
    }
    const sent = fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body).text]);
    expect(sent).toEqual([
      [
        'https://api.telegram.org/botbot-token/sendMessage',
        expect.stringMatching(/^Samurai v2 CRITICAL\nv2_flatten_failed: lease table locked$/),
      ],
      [
        'https://api.telegram.org/botbot-token/sendMessage',
        'Flatten done (control 1): every position has its exit in flight. nothing held',
      ],
    ]);
  });

  describe('signalsHeartbeat', () => {
    it('is silent in a dry run even with the URL set', async () => {
      const fetchImpl = vi.fn();
      const logs: LogEntry[] = [];
      const beat = signalsHeartbeat(
        { storePath: 'x', port: 0, dryRun: true },
        { HEALTHCHECKS_SIGNALS_PING_URL: 'https://hc-ping.test/x' },
        fetchImpl,
        { log: (entry) => logs.push(entry) },
      );
      await beat('success');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    });
  });
});
