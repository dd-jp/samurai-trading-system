import type { ResidualExposureAlert } from '../../pipeline/execution/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import { TradeChannelResidualExposureAlert } from './residual-exposure-alert-channel.js';

const ALERT: ResidualExposureAlert = {
  trace_id: 'fill-sync',
  idempotency_key: 'key-aapl-1355',
  instrument: 'AAPL',
  side: 'buy',
  residual_qty: 12,
  residual_qty_is_upper_bound: false,
  stop: 180.5,
  target: 195.25,
  observed_at: new Date('2026-08-04T09:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

function makeDiscord(): DiscordClient {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

describe('TradeChannelResidualExposureAlert.postResidualExposureAlert', () => {
  it('posts the lot id, instrument and quantity an operator needs to act', async () => {
    const telegram = makeTelegram();

    await new TradeChannelResidualExposureAlert(telegram, 'chat-1').postResidualExposureAlert(
      ALERT,
    );

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-1');
    // Without these the recipient cannot find the position on the venue.
    expect(text).toContain('AAPL');
    expect(text).toContain('key-aapl-1355');
    expect(text).toContain('12');
  });

  it('flags an upper-bound quantity rather than presenting it as exact', async () => {
    const telegram = makeTelegram();

    await new TradeChannelResidualExposureAlert(telegram, 'chat-1').postResidualExposureAlert({
      ...ALERT,
      residual_qty_is_upper_bound: true,
    });

    const [, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(text).toContain('upper bound');
  });

  it('fans out to Discord as well when one is configured', async () => {
    const telegram = makeTelegram();
    const discord = makeDiscord();

    await new TradeChannelResidualExposureAlert(
      telegram,
      'chat-1',
      discord,
      'channel-1',
    ).postResidualExposureAlert(ALERT);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(discord.sendMessage).toHaveBeenCalledTimes(1);
  });

  // #1348: `trace_id` was added to `ResidualExposureAlert` purely to
  // distinguish the two arms at the LOG line (console-channels.ts) — the
  // Telegram body must not change with it, or the arm label would leak into
  // an operator's phone through a formatter no one intended to touch.
  it('does not vary the Telegram body with trace_id', async () => {
    const telegram = makeTelegram();

    await new TradeChannelResidualExposureAlert(telegram, 'chat-1').postResidualExposureAlert({
      ...ALERT,
      trace_id: 'fill-sync',
    });
    await new TradeChannelResidualExposureAlert(telegram, 'chat-1').postResidualExposureAlert({
      ...ALERT,
      trace_id: 'control-arm-fill-sync',
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    const calls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
  });

  it('rejects when the transport fails, so the caller does not record it as delivered', async () => {
    // ingest-fills.ts's `alertResidualExposure` catches this itself (the
    // alert IS the fallback, so there is nothing left to fall back to) — but
    // a swallowed failure here would still hide the transport-level defect
    // from that caller, which is what this test guards.
    const telegram = makeTelegram();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));

    await expect(
      new TradeChannelResidualExposureAlert(telegram, 'chat-1').postResidualExposureAlert(ALERT),
    ).rejects.toThrow();
  });
});
