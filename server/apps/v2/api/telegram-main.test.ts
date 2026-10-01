import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BAR_STORE_ROOT } from '../../../providers/bar-store/index.js';
import type { LogEntry } from '../../../shared/index.js';
import {
  openMigratedStore,
  openSharedStore,
  type StoreHandle,
} from '../../../shared/store/index.js';
import { FX_PATH, V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { ControlStore } from '../risk/index.js';
import type { BotResponse } from './telegram-bot.js';
import {
  botTokenFrom,
  COMMANDS_SCHEMA_VERSION,
  composeTelegram,
  main,
  ownerChatIdFrom,
  parseTelegramArgs,
  type TelegramFetch,
} from './telegram-main.js';

const storeCalls = vi.hoisted(() => ({
  opened: [] as StoreHandle[],
  guarded: [] as unknown[][],
}));

vi.mock('../../../shared/store/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/store/index.js')>();
  return {
    ...real,
    openMigratedStore: (...args: Parameters<typeof real.openMigratedStore>) => {
      const db = real.openMigratedStore(...args);
      storeCalls.opened.push(db);
      return db;
    },
    guardedStore: (...args: Parameters<typeof real.guardedStore>) => {
      storeCalls.guarded.push(args.slice(1));
      return real.guardedStore(...args);
    },
  };
});

const TOKEN = '123456789:AAH-test-token-abcdefghijklmnop';
const OWNER = 424242;
const STRANGER = 777;
const NOW = new Date('2026-09-29T10:00:00.000Z');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  storeCalls.opened.length = 0;
  storeCalls.guarded.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migratedStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-telegram-'));
  dirs.push(dir);
  const path = join(dir, 'v2.sqlite');
  openSharedStore(path).close();
  return path;
}

describe('parseTelegramArgs', () => {
  it('defaults to the paper store', () => {
    expect(parseTelegramArgs([])).toEqual({
      dryRun: false,
      storePath: V2_STORE_PATH,
      barStoreRoot: DEFAULT_BAR_STORE_ROOT,
      fxPath: FX_PATH,
    });
  });

  it('points --dry-run at the dry-run store', () => {
    expect(parseTelegramArgs(['--dry-run'])).toMatchObject({
      dryRun: true,
      storePath: V2_DRY_RUN_STORE_PATH,
    });
  });

  it('takes an explicit store, but not together with --dry-run', () => {
    expect(parseTelegramArgs(['--store', 'x.sqlite']).storePath).toBe('x.sqlite');
    expect(() => parseTelegramArgs(['--dry-run', '--store', 'x.sqlite'])).toThrow(/exclusive/);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseTelegramArgs(['--wat'])).toThrow();
  });
});

describe('ownerChatIdFrom', () => {
  it('reads the one owner user id, trimmed', () => {
    expect(ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: ' 424242 ' })).toBe(424242);
  });

  it('ignores TELEGRAM_CHAT_ID, which stays the alert destination and may be a group', () => {
    expect(
      ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: '424242', TELEGRAM_CHAT_ID: '-1001234567890' }),
    ).toBe(424242);
    expect(() => ownerChatIdFrom({ TELEGRAM_CHAT_ID: '424242' })).toThrow(
      /TELEGRAM_ALLOWED_USER_IDS is not set/,
    );
  });

  it.each([undefined, '', ' \t '])('refuses %j as unset', (raw) => {
    expect(() => ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: raw })).toThrow(
      "TELEGRAM_ALLOWED_USER_IDS is not set: it must hold the owner's Telegram user id",
    );
  });

  it.each(['424242,555', '424242, 555', '424242 555', '424242;555', '424242,'])(
    'refuses %j: there is exactly one owner',
    (raw) => {
      expect(() => ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: raw })).toThrow(
        'TELEGRAM_ALLOWED_USER_IDS must hold exactly one user id: the system has one owner, whose private chat id equals their user id',
      );
    },
  );

  it.each([
    'abc',
    '-1001234567890',
    '0',
    '012',
    '12.5',
    '1'.repeat(17),
    'x424242',
    '424242x',
    '1e3',
  ])('refuses %j: only a positive user id is safe to command from', (raw) => {
    expect(() => ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: raw })).toThrow(
      "TELEGRAM_ALLOWED_USER_IDS must be the owner's positive Telegram user id: a group or channel id would let its members command the system",
    );
  });

  it('accepts ids up to the largest safe integer and refuses the next, which would round', () => {
    expect(ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: '9007199254740991' })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => ownerChatIdFrom({ TELEGRAM_ALLOWED_USER_IDS: '9007199254740993' })).toThrow(
      /positive Telegram user id/,
    );
  });
});

