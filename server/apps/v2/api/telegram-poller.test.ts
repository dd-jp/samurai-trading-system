import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import type { HeartbeatOutcome } from '../heartbeat.js';
import { TelegramApiError } from './telegram-bot.js';
import type { TelegramUpdate } from './telegram-commands.js';
import {
  ALERT_AFTER_FAILURES,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  HEARTBEAT_EVERY_MS,
  type PollerDeps,
  runPoller,
} from './telegram-poller.js';

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
  alerts: string[];
  beats: HeartbeatOutcome[];
  clock: { ms: number };
}

function rig(options: {
  batches: (TelegramUpdate[] | Error)[];
  reply?: (update: TelegramUpdate) => Promise<string | undefined>;
  send?: () => Promise<void>;
}): Rig {
  const shutdown = new AbortController();
  const offsets: (number | undefined)[] = [];
  const sent: { chatId: number; text: string }[] = [];
  const handled: number[] = [];
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const alerts: string[] = [];
  const beats: HeartbeatOutcome[] = [];
  const clock = { ms: 0 };
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
    logger: { log: (entry) => logs.push(entry) },
    replyPrefix: '',
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    alert: (text) => {
      alerts.push(text);
      return Promise.resolve();
    },
    heartbeat: (outcome) => {
      beats.push(outcome);
      return Promise.resolve();
    },
    nowMs: () => clock.ms,
  };
  return { deps, shutdown, offsets, sent, handled, logs, sleeps, alerts, beats, clock };
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

  it('drops the offset once a poll comes back empty, since Telegram may restart update ids after a quiet week', async () => {
    const r = rig({ batches: [[update(10)], [], [update(11)]] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.offsets).toEqual([undefined, 11, undefined, 12]);
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
      batches: [new Error('Telegram getUpdates did not complete'), [update(10)]],
    });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sleeps).toEqual([BACKOFF_BASE_MS]);
    expect(r.handled).toEqual([10]);
    expect(r.logs).toEqual([
      {
        trace_id: 'v2-telegram',
        stage: 'v2',
        level: 'warn',
        event: 'v2_telegram_poll_failed',
        message: 'Telegram getUpdates did not complete',
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

  it('logs a handler failure with the telegram trace and stage', async () => {
    const r = rig({ batches: [[update(10)]], reply: () => Promise.reject('plain string') });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.logs).toEqual([
      {
        trace_id: 'v2-telegram',
        stage: 'v2',
        level: 'warn',
        event: 'v2_telegram_command_failed',
        message: 'plain string',
      },
    ]);
  });
});

const unauthorized = () => new TelegramApiError('Telegram getUpdates answered 401', 401);
const conflict = () => new TelegramApiError('Telegram getUpdates answered 409', 409);
const flooded = (seconds: number) =>
  new TelegramApiError('Telegram getUpdates answered 429', 429, seconds);

describe('backoffMs', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, unauthorized()))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(BACKOFF_CAP_MS).toBe(300_000);
  });

  it("waits exactly Telegram's retry_after on a 429, whatever the streak", () => {
    expect(backoffMs(1, flooded(37))).toBe(37_000);
    expect(backoffMs(9, flooded(2))).toBe(2_000);
  });

  it('backs off a network failure that never reached Telegram', () => {
    expect(backoffMs(2, new Error('did not complete'))).toBe(10_000);
  });
});

