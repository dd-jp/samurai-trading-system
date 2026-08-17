/**
 * The two `LoosenNotificationChannel` implementations (#366, retargeted #736).
 *
 * The property every case here defends changed with the gate. It used to be
 * "neither channel can approve anything, so the threshold never moves"; since
 * ADR-0013 Decision 2 the threshold DOES move, on the cycle's own authority
 * and inside the hard bounds, and what these channels owe the operator is an
 * accurate account of a change already in force. So every case below asserts
 * past tense and `applied: true` — a message that still read as a pending
 * request would be the same lie the gate was.
 * `production.test.ts`'s "#366" describe asserts the half that matters more:
 * that the dial in the store really did move.
 */
import type { LoosenAppliedNotice } from '../../pipeline/feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import { LoggingLoosenNotificationChannel } from './console-channels.js';
import { TradeChannelLoosenNotice } from './loosen-notification-channel.js';
import type { Logger } from './types.js';

const NOTICE: LoosenAppliedNotice = {
  name: 'max_position_size',
  from: 5_000,
  to: 5_500,
  applied_at: new Date('2026-08-05T09:00:00.000Z'),
};

function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
  const entries: Parameters<Logger['log']>[0][] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

/** Resolves after the adapter's fire-and-forget `Promise.allSettled` chain. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('LoggingLoosenNotificationChannel', () => {
  it('records the move and that it WAS applied', () => {
    const logger = recordingLogger();

    new LoggingLoosenNotificationChannel(logger).notifyLoosenApplied(NOTICE);

    const entry = logger.entries[0];
    expect(entry?.stage).toBe('feedback-loop');
    expect(entry?.trace_id).toBe('feedback-cycle');
    // `warn`, not `error`: nothing is broken and no position is at risk — a
    // dial moved inside bounds a human set. Not `info` either: a safety limit
    // widening with nobody asked must not be scrolled past in a soak log.
    expect(entry?.level).toBe('warn');
    expect(entry?.payload).toMatchObject({
      name: 'max_position_size',
      from: 5_000,
      to: 5_500,
      applied: true,
    });
  });

  it('says out loud that the threshold ALREADY MOVED, so it is not read as a request', () => {
    const logger = recordingLogger();

    new LoggingLoosenNotificationChannel(logger).notifyLoosenApplied(NOTICE);

    // The hazard #736 replaces the old one with: an operator reading the log
    // stream must not conclude that a proposed loosening is still waiting on
    // them, because it is not — it is in force.
    const message = logger.entries[0]?.message ?? '';
    expect(message).toMatch(/LOOSENING applied/i);
    expect(message).not.toMatch(/NOT applied/i);
  });

  it('returns nothing, so no caller can mistake it for a decision', () => {
    // The structural reason this stand-in is safe where `ConsoleApprovalChannel`
    // is not: that port returns `Promise<ApprovalOutcome>` and must answer;
    // this one returns `void` and is asked nothing.
    const outcome = new LoggingLoosenNotificationChannel(recordingLogger()).notifyLoosenApplied(
      NOTICE,
    );

    expect(outcome).toBeUndefined();
  });
});

describe('TradeChannelLoosenNotice', () => {
  function telegramStub(sendMessage: TelegramClient['sendMessage']): TelegramClient {
    return { sendMessage } as unknown as TelegramClient;
  }

  it('pushes the applied move to the escalation chat', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const logger = recordingLogger();

    new TradeChannelLoosenNotice(
      telegramStub(sendMessage as unknown as TelegramClient['sendMessage']),
      'escalation-chat',
      logger,
    ).notifyLoosenApplied(NOTICE);
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe('escalation-chat');
    expect(text).toContain('max_position_size');
    expect(text).toContain('5000');
    expect(text).toContain('5500');
  });

  it('tells the operator the move is already in force and no reply is read', async () => {
    const sendMessage = vi.fn(async () => undefined);

    new TradeChannelLoosenNotice(
      telegramStub(sendMessage as unknown as TelegramClient['sendMessage']),
      'escalation-chat',
      recordingLogger(),
    ).notifyLoosenApplied(NOTICE);
    await flush();

    // Nothing polls Telegram (alert-transport.ts starts no poll loop), so a
    // reply to this chat is read by no process. The old text told the operator
    // a loosening was proposed and would never be applied; that is now false
    // in both halves, and a message describing a gate that no longer exists is
    // exactly the "reads as governed" defect ADR-0013 names.
    const [, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('RISK-THRESHOLD LOOSENED');
    expect(text).toMatch(/already in force/i);
    expect(text).toMatch(/no reply is read/i);
    expect(text).not.toMatch(/NOT APPLIED/i);
  });

  it('logs at error when the push fails, rather than losing the notice silently', async () => {
    const logger = recordingLogger();

    new TradeChannelLoosenNotice(
      telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
      'escalation-chat',
      logger,
    ).notifyLoosenApplied(NOTICE);
    await flush();

    const entry = logger.entries.find((e) => e.level === 'error');
    expect(entry?.stage).toBe('feedback-loop');
    // NOT fail-safe any more, and the log must not pretend otherwise: the
    // threshold widened before this send was attempted, so a lost notice means
    // an applied change nobody heard about. `applied: true` is the honest
    // record, and the local log line is what the operator can still find.
    expect(entry?.payload).toMatchObject({ name: 'max_position_size', applied: true });
    expect(entry?.message).toMatch(/WAS loosened/i);
  });

  it('does not throw or reject when the transport fails, so one cycle cannot end the run', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() =>
        new TradeChannelLoosenNotice(
          telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
          'escalation-chat',
          recordingLogger(),
        ).notifyLoosenApplied(NOTICE),
      ).not.toThrow();
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('still reaches Discord when Telegram is down', async () => {
    const discordSend = vi.fn(async () => undefined);
    const discord = { sendMessage: discordSend } as unknown as DiscordClient;

    new TradeChannelLoosenNotice(
      telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
      'escalation-chat',
      recordingLogger(),
      discord,
      'discord-channel',
    ).notifyLoosenApplied(NOTICE);
    await flush();

    expect(discordSend).toHaveBeenCalledTimes(1);
  });
});
