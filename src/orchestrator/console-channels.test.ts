import {
  ConsoleApprovalChannel,
  LoggingHeartbeatChannel,
  LoggingOrphanAlertChannel,
  ParkedCiiScoreProvider,
} from './console-channels.js';
import type { LogEntry, Logger } from './types.js';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

describe('LoggingHeartbeatChannel', () => {
  it('writes the heartbeat timestamp', async () => {
    const logger = makeLogger();
    const at = new Date('2026-08-03T12:00:00Z');

    await new LoggingHeartbeatChannel(logger).postHeartbeat(at);

    expect(logger.entries[0]).toMatchObject({
      message: 'heartbeat',
      payload: { timestamp: at.toISOString() },
    });
  });
});

describe('LoggingOrphanAlertChannel', () => {
  it('reports an orphaned go verdict at error level', async () => {
    const logger = makeLogger();

    await new LoggingOrphanAlertChannel(logger).postOrphanAlert({
      trace_id: 'trace-1',
      idempotency_key: 'key-aapl-1355',
      instrument: 'AAPL',
      timestamp: new Date('2026-08-03T12:00:00Z'),
    });

    // An orphaned `go` is the one state that can hide a real position.
    expect(logger.entries[0]?.level).toBe('error');
    expect(logger.entries[0]?.trace_id).toBe('trace-1');
  });
});

describe('ConsoleApprovalChannel', () => {
  const request = {
    order_intent: {
      instrument: 'BTC-USD',
      side: 'buy',
      size: 0.1,
      intent_type: 'entry',
    },
    risk_decision: {},
    trace_id: 'trace-1',
    timeout_ms: 1_000,
  } as never;

  it('refuses to exist in live mode rather than silently auto-approving real money', () => {
    expect(() => new ConsoleApprovalChannel(makeLogger(), 'live')).toThrow(
      'refuses to run in live',
    );
  });

  it.each(['paper', 'backtest'] as const)('auto-approves in %s mode', async (mode) => {
    const channel = new ConsoleApprovalChannel(makeLogger(), mode);

    expect(await channel.requestApproval(request)).toBe('approved');
  });

  it('records at warn that a machine consented, not a person', async () => {
    const logger = makeLogger();

    await new ConsoleApprovalChannel(logger, 'paper').requestApproval(request);

    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.message).toContain('no human reviewed');
    expect(logger.entries[0]?.trace_id).toBe('trace-1');
  });
});

describe('ParkedCiiScoreProvider', () => {
  it('answers "no score", the documented null the consumer already handles', async () => {
    expect(await new ParkedCiiScoreProvider().getCii()).toBeNull();
  });
});