describe('botTokenFrom', () => {
  it('needs a token', () => {
    expect(botTokenFrom({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(() => botTokenFrom({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

interface Sent {
  chat_id: number;
  text: string;
}

const PING_URL = 'https://hc-ping.test/telegram-check';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: String(OWNER) };
const ONLINE = 'Samurai v2 Telegram commands online. Send status, halt, resume or flatten.';

function reply(body: unknown): BotResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

describe('composeTelegram, every command against a real store', () => {
  it('runs status, halt, flatten with its code, and resume end to end, refuses a stranger, journals all of it', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const storePath = migratedStore();
    const shutdown = new AbortController();
    const sent: Sent[] = [];
    let clockMs = NOW.getTime();
    const steps: ((lastReply: string) => { text: string; chat: number })[] = [
      () => ({ text: 'status', chat: OWNER }),
      () => ({ text: 'halt', chat: OWNER }),
      () => ({ text: 'flatten', chat: STRANGER }),
      () => ({ text: 'flatten', chat: OWNER }),
      (lastReply) => ({ text: `flatten ${/flatten (\d{4})$/.exec(lastReply)?.[1]}`, chat: OWNER }),
      () => ({ text: 'resume', chat: OWNER }),
    ];
    let updateId = 0;
    const pings: string[] = [];
    const fetchImpl: TelegramFetch = (url, init) => {
      if (url.startsWith(PING_URL)) {
        pings.push(url);
        return Promise.resolve(reply({}));
      }
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      if (url.endsWith('/sendMessage')) {
        sent.push(body as unknown as Sent);
        return Promise.resolve(reply({ ok: true }));
      }
      const step = steps.shift();
      if (step === undefined) {
        shutdown.abort();
        return Promise.resolve(reply({ ok: true, result: [] }));
      }
      clockMs += 20_000;
      updateId += 1;
      const { text, chat } = step(sent.at(-1)?.text ?? '');
      const message = {
        date: Math.floor(clockMs / 1_000),
        text,
        chat: { id: chat, type: 'private' },
        from: { id: chat },
      };
      return Promise.resolve(reply({ ok: true, result: [{ update_id: updateId, message }] }));
    };
    const logs: LogEntry[] = [];
    const composed = composeTelegram(
      parseTelegramArgs(['--store', storePath]),
      { ...ENV, HEALTHCHECKS_TELEGRAM_PING_URL: PING_URL },
      { now: () => new Date(clockMs) },
      fetchImpl,
      { log: (entry) => logs.push(entry) },
    );
    try {
      await composed.run(shutdown.signal);
    } finally {
      composed.db.close();
    }

    const texts = sent.map((message) => message.text);
    expect(texts[0]).toMatch(/commands online/);
    expect(texts[1]).toMatch(/^Samurai v2 status \(paper\)\nState: RUNNING/);
    expect(texts[2]).toMatch(/^Paused:/);
    expect(texts[3]).toMatch(/Nothing happens yet.*flatten \d{4}$/);
    expect(texts[4]).toMatch(/^Flatten recorded/);
    expect(texts[5]).toMatch(/^Resumed/);
    expect(texts).toHaveLength(6);
    expect(sent.every((message) => message.chat_id === OWNER)).toBe(true);
    expect(pings).toEqual([PING_URL]);
    expect(logs.map((entry) => entry.event)).toEqual(['v2_heartbeat_sent']);

    const db = openMigratedStore(storePath, COMMANDS_SCHEMA_VERSION);
    try {
      expect(
        db.prepare('SELECT action, source FROM v2_controls ORDER BY control_id').all(),
      ).toEqual([
        { action: 'pause', source: 'telegram' },
        { action: 'halt', source: 'telegram' },
        { action: 'resume', source: 'telegram' },
      ]);
      expect(
        db.prepare('SELECT command, outcome, chat_id FROM v2_commands ORDER BY command_id').all(),
      ).toEqual([
        { command: 'status', outcome: 'answered', chat_id: String(OWNER) },
        { command: 'halt', outcome: 'applied', chat_id: String(OWNER) },
        { command: 'flatten', outcome: 'refused_unauthorized', chat_id: String(STRANGER) },
        { command: 'flatten', outcome: 'confirmation_requested', chat_id: String(OWNER) },
        { command: 'flatten', outcome: 'applied', chat_id: String(OWNER) },
        { command: 'resume', outcome: 'applied', chat_id: String(OWNER) },
      ]);
      expect(new ControlStore(db).current()).toEqual({ state: 'running' });
    } finally {
      db.close();
    }
  });

  it('refuses to start against a store the v2 root has not migrated to the commands schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-telegram-'));
    dirs.push(dir);
    expect(() =>
      composeTelegram(
        parseTelegramArgs(['--store', join(dir, 'missing.sqlite')]),
        { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: String(OWNER) },
        { now: () => NOW },
        () => Promise.reject(new Error('unused')),
        { log: () => undefined },
      ),
    ).toThrow();
  });

  it('refuses to start without the owner user id, before touching the store', () => {
    expect(() =>
      composeTelegram(
        parseTelegramArgs(['--store', '/nonexistent/v2.sqlite']),
        { TELEGRAM_BOT_TOKEN: TOKEN },
        { now: () => NOW },
        () => Promise.reject(new Error('unused')),
        { log: () => undefined },
      ),
    ).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });
});

function messageFrom(updateId: number, text: string, chat = OWNER) {
  return {
    update_id: updateId,
    message: {
      date: Math.floor(NOW.getTime() / 1_000),
      text,
      chat: { id: chat, type: 'private' },
      from: { id: chat },
    },
  };
}

interface Bench {
  readonly fetchImpl: TelegramFetch;
  readonly sent: Sent[];
  readonly pings: string[];
}

function bench(
  shutdown: AbortController,
  batches: unknown[][],
  options: { failSend?: number } = {},
): Bench {
  const sent: Sent[] = [];
  const pings: string[] = [];
  let sends = 0;
  const fetchImpl: TelegramFetch = (url, init) => {
    if (url.startsWith(PING_URL)) {
      pings.push(url);
      return Promise.resolve(reply({}));
    }
    if (url.endsWith('/sendMessage')) {
      sends += 1;
      if (sends === options.failSend) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      }
      sent.push(JSON.parse(init.body ?? '{}') as Sent);
      return Promise.resolve(reply({ ok: true }));
    }
    const next = batches.shift();
    if (next === undefined) shutdown.abort();
    return Promise.resolve(reply({ ok: true, result: next ?? [] }));
  };
  return { fetchImpl, sent, pings };
}

async function runComposed(
  args: Parameters<typeof composeTelegram>[0],
  env: NodeJS.ProcessEnv,
  fetchImpl: TelegramFetch,
  logs: LogEntry[],
  shutdown: AbortController,
): Promise<void> {
  const composed = composeTelegram(args, env, { now: () => NOW }, fetchImpl, {
    log: (entry) => logs.push(entry),
  });
  try {
    await composed.run(shutdown.signal);
  } finally {
    composed.db.close();
  }
}

describe('composeTelegram wiring', () => {
  it('journals 1000 stranger updates from one chat once, replies to none and still answers the owner', async () => {
    const storePath = migratedStore();
    const shutdown = new AbortController();
    const flood = Array.from({ length: 1000 }, (_, i) => messageFrom(i + 1, 'halt', STRANGER));
    const b = bench(shutdown, [[...flood, messageFrom(1001, 'halt')]]);
    await runComposed(parseTelegramArgs(['--store', storePath]), ENV, b.fetchImpl, [], shutdown);
    expect(b.sent).toEqual([
      { chat_id: OWNER, text: ONLINE },
      {
        chat_id: OWNER,
        text: 'Paused: no new entries from the next cycle. Open positions keep their resting stops.',
      },
    ]);
    const db = openMigratedStore(storePath, COMMANDS_SCHEMA_VERSION);
    try {
      expect(
        db.prepare('SELECT chat_id, outcome FROM v2_commands ORDER BY command_id').all(),
      ).toEqual([
        { chat_id: String(STRANGER), outcome: 'refused_unauthorized' },
        { chat_id: String(OWNER), outcome: 'applied' },
      ]);
    } finally {
      db.close();
    }
  });

  it('prefixes the start notice and every reply in a dry run, and sends no heartbeat or alert', async () => {
    const shutdown = new AbortController();
    const b = bench(shutdown, [[messageFrom(1, 'status')]]);
    const logs: LogEntry[] = [];
    await runComposed(
      { ...parseTelegramArgs(['--store', migratedStore()]), dryRun: true },
      { ...ENV, HEALTHCHECKS_TELEGRAM_PING_URL: PING_URL, SAMURAI_ALERTS: 'log-only' },
      b.fetchImpl,
      logs,
      shutdown,
    );
    expect(b.sent[0]?.text).toBe(`[dry-run] ${ONLINE}`);
    expect(b.sent[1]?.text).toMatch(/^\[dry-run\] Samurai v2 status \(dry-run\)\n/);
    expect(b.pings).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('builds the paper alert path, which a dry run skips', async () => {
    const shutdown = new AbortController();
    const b = bench(shutdown, []);
    const logs: LogEntry[] = [];
    await runComposed(
      parseTelegramArgs(['--store', migratedStore()]),
      { ...ENV, HEALTHCHECKS_TELEGRAM_PING_URL: PING_URL, SAMURAI_ALERTS: 'log-only' },
      b.fetchImpl,
      logs,
      shutdown,
    );
    expect(b.sent.map((message) => message.text)).toEqual([ONLINE]);
    expect(logs.map((entry) => entry.event)).toContain('v2_alerts_log_only');
  });

  it('warns once at start when the poller heartbeat URL is unset, then never pings', async () => {
    const shutdown = new AbortController();
    const b = bench(shutdown, [[], []]);
    const logs: LogEntry[] = [];
    await runComposed(
      parseTelegramArgs(['--store', migratedStore()]),
      ENV,
      b.fetchImpl,
      logs,
      shutdown,
    );
    expect(b.pings).toEqual([]);
    expect(logs).toEqual([
      {
        trace_id: 'v2-telegram',
        stage: 'v2',
        level: 'warn',
        event: 'v2_telegram_heartbeat_unset',
        message: 'HEALTHCHECKS_TELEGRAM_PING_URL is not set: no healthchecks ping for the poller',
      },
    ]);
  });

  it('logs a failed start notice and keeps polling', async () => {
    const shutdown = new AbortController();
    const b = bench(shutdown, [[messageFrom(1, 'resume')]], { failSend: 1 });
    const logs: LogEntry[] = [];
    await runComposed(
      parseTelegramArgs(['--store', migratedStore()]),
      { ...ENV, HEALTHCHECKS_TELEGRAM_PING_URL: PING_URL },
      b.fetchImpl,
      logs,
      shutdown,
    );
    expect(logs[0]).toEqual({
      trace_id: 'v2-telegram',
      stage: 'v2',
      level: 'warn',
      event: 'v2_telegram_start_notice_failed',
      message: 'Telegram sendMessage answered 500',
    });
    expect(b.sent.map((message) => message.text)).toEqual(['Already running.']);
  });

  it('writes controls and the journal through sole-writer guards that stay on whatever the env says', () => {
    vi.stubEnv('SAMURAI_STORE_GUARD', 'off');
    const composed = composeTelegram(
      parseTelegramArgs(['--store', migratedStore()]),
      ENV,
      { now: () => NOW },
      () => Promise.reject(new Error('unused')),
      { log: () => undefined },
    );
    composed.db.close();
    expect(storeCalls.guarded).toEqual([
      ['dashboard', { enabled: true }],
      ['telegram', { enabled: true }],
    ]);
  });

  it('really waits after a failed poll instead of spinning, and wakes on shutdown', async () => {
    const shutdown = new AbortController();
    let polls = 0;
    const fetchImpl: TelegramFetch = async (url) => {
      if (url.endsWith('/sendMessage')) return reply({ ok: true });
      polls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      throw new TypeError('fetch failed');
    };
    setTimeout(() => shutdown.abort(), 50);
    await runComposed(
      parseTelegramArgs(['--store', migratedStore()]),
      ENV,
      fetchImpl,
      [],
      shutdown,
    );
    expect(polls).toBe(1);
  });
});

describe('main', () => {
  it('runs until SIGTERM, then closes the store', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = process.listenerCount('SIGTERM');
    let polls = 0;
    vi.stubGlobal('fetch', (url: string) => {
      if (!url.endsWith('/sendMessage')) {
        polls += 1;
        process.emit('SIGTERM');
      }
      return Promise.resolve(reply({ ok: true, result: [] }));
    });
    await main(['--store', migratedStore()], ENV);
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
    }
    expect(polls).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(storeCalls.opened).toHaveLength(1);
    expect(storeCalls.opened[0]?.open).toBe(false);
  });

  it('stops on SIGINT too', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sigtermBefore = new Set(process.listeners('SIGTERM'));
    let polls = 0;
    vi.stubGlobal('fetch', (url: string) => {
      if (!url.endsWith('/sendMessage')) {
        polls += 1;
        process.emit('SIGINT');
      }
      return Promise.resolve(reply({ ok: true, result: [] }));
    });
    await main(['--store', migratedStore()], ENV);
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermBefore.has(listener)) process.off('SIGTERM', listener);
    }
    expect(polls).toBe(1);
    expect(storeCalls.opened[0]?.open).toBe(false);
  });

  it('refuses to start without the owner, before opening the store', async () => {
    await expect(
      main(['--store', migratedStore()], { TELEGRAM_BOT_TOKEN: TOKEN }),
    ).rejects.toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
    expect(storeCalls.opened).toEqual([]);
  });
});

describe('entrypoint', () => {
  it('prints the error and exits 1', () => {
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./telegram-main.ts', import.meta.url)), '--wat'],
      { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Unknown option '--wat'/);
  }, 60_000);
});
