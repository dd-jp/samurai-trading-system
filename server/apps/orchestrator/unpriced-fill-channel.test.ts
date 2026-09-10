import type { UnpricedFillAlert } from '../../pipeline/execution/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { TradeChannelUnpricedFillAlert } from './unpriced-fill-channel.js';

const ALERT: UnpricedFillAlert = {
  venue: 'alpaca',
  client_order_id: 'key-aapl-1355',
  broker_fill_id: 'alpaca-entry-1',
  leg: 'entry',
  instrument: 'AAPL',
  qty: 100,
  first_seen_at: new Date('2026-07-15T14:00:00Z'),
  unpriced_for_ms: 900_000,
  age_out_ms: 900_000,
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

describe('TradeChannelUnpricedFillAlert.postUnpricedFillAlert', () => {
  it('posts the venue order id, symbol and quantity an operator needs to act', async () => {
    const telegram = makeTelegram();

    await new TradeChannelUnpricedFillAlert(telegram, 'chat-1').postUnpricedFillAlert(ALERT);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-1');
    // Without these three the recipient cannot find the order on the venue.
    expect(text).toContain('alpaca-entry-1');
    expect(text).toContain('AAPL');
    expect(text).toContain('key-aapl-1355');
  });

  it('rejects when the transport fails, so the adapter does not record it as delivered', async () => {
    // The contract `AlpacaBrokerAdapter.escalateAgedUnpricedFills` depends on:
    // a swallowed failure here would burn the one alert this fill ever gets.
    const telegram = makeTelegram();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));

    await expect(
      new TradeChannelUnpricedFillAlert(telegram, 'chat-1').postUnpricedFillAlert(ALERT),
    ).rejects.toThrow();
  });
});
