import {
  LoggingFlattenOverfillAlertChannel,
  LoggingMiCoverageTelemetry,
  ParkedCiiScoreProvider,
  UnwiredApprovalChannel,
} from './console-channels.js';
import type { LogEntry, Logger } from './types.js';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

describe('LoggingMiCoverageTelemetry (#752)', () => {
  it('records the per-name and per-subclass NO_DATA counters in the log payload', () => {
    const logger = makeLogger();

    new LoggingMiCoverageTelemetry(logger).noDataObserved({
      trace_id: 'trace-1',
      instrument: '3USL',
      asset_class: 'stocks',
      subclass: 'index_etp_3x',
      reported_at: new Date('2026-08-17T09:00:00Z'),
    });

    expect(logger.entries[0]).toMatchObject({
      level: 'warn',
      payload: {
        counter_by_name: 'mi_no_data_by_name',
        counter_by_subclass: 'mi_no_data_by_subclass',
        instrument: '3USL',
        subclass: 'index_etp_3x',
      },
    });
  });
});

describe('LoggingFlattenOverfillAlertChannel (#527, #1348)', () => {
  it('reports an over-filled flatten at warn level, naming the flatten and the unattributed qty', async () => {
    const logger = makeLogger();
    const observedAt = new Date('2026-08-03T12:00:00Z');

    await new LoggingFlattenOverfillAlertChannel(logger).postFlattenOverfillWarning({
      trace_id: 'fill-sync',
      idempotency_key: 'flatten-1',
      unattributed_qty: 4,
      observed_at: observedAt,
    });

    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.trace_id).toBe('fill-sync');
    expect(logger.entries[0]?.payload).toMatchObject({
      idempotency_key: 'flatten-1',
      unattributed_qty: 4,
      observed_at: observedAt.toISOString(),
    });
    expect(logger.entries[0]?.payload).not.toHaveProperty('trace_id');
  });

  it("carries the fill-sync pass's trace_id verbatim, and changes when the pass does", async () => {
    const logger = makeLogger();
    const channel = new LoggingFlattenOverfillAlertChannel(logger);
    const warning = {
      idempotency_key: 'flatten-1',
      unattributed_qty: 4,
      observed_at: new Date('2026-08-03T12:00:00Z'),
    } as const;

    await channel.postFlattenOverfillWarning({ ...warning, trace_id: 'fill-sync' });
    await channel.postFlattenOverfillWarning({ ...warning, trace_id: 'control-arm-fill-sync' });

    expect(logger.entries.map((entry) => entry.trace_id)).toEqual([
      'fill-sync',
      'control-arm-fill-sync',
    ]);
  });
});

describe('UnwiredApprovalChannel', () => {
  const request = {
    order_intent: {
      instrument: 'BTC-USD',
      side: 'buy',
      size: 0.1,
      intent_type: 'entry',
      idempotency_key: 'key-1',
    },
    risk_decision: {},
    trace_id: 'trace-1',
    timeout_ms: 1_000,
  } as never;

  it('throws rather than fabricating consent when the HITL gate (6) is reached', async () => {
    await expect(new UnwiredApprovalChannel().requestApproval(request)).rejects.toThrow(
      'no ApprovalChannel is wired',
    );
  });

  it('names the trade it refused, so the throw is diagnosable from one log line', async () => {
    await expect(new UnwiredApprovalChannel().requestApproval(request)).rejects.toThrow(
      'trace trace-1, buy 0.1 BTC-USD',
    );
  });

  it('constructs in live mode', () => {
    expect(() => new UnwiredApprovalChannel()).not.toThrow();
  });
});

describe('ParkedCiiScoreProvider', () => {
  it('answers "no score", the documented null the consumer already handles', async () => {
    expect(await new ParkedCiiScoreProvider().getCii()).toBeNull();
  });
});
