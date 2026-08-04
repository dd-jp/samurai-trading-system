import type { DiscordClient, TelegramClient } from '../verdict/index.js';
import { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
import type { OrphanGoVerdict } from './orphan-verdict-scan.js';

const ORPHAN: OrphanGoVerdict = {
  trace_id: 'trace-btc-0931',
  idempotency_key: 'key-btc-0931',
  instrument: 'BTC-USD',
  verdict_timestamp: new Date('2026-07-15T09:31:00Z'),
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

function sentText(telegram: TelegramClient): string {
  const [, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    string,
  ];
  return text;
}

describe('TradeChannelOrphanAlert.postOrphanAlert', () => {
  it('posts the three identifiers an operator needs to find the order on the venue', async () => {
    const telegram = makeTelegram();

    await new TradeChannelOrphanAlert(telegram, 'chat-1').postOrphanAlert(ORPHAN);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-1');

    const text = sentText(telegram);
    // `idempotency_key` is the client order id the venue knows this trade by —
    // the whole reason `OrphanGoVerdict` carries it (orphan-verdict-scan.ts),
    // since the scan itself matches on `trace_id` alone.
    expect(text).toContain('key-btc-0931');
    expect(text).toContain('trace-btc-0931');
    expect(text).toContain('BTC-USD');
    expect(text).toContain('2026-07-15T09:31:00.000Z');
  });

  it('says the position may exist and must be reconciled by hand', async () => {
    // The whole point of the escalation: a `go` with no execution record means
    // an order may or may not have reached the venue, and no code path here
    // resolves that (#209 AC2 — orphans are never auto-resubmitted).
    const telegram = makeTelegram();

    await new TradeChannelOrphanAlert(telegram, 'chat-1').postOrphanAlert(ORPHAN);

    expect(sentText(telegram)).toMatch(/by hand/i);
  });

  it('fans out to Discord as well when one is configured', async () => {
    const telegram = makeTelegram();
    const discord = makeDiscord();

    await new TradeChannelOrphanAlert(telegram, 'chat-1', discord, 'channel-1').postOrphanAlert(
      ORPHAN,
    );

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(discord.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still posts to Discord when Telegram fails, and rejects', async () => {
    // Both transports are attempted together so one outage cannot silence the
    // other copy — the same posture `TradeChannelHeartbeat` takes. The
    // rejection still surfaces: `OrphanVerdictScanner.scan` catches and logs
    // it per orphan, and a swallowed failure would make that log impossible.
    const telegram = makeTelegram();
    const discord = makeDiscord();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));

    await expect(
      new TradeChannelOrphanAlert(telegram, 'chat-1', discord, 'channel-1').postOrphanAlert(ORPHAN),
    ).rejects.toThrow();

    expect(discord.sendMessage).toHaveBeenCalledTimes(1);
  });
});