describe('runPoller failure streaks', () => {
  it('backs off a revoked token (401) exponentially instead of every 5 s', async () => {
    const r = rig({ batches: [unauthorized(), unauthorized(), unauthorized()] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sleeps).toEqual([5_000, 10_000, 20_000]);
  });

  it("honours a 429's retry_after", async () => {
    const r = rig({ batches: [unauthorized(), flooded(61)] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sleeps).toEqual([5_000, 61_000]);
  });

  it('surfaces a 409 as an error naming the second poller or webhook', async () => {
    const r = rig({ batches: [conflict()] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.sleeps).toEqual([5_000]);
    expect(r.logs).toEqual([
      {
        trace_id: 'v2-telegram',
        stage: 'v2',
        level: 'error',
        event: 'v2_telegram_poll_conflict',
        message:
          "Telegram getUpdates answered 409: another poller or a webhook is taking this bot's updates",
      },
    ]);
  });

  it('raises one alert and one failed heartbeat once the streak reaches the threshold', async () => {
    const r = rig({ batches: Array.from({ length: ALERT_AFTER_FAILURES + 3 }, unauthorized) });
    await runPoller(r.deps, r.shutdown.signal);
    expect(ALERT_AFTER_FAILURES).toBe(5);
    expect(r.alerts).toEqual([
      'Telegram command poller: 5 polls failed in a row, last: Telegram getUpdates answered 401. Phone halt, resume and flatten may not reach Samurai.',
    ]);
    expect(r.beats).toEqual(['fail', 'success']);
  });

  it('names the 409 cause in the alert', async () => {
    const r = rig({ batches: Array.from({ length: ALERT_AFTER_FAILURES }, conflict) });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.alerts).toEqual([
      "Telegram command poller: 5 polls failed in a row, last: Telegram getUpdates answered 409. Another poller or a webhook is taking this bot's updates. Phone halt, resume and flatten may not reach Samurai.",
    ]);
  });

  it('does not alert below the threshold', async () => {
    const r = rig({ batches: Array.from({ length: ALERT_AFTER_FAILURES - 1 }, unauthorized) });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.alerts).toEqual([]);
    expect(r.beats).toEqual(['success']);
  });

  it('restarts the streak after a successful poll, so a new streak alerts again', async () => {
    const streak = () => Array.from({ length: ALERT_AFTER_FAILURES }, unauthorized);
    const r = rig({ batches: [...streak(), [], ...streak()] });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.alerts).toHaveLength(2);
    expect(r.sleeps.slice(ALERT_AFTER_FAILURES, ALERT_AFTER_FAILURES + 1)).toEqual([5_000]);
  });

  it('keeps polling when the alert or the heartbeat rejects', async () => {
    const r = rig({
      batches: [...Array.from({ length: ALERT_AFTER_FAILURES }, unauthorized), [update(10)]],
    });
    await runPoller(
      {
        ...r.deps,
        alert: () => Promise.reject(new Error('alert down')),
        heartbeat: () => Promise.reject(new Error('healthchecks down')),
      },
      r.shutdown.signal,
    );
    expect(r.handled).toEqual([10]);
  });
});

describe('runPoller heartbeat', () => {
  it('pings after the first good poll, then at most every 5 minutes', async () => {
    const r = rig({ batches: [[], [], [], []] });
    const ticks = [0, 1_000, HEARTBEAT_EVERY_MS - 1, HEARTBEAT_EVERY_MS, HEARTBEAT_EVERY_MS + 1];
    await runPoller(
      {
        ...r.deps,
        nowMs: () => ticks.shift() ?? Number.POSITIVE_INFINITY,
      },
      r.shutdown.signal,
    );
    expect(HEARTBEAT_EVERY_MS).toBe(300_000);
    expect(r.beats).toEqual(['success', 'success']);
  });

  it('pings after the replies, so a slow ping never delays a command', async () => {
    const order: string[] = [];
    const r = rig({ batches: [[update(10)]] });
    await runPoller(
      {
        ...r.deps,
        bot: {
          ...r.deps.bot,
          sendMessage: () => {
            order.push('reply');
            return Promise.resolve();
          },
        },
        heartbeat: () => {
          order.push('beat');
          return Promise.resolve();
        },
      },
      r.shutdown.signal,
    );
    expect(order).toEqual(['reply', 'beat']);
  });

  it('pings at once when a poll recovers from an alerted streak', async () => {
    const r = rig({
      batches: [[], ...Array.from({ length: ALERT_AFTER_FAILURES }, unauthorized), []],
    });
    await runPoller(r.deps, r.shutdown.signal);
    expect(r.beats).toEqual(['success', 'fail', 'success']);
  });

  it('sends no ping for a failed poll', async () => {
    const r = rig({ batches: [unauthorized()] });
    await runPoller(
      {
        ...r.deps,
        sleep: () => {
          r.shutdown.abort();
          return Promise.resolve();
        },
      },
      r.shutdown.signal,
    );
    expect(r.beats).toEqual([]);
  });
});
