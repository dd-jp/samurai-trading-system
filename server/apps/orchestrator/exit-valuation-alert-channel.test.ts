import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { runWithTraceId } from '../../shared/index.js';
import { TradeChannelExitValuationDegradedAlert } from './exit-valuation-alert-channel.js';
import type { ExitValuationDegradedAlert } from './production/exit-valuation-alert.js';
import type { Logger } from './types.js';

const ALERT: ExitValuationDegradedAlert = {
  instrument: '3USL',
  seam: 'risk',
  unvalued_instruments: ['2LQQ'],
  reason: 'stale by 12000ms',
  reported_at: new Date('2026-09-06T09:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockRejectedValue(new Error('telegram 502')),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

function makeLogger(): Logger {
  return { log: vi.fn() } as unknown as Logger;
}

describe('TradeChannelExitValuationDegradedAlert (#1280)', () => {
  // The send is fire-and-forget (the port is synchronous); let the rejection
  // handler's `.catch` run before asserting on the logger.
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('falls back to the exit-valuation-degraded constant outside a tick', async () => {
    const telegram = makeTelegram();
    const logger = makeLogger();

    new TradeChannelExitValuationDegradedAlert(
      telegram,
      'chat-escalation',
      logger,
    ).postExitValuationDegradedAlert(ALERT);
    await flush();

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [entry] = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { trace_id: string },
    ];
    expect(entry.trace_id).toBe('exit-valuation-degraded');
  });

  it('joins the failed-send line to the enclosing tick instead', async () => {
    const telegram = makeTelegram();
    const logger = makeLogger();

    runWithTraceId('tick-x', () => {
      new TradeChannelExitValuationDegradedAlert(
        telegram,
        'chat-escalation',
        logger,
      ).postExitValuationDegradedAlert(ALERT);
    });
    await flush();

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [entry] = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { trace_id: string },
    ];
    expect(entry.trace_id).toBe('tick-x');
  });
});
