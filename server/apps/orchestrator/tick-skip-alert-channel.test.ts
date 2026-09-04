import type { TelegramClient } from '../../pipeline/verdict/index.js';
import type { TickSkipAlert } from './production/tick-skip-alert.js';
import { formatTickSkipAlert, TradeChannelTickSkipAlert } from './tick-skip-alert-channel.js';

const ALERT: TickSkipAlert = {
  skipped: 15,
  planned: 20,
  skipped_instruments: ['AAPL', 'TSLA', 'SPY'],
  consecutive_ticks: 1,
  reported_at: new Date('2026-09-04T10:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

describe('formatTickSkipAlert', () => {
  it('names how many were dropped and out of how many, so severity reads without the log (#1084 AC)', () => {
    const text = formatTickSkipAlert(ALERT);

    expect(text).toContain('15 of 20');
  });

  it('names the skipped instruments', () => {
    const text = formatTickSkipAlert(ALERT);

    expect(text).toContain('AAPL, TSLA, SPY');
  });

  it('carries the consecutive-tick count the throttle computed', () => {
    const text = formatTickSkipAlert({ ...ALERT, consecutive_ticks: 9 });

    expect(text).toContain('Consecutive degraded tick(s): 9');
  });

  it('says the skip mechanism itself is unchanged, so it does not read as a behaviour change', () => {
    const text = formatTickSkipAlert(ALERT);

    expect(text).toContain('unchanged');
  });
});

describe('TradeChannelTickSkipAlert', () => {
  it('posts the formatted alert to the escalation chat it was given', async () => {
    const telegram = makeTelegram();

    await new TradeChannelTickSkipAlert(telegram, 'chat-escalation').postTickSkipAlert(ALERT);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-escalation');
    expect(text).toBe(formatTickSkipAlert(ALERT));
  });

  it('rejects when the send fails, so the caller (reportTickSkip) can log and swallow it', async () => {
    const telegram = makeTelegram();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('telegram 502'));

    await expect(
      new TradeChannelTickSkipAlert(telegram, 'chat-escalation').postTickSkipAlert(ALERT),
    ).rejects.toThrow('telegram 502');
  });
});
