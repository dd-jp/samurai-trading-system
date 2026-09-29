import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BAR_STORE_ROOT } from '../../../providers/bar-store/index.js';
import type { LogEntry } from '../../../shared/index.js';
import { openMigratedStore, openSharedStore } from '../../../shared/store/index.js';
import { FX_PATH, V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { ControlStore } from '../risk/index.js';
import type { BotFetch, BotResponse } from './telegram-bot.js';
import {
  botTokenFrom,
  COMMANDS_SCHEMA_VERSION,
  composeTelegram,
  ownerChatIdFrom,
  parseTelegramArgs,
} from './telegram-main.js';

const TOKEN = '123456789:AAH-test-token-abcdefghijklmnop';
const OWNER = 424242;
const STRANGER = 777;
const NOW = new Date('2026-09-29T10:00:00.000Z');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
    const fetchImpl: BotFetch = (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
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
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: String(OWNER) },
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
    expect(logs).toEqual([]);

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
