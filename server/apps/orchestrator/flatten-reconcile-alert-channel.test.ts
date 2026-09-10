import type { FlattenReconcileAlert } from '../../pipeline/execution/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { TradeChannelFlattenReconcileAlert } from './flatten-reconcile-alert-channel.js';

const ALERT: FlattenReconcileAlert = {
  trace_id: 'reconcile',
  idempotency_key: 'flatten-aapl-1',
  instrument: 'AAPL',
  reason: "flatten 'flatten-aapl-1' was previously acked but the venue now reports no such order",
  observed_at: new Date('2026-09-08T09:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

describe('TradeChannelFlattenReconcileAlert.postFlattenReconcileAlert', () => {
  it('pages Telegram for the live arm', async () => {
    const telegram = makeTelegram();

    await new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert(
      ALERT,
    );

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("pages Telegram for the live arm's poll surface too (#1349 predicate reads the whole trace_id, not a fixed literal)", async () => {
    const telegram = makeTelegram();

    await new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert({
      ...ALERT,
      trace_id: 'fill-sync',
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(text).toContain('[fill-sync]');
  });

  // DECISION (David, 2026-09-08, #1349): the control arm's broker is
  // `SimulatedBrokerAdapter` — there is no venue, so this page's "check the
  // order on the venue by hand" instruction is never actionable for a
  // control-arm trace_id. The predicate drops it before the transport is
  // touched.
  it('does not page Telegram for the control arm (#1349)', async () => {
    const telegram = makeTelegram();

    await new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert({
      ...ALERT,
      trace_id: 'control-arm-reconcile',
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not page for the control arm's poll surface either", async () => {
    const telegram = makeTelegram();

    await new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert({
      ...ALERT,
      trace_id: 'control-arm-fill-sync',
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the control arm suppresses the page', async () => {
    const telegram = makeTelegram();

    await expect(
      new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert({
        ...ALERT,
        trace_id: 'control-arm-reconcile',
      }),
    ).resolves.toBeUndefined();
  });

  // #1349: implementing the predicate gives the transport `trace_id` it did
  // not read before — the ruling took the labelling this makes available as
  // a side effect, so the page identifies which surface raised it.
  it('labels the Telegram text with the surface trace_id', async () => {
    const telegram = makeTelegram();

    await new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert(
      ALERT,
    );

    const [, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(text).toContain('reconcile');
  });

  it('rejects when the transport fails, so the caller does not record it as delivered', async () => {
    const telegram = makeTelegram();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));

    await expect(
      new TradeChannelFlattenReconcileAlert(telegram, 'chat-1').postFlattenReconcileAlert(ALERT),
    ).rejects.toThrow();
  });
});
