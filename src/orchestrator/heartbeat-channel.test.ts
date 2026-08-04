import type { DiscordClient, TelegramClient } from '../verdict/index.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';

const NOW = new Date('2026-07-15T14:00:00Z');

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

describe('TradeChannelHeartbeat.postHeartbeat', () => {
  it('posts to Telegram only when no Discord channel is configured', async () => {
    const telegram = makeTelegram();
    const channel = new TradeChannelHeartbeat(telegram, 'chat-1');

    await channel.postHeartbeat(NOW);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining(NOW.toISOString()),
    );
  });

  it('fans out to both Telegram and Discord when both are configured', async () => {
    const telegram = makeTelegram();
    const discord = makeDiscord();
    const channel = new TradeChannelHeartbeat(telegram, 'chat-1', discord, 'channel-1');

    await channel.postHeartbeat(NOW);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(discord.sendMessage).toHaveBeenCalledTimes(1);
    expect(discord.sendMessage).toHaveBeenCalledWith(
      'channel-1',
      expect.stringContaining(NOW.toISOString()),
    );
  });
});
