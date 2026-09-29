import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import type { TelegramUpdate } from './telegram-commands.js';
import { type PollerDeps, RETRY_AFTER_FAILURE_MS, runPoller } from './telegram-poller.js';

const OWNER = 55;

function update(id: number, text = 'halt'): TelegramUpdate {
  return { update_id: id, message: { date: 0, text, chat: { id: OWNER, type: 'private' } } };
}

interface Rig {
  deps: PollerDeps;
  shutdown: AbortController;
  offsets: (number | undefined)[];
  sent: { chatId: number; text: string }[];
  handled: number[];
  logs: LogEntry[];
  sleeps: number[];
}

function rig(options: {
  batches: (TelegramUpdate[] | Error)[];
  lastUpdateId?: number;
  reply?: (update: TelegramUpdate) => Promise<string | undefined>;
  send?: () => Promise<void>;
}): Rig {
  const shutdown = new AbortController();
  const offsets: (number | undefined)[] = [];
  const sent: { chatId: number; text: string }[] = [];
  const handled: number[] = [];
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const batches = [...options.batches];
  const deps: PollerDeps = {
    bot: {
      getUpdates: (offset) => {
        offsets.push(offset);
        const next = batches.shift();
        if (next === undefined) {
          shutdown.abort();
          return Promise.resolve([]);
        }
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        await options.send?.();
      },
    },
    handler: {
      handle: (incoming) => {
        handled.push(incoming.update_id);
        return options.reply?.(incoming) ?? Promise.resolve(`done ${incoming.update_id}`);
      },
    },
    ownerChatId: OWNER,
    lastUpdateId: () => options.lastUpdateId,
    logger: { log: (entry) => logs.push(entry) },
    replyPrefix: '',
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, shutdown, offsets, sent, handled, logs, sleeps };
}

describe('runPoller', () => {
  it('hands each update to the handler in order and replies to the owner chat', async () => {
    const r = rig({ batches: [[update(10), update(11)]] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.handled).toEqual([10, 11]);
    expect(r.sent).toEqual([
      { chatId: OWNER, text: 'done 10' },
      { chatId: OWNER, text: 'done 11' },
    ]);
  });

  it('acknowledges what it has handled by advancing the offset', async () => {
    const r = rig({ batches: [[update(10), update(11)], [update(12)]] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.offsets).toEqual([undefined, 12, 13]);
  });

  it('resumes after the last update the journal has seen', async () => {
    const r = rig({ batches: [[]], lastUpdateId: 99 });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.offsets[0]).toBe(100);
  });

  it('sends nothing when the handler has no reply', async () => {
    const r = rig({ batches: [[update(10)]], reply: () => Promise.resolve(undefined) });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sent).toEqual([]);
  });

  it('prefixes every reply', async () => {
    const r = rig({ batches: [[update(10)]] });
    await runPoller({ ...r.deps, replyPrefix: '[dry-run] ' }, r.shutdown.signal);
    expect(r.sent[0]?.text).toBe('[dry-run] done 10');
  });

  it('keeps going after a poll failure, backing off and logging without the cause leaking', async () => {
    const r = rig({
      batches: [new Error('Telegram getUpdates answered 409'), [update(10)]],
    });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sleeps).toEqual([RETRY_AFTER_FAILURE_MS]);
    expect(r.handled).toEqual([10]);
    expect(r.logs).toMatchObject([
      {
        level: 'warn',
        event: 'v2_telegram_poll_failed',
        message: 'Telegram getUpdates answered 409',
      },
    ]);
  });

  it('keeps going after a handler failure and moves to the next update', async () => {
    const r = rig({
      batches: [[update(10), update(11)]],
      reply: (incoming) =>
        incoming.update_id === 10 ? Promise.reject(new Error('disk full')) : Promise.resolve('ok'),
    });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.handled).toEqual([10, 11]);
    expect(r.logs[0]).toMatchObject({ event: 'v2_telegram_command_failed', message: 'disk full' });
    expect(r.sent).toEqual([{ chatId: OWNER, text: 'ok' }]);
  });

  it('keeps going after a reply fails to send', async () => {
    const r = rig({
      batches: [[update(10), update(11)]],
      send: () => Promise.reject(new Error('Telegram sendMessage answered 500')),
    });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.handled).toEqual([10, 11]);
    expect(r.logs.map((entry) => entry.event)).toEqual([
      'v2_telegram_command_failed',
      'v2_telegram_command_failed',
    ]);
  });

  it('stops quietly when shutdown aborts a poll in flight', async () => {
    const r = rig({ batches: [new Error('aborted')] });
    r.shutdown.abort();
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.offsets).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('does not log an abort as a failure', async () => {
    const shutdown = new AbortController();
    const r = rig({ batches: [] });
    await runPoller(
      {
        ...r.deps,
        bot: {
          ...r.deps.bot,
          getUpdates: () => {
            shutdown.abort();
            return Promise.reject(new Error('aborted'));
          },
        },
      },
      shutdown.signal,
    );
    expect(r.logs).toEqual([]);
    expect(r.sleeps).toEqual([]);
  });
});
