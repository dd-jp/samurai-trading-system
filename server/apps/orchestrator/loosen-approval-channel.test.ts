/**
 * The two `LoosenApprovalChannel` implementations (#366).
 *
 * The property every case here defends is the same one: **neither channel can
 * approve anything.** `requestLoosenApproval` returns `void`, so unlike
 * Verdict's `ApprovalChannel` there is no outcome to fabricate — a request that
 * reaches nobody leaves the risk threshold exactly where it was. These assert
 * the observable half of that (what is sent, what is logged, and that `applied`
 * is recorded as false); `production.test.ts`'s "#366" describe asserts the
 * half that matters more — that the dial in the store really did not move.
 */
import type { LoosenApprovalRequest } from '../../pipeline/feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import { LoggingLoosenApprovalChannel } from './console-channels.js';
import { TradeChannelLoosenApproval } from './loosen-approval-channel.js';
import type { Logger } from './types.js';

const REQUEST: LoosenApprovalRequest = {
  name: 'max_position_size',
  from: 5_000,
  to: 5_500,
  requested_at: new Date('2026-08-05T09:00:00.000Z'),
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

describe('LoggingLoosenApprovalChannel', () => {
  it('records the proposed move and that it was NOT applied', () => {
    const logger = recordingLogger();

    new LoggingLoosenApprovalChannel(logger).requestLoosenApproval(REQUEST);

    const entry = logger.entries[0];
    expect(entry?.stage).toBe('feedback-loop');
    expect(entry?.trace_id).toBe('feedback-cycle');
    // `warn`, not `error`: nothing is broken and no position is at risk — the
    // system asked a question and keeps running safely without an answer.
    expect(entry?.level).toBe('warn');
    expect(entry?.payload).toMatchObject({
      name: 'max_position_size',
      from: 5_000,
      to: 5_500,
      applied: false,
    });
  });

  it('says out loud that the threshold stays put, so silence is not read as consent', () => {
    const logger = recordingLogger();

    new LoggingLoosenApprovalChannel(logger).requestLoosenApproval(REQUEST);

    // The whole hazard this ticket guards: an operator reading the log stream
    // must not be able to conclude that an unanswered request eventually
    // applies itself.
    expect(logger.entries[0]?.message).toMatch(/NOT applied/i);
  });

  it('returns nothing, so no caller can mistake it for a decision', () => {
    // The structural reason this stand-in is safe where `ConsoleApprovalChannel`
    // is not: that port returns `Promise<ApprovalOutcome>` and must answer;
    // this one returns `void` and cannot.
    const outcome = new LoggingLoosenApprovalChannel(recordingLogger()).requestLoosenApproval(
      REQUEST,
    );

    expect(outcome).toBeUndefined();
  });
});

describe('TradeChannelLoosenApproval', () => {
  function telegramStub(sendMessage: TelegramClient['sendMessage']): TelegramClient {
    return { sendMessage } as unknown as TelegramClient;
  }

  it('pushes the proposed move to the escalation chat', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const logger = recordingLogger();

    new TradeChannelLoosenApproval(
      telegramStub(sendMessage as unknown as TelegramClient['sendMessage']),
      'escalation-chat',
      logger,
    ).requestLoosenApproval(REQUEST);
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe('escalation-chat');
    expect(text).toContain('max_position_size');
    expect(text).toContain('5000');
    expect(text).toContain('5500');
  });

  it('tells the operator a reply approves nothing', async () => {
    const sendMessage = vi.fn(async () => undefined);

    new TradeChannelLoosenApproval(
      telegramStub(sendMessage as unknown as TelegramClient['sendMessage']),
      'escalation-chat',
      recordingLogger(),
    ).requestLoosenApproval(REQUEST);
    await flush();

    // Nothing polls Telegram for approvals (alert-transport.ts starts no poll
    // loop), so a "yes" typed into this chat is read by no process. A
    // notification that reads like an approval prompt on a channel with no
    // listener is how consent gets fabricated by accident.
    const [, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('NOT APPLIED');
    expect(text).toMatch(/nothing here reads replies/i);
  });

  it('logs at error when the push fails, rather than losing the question silently', async () => {
    const logger = recordingLogger();

    new TradeChannelLoosenApproval(
      telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
      'escalation-chat',
      logger,
    ).requestLoosenApproval(REQUEST);
    await flush();

    const entry = logger.entries.find((e) => e.level === 'error');
    expect(entry?.stage).toBe('feedback-loop');
    // Still fail-closed on the transport's worst day: the threshold is
    // unchanged whether or not anybody was reachable.
    expect(entry?.payload).toMatchObject({ name: 'max_position_size', applied: false });
  });

  it('does not throw or reject when the transport fails, so one cycle cannot end the run', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() =>
        new TradeChannelLoosenApproval(
          telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
          'escalation-chat',
          recordingLogger(),
        ).requestLoosenApproval(REQUEST),
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

    new TradeChannelLoosenApproval(
      telegramStub(vi.fn(async () => Promise.reject(new Error('telegram down'))) as never),
      'escalation-chat',
      recordingLogger(),
      discord,
      'discord-channel',
    ).requestLoosenApproval(REQUEST);
    await flush();

    expect(discordSend).toHaveBeenCalledTimes(1);
  });
});
