import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { runWithTraceId } from '../../shared/index.js';
import { TradeChannelBreachAlert } from './breach-alert-channel.js';
import type { LogEntry, Logger } from './types.js';

const ALERT = {
  breaches: ['llm_spend_cap'],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function failingTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockRejectedValue(new Error('telegram 502')),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  } as unknown as TelegramClient;
}

describe('TradeChannelBreachAlert (#1280)', () => {
  // The send is fire-and-forget; let the `.then` on the settled pair run.
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // Same two callers as `LoggingBreachAlertChannel`: the daily kill-line batch
  // outside any tick, and `llm_spend_cap` raised inside one by
  // `SqliteSpendCap#refuse`. Differential, so no single constant passes.
  it('logs an undelivered breach under whichever caller raised it', async () => {
    const logger = makeLogger();
    const post = (): void => {
      new TradeChannelBreachAlert(failingTelegram(), 'chat-escalation', logger).postBreachAlert(
        ALERT,
      );
    };

    post();
    runWithTraceId('tick-spend-cap', post);
    await flush();

    expect(logger.entries.map((entry) => entry.trace_id)).toEqual([
      'feedback-cycle',
      'tick-spend-cap',
    ]);
  });
});
