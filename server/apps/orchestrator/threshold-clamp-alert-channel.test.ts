import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { runWithTraceId } from '../../shared/index.js';
import type { ThresholdClampAlert } from './production/threshold-clamp-alert.js';
import { TradeChannelThresholdClampAlert } from './threshold-clamp-alert-channel.js';
import type { Logger } from './types.js';

function alertWith(
  trace_id: string,
  where: ThresholdClampAlert['where'] = 'live-read',
): ThresholdClampAlert {
  return {
    trace_id,
    where,
    message: 'max_pbo 0.5 exceeds the in-code clamp of 0.05',
    reported_at: new Date('2026-09-08T09:00:00Z'),
  };
}

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

describe('TradeChannelThresholdClampAlert (#1280)', () => {
  // The send is fire-and-forget (the port is synchronous); let the rejection
  // handler's `.catch` run before asserting on the logger.
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function failedSendLog(
    alert: ThresholdClampAlert,
    ambient?: string,
  ): Promise<{ trace_id: string; stage: string }> {
    const logger = makeLogger();
    const post = (): void => {
      new TradeChannelThresholdClampAlert(
        makeTelegram(),
        'chat-escalation',
        logger,
      ).postThresholdClampAlert(alert);
    };
    if (ambient === undefined) post();
    else runWithTraceId(ambient, post);
    await flush();

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [entry] = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { trace_id: string; stage: string },
    ];
    return entry;
  }

  async function traceOfFailedSendLog(
    alert: ThresholdClampAlert,
    ambient?: string,
  ): Promise<string> {
    return (await failedSendLog(alert, ambient)).trace_id;
  }

  // Differential, not a single expected string: two alerts differing only in
  // `trace_id` must produce two different log lines. Any constant in that
  // field — the `'threshold-clamp'` this replaced included — collapses both.
  it("carries the raising seam's own trace_id onto the failed-send line", async () => {
    expect(await traceOfFailedSendLog(alertWith('trace-tick-1'))).toBe('trace-tick-1');
    expect(await traceOfFailedSendLog(alertWith('feedback-cycle'))).toBe('feedback-cycle');
  });

  // The other direction: the threaded id must WIN over an enclosing tick, so
  // an ambient join cannot be substituted for the threading. Both seams
  // already hold the id their neighbouring lines log under, and the
  // daily-kill-line-check one runs outside any tick, where an ambient read
  // would fall back to a label joining neither seam.
  it('does not let an enclosing tick override the threaded id', async () => {
    expect(await traceOfFailedSendLog(alertWith('feedback-cycle'), 'tick-x')).toBe(
      'feedback-cycle',
    );
  });

  // The `stage` half of the same join. Threading the trace id made a hardcoded
  // `stage: 'risk'` actively wrong on the daily seam: that alert is raised from
  // `runFeedbackCycle`'s catch, which logs its own failure under
  // `stage: 'feedback-loop'`, so the pair would have disagreed on the same
  // event. Differential, so any single hardcoded stage collapses it.
  it("files the failed-send line under the raising seam's own stage", async () => {
    expect((await failedSendLog(alertWith('trace-tick-1', 'live-read'))).stage).toBe('risk');
    expect((await failedSendLog(alertWith('feedback-cycle', 'daily-kill-line-check'))).stage).toBe(
      'feedback-loop',
    );
  });
});
