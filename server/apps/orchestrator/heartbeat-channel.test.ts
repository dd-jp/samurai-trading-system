import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';

const NOW = new Date('2026-07-15T14:00:00Z');

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

describe('TradeChannelHeartbeat.postHeartbeat', () => {
  it('posts the beat to the configured chat', async () => {
    const telegram = makeTelegram();
    const channel = new TradeChannelHeartbeat(telegram, 'chat-1');

    await channel.postHeartbeat(NOW);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining(NOW.toISOString()),
    );
  });
});
