import {
  ConsoleApprovalChannel,
  LoggingFlattenOverfillAlertChannel,
  LoggingHeartbeatChannel,
  LoggingOrphanAlertChannel,
  LoggingUnpricedFillAlertChannel,
  ParkedCiiScoreProvider,
  UnwiredApprovalChannel,
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
      verdict_timestamp: new Date('2026-08-03T12:00:00Z'),
    });

    // An orphaned `go` is the one state that can hide a real position.
    expect(logger.entries[0]?.level).toBe('error');
    expect(logger.entries[0]?.trace_id).toBe('trace-1');
  });
});

describe('LoggingUnpricedFillAlertChannel', () => {
  it('reports a stuck lot at error level, naming the order an operator must look up', async () => {
    const logger = makeLogger();
    const firstSeen = new Date('2026-08-03T12:00:00Z');

    await new LoggingUnpricedFillAlertChannel(logger).postUnpricedFillAlert({
      venue: 'alpaca',
      client_order_id: 'key-aapl-1355',
      broker_fill_id: 'alpaca-entry-1',
      leg: 'entry',
      instrument: 'AAPL',
      qty: 100,
      first_seen_at: firstSeen,
      unpriced_for_ms: 900_000,
      age_out_ms: 900_000,
    });

    // `error`, not `warn`: the lot behind it cannot advance, cannot size its
    // stop correctly and will never emit a ClosedTrade.
    expect(logger.entries[0]?.level).toBe('error');
    expect(logger.entries[0]?.payload).toMatchObject({
      broker_fill_id: 'alpaca-entry-1',
      instrument: 'AAPL',
      qty: 100,
      first_seen_at: firstSeen.toISOString(),
    });
  });
});

describe('LoggingFlattenOverfillAlertChannel', () => {
  it('reports an over-filled flatten at warn level, naming the flatten and the unattributed qty', async () => {
    const logger = makeLogger();
    const observedAt = new Date('2026-08-03T12:00:00Z');

    await new LoggingFlattenOverfillAlertChannel(logger).postFlattenOverfillWarning({
      idempotency_key: 'flatten-1',
      unattributed_qty: 4,
      observed_at: observedAt,
    });

    // `warn`, not `error`: the split still completed and the poll still
    // succeeded — this is a diagnostic trail for an invariant violation
    // elsewhere, not itself a failure of `ingestFills()`.
    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.trace_id).toBe('flatten-overfill');
    expect(logger.entries[0]?.payload).toMatchObject({
      idempotency_key: 'flatten-1',
      unattributed_qty: 4,
      observed_at: observedAt.toISOString(),
    });
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

  it('throws rather than fabricating consent when gate 6 is reached', async () => {
    // The whole point of this class over `ConsoleApprovalChannel`. Under
    // ADR-0007's `auto` dial it is unreachable; reaching it means the dial was
    // changed without wiring a transport, and auto-approving there would read
    // as an enforced gate while enforcing nothing.
    await expect(new UnwiredApprovalChannel().requestApproval(request)).rejects.toThrow(
      'no ApprovalChannel is wired',
    );
  });

  it('names the trade it refused, so the throw is diagnosable from one log line', async () => {
    await expect(new UnwiredApprovalChannel().requestApproval(request)).rejects.toThrow(
      'trace trace-1, buy 0.1 BTC-USD',
    );
  });

  it('constructs in live mode, unlike ConsoleApprovalChannel', () => {
    // Deliberate difference, not an oversight: this channel takes no mode and
    // refuses nothing at construction, because refusing in `live` would block
    // a live start over a gate that `auto` never reaches. The safety lives in
    // `requestApproval` throwing, which is mode-independent.
    expect(() => new UnwiredApprovalChannel()).not.toThrow();
  });
});

describe('ParkedCiiScoreProvider', () => {
  it('answers "no score", the documented null the consumer already handles', async () => {
    expect(await new ParkedCiiScoreProvider().getCii()).toBeNull();
  });
});
