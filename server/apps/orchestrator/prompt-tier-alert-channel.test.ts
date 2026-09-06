import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { formatPromptTierAlert, TradeChannelPromptTierAlert } from './prompt-tier-alert-channel.js';
import type { LogEntry, Logger } from './types.js';

const ALERT = {
  model: 'x-ai/grok-4.5',
  trace_id: 'trace-1',
  stage: 'debate',
  debate_id: 'debate-abc',
  prompt_tokens: 200_001,
  above_prompt_tokens: 200_000,
  consecutive_crossings: 1,
  reported_at: new Date('2026-09-04T10:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

describe('formatPromptTierAlert', () => {
  it('names the model, the prompt tokens and the crossed threshold', () => {
    const text = formatPromptTierAlert(ALERT);
    expect(text).toContain('x-ai/grok-4.5');
    expect(text).toContain('200001');
    expect(text).toContain('200000');
  });

  it('carries the consecutive-crossing count the throttle computed', () => {
    const text = formatPromptTierAlert({ ...ALERT, consecutive_crossings: 9 });
    expect(text).toContain('#9 consecutive call');
  });
});

describe('TradeChannelPromptTierAlert', () => {
  it('posts the formatted alert to the escalation chat it was given', async () => {
    const telegram = makeTelegram();

    new TradeChannelPromptTierAlert(telegram, 'chat-escalation', makeLogger()).postPromptTierAlert(
      ALERT,
    );
    await Promise.resolve();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = vi.mocked(telegram.sendMessage).mock.calls[0];
    expect(chatId).toBe('chat-escalation');
    expect(text).toBe(formatPromptTierAlert(ALERT));
  });

  it('never throws, and logs an error, when the send fails', async () => {
    const telegram = makeTelegram();
    vi.mocked(telegram.sendMessage).mockRejectedValue(new Error('telegram 502'));
    const logger = makeLogger();

    expect(() =>
      new TradeChannelPromptTierAlert(telegram, 'chat-escalation', logger).postPromptTierAlert(
        ALERT,
      ),
    ).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('error');
    expect(logger.entries[0]?.message).toContain('failed to send');
  });
});
