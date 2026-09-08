import { runWithTraceId } from '../../shared/index.js';
import {
  ConsoleApprovalChannel,
  LoggingBreachAlertChannel,
  LoggingDataFailoverAlertChannel,
  LoggingFlattenOverfillAlertChannel,
  LoggingHeartbeatChannel,
  LoggingMiCoverageAlertChannel,
  LoggingMiCoverageTelemetry,
  LoggingOrphanAlertChannel,
  LoggingPromptTierAlertChannel,
  LoggingTickSkipAlertChannel,
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

describe('LoggingMiCoverageAlertChannel (#752)', () => {
  // AC6 requires log-only alerting to be OBSERVABLY non-satisfying, not
  // silently accepted as if it had reached someone. This pins the exact
  // sentence a reviewer or an operator reading stdout depends on.
  it('states in its own message that log-only cannot page anyone', async () => {
    const logger = makeLogger();

    await new LoggingMiCoverageAlertChannel(logger).postCoverageAlert({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      subclass: 'unclassified',
      reported_at: new Date('2026-08-17T09:00:00Z'),
    });

    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.message).toContain('SAMURAI_ALERTS=log-only cannot page anyone');
    expect(logger.entries[0]?.message).toContain('BTC-USD');
  });

  // #1280: `MiCoverageAlert.trace_id` is threaded explicitly from
  // `checkMiCoverage`'s `params.trace_id` (the preferred form, trace-context.ts)
  // rather than joined ambient — `LoggingMiCoverageTelemetry.noDataObserved`
  // above already does the identical explicit pass-through for the same
  // subsystem. This is a value check, not a fallback check: there is no
  // constant to fall back to any more, so the mutation that matters is the
  // trace_id going missing or getting hardcoded again.
  it("carries the caller's trace_id verbatim, not a hardcoded constant", async () => {
    const logger = makeLogger();

    await new LoggingMiCoverageAlertChannel(logger).postCoverageAlert({
      trace_id: 'tick-x',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      subclass: 'unclassified',
      reported_at: new Date('2026-08-17T09:00:00Z'),
    });

    expect(logger.entries[0]?.trace_id).toBe('tick-x');
  });

  it('changes when the caller changes it — proving it is threaded, not fixed', async () => {
    const logger = makeLogger();

    await new LoggingMiCoverageAlertChannel(logger).postCoverageAlert({
      trace_id: 'tick-y',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      subclass: 'unclassified',
      reported_at: new Date('2026-08-17T09:00:00Z'),
    });

    expect(logger.entries[0]?.trace_id).toBe('tick-y');
    expect(logger.entries[0]?.trace_id).not.toBe('mi-coverage');
  });
});

describe('LoggingTickSkipAlertChannel (#1084)', () => {
  // Same pin as LoggingMiCoverageAlertChannel: log-only alerting must be
  // OBSERVABLY non-satisfying, not silently accepted as if it reached
  // someone.
  it('states in its own message that log-only cannot page anyone, naming severity and instruments', async () => {
    const logger = makeLogger();

    await new LoggingTickSkipAlertChannel(logger).postTickSkipAlert({
      skipped: 15,
      planned: 20,
      skipped_instruments: ['3USL', '2LQQ', 'BTC-USD'],
      consecutive_ticks: 1,
      reported_at: new Date('2026-08-17T09:00:00Z'),
    });

    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.message).toContain('SAMURAI_ALERTS=log-only cannot page anyone');
    expect(logger.entries[0]?.message).toContain('15 of 20');
    expect(logger.entries[0]?.payload).toMatchObject({
      skipped: 15,
      planned: 20,
      skipped_instruments: ['3USL', '2LQQ', 'BTC-USD'],
    });
  });
});

describe('LoggingPromptTierAlertChannel (#1155)', () => {
  it('names the model, the crossed threshold and the consecutive count', () => {
    const logger = makeLogger();

    new LoggingPromptTierAlertChannel(logger).postPromptTierAlert({
      model: 'x-ai/grok-4.5',
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      prompt_tokens: 200_001,
      above_prompt_tokens: 200_000,
      consecutive_crossings: 1,
      reported_at: new Date('2026-09-04T09:00:00Z'),
    });

    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.message).toContain('x-ai/grok-4.5');
    expect(logger.entries[0]?.message).toContain('200001');
    expect(logger.entries[0]?.message).toContain('200000');
    expect(logger.entries[0]?.payload).toMatchObject({
      model: 'x-ai/grok-4.5',
      debate_id: 'debate-abc',
      prompt_tokens: 200_001,
      above_prompt_tokens: 200_000,
      consecutive_crossings: 1,
    });
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

describe('LoggingDataFailoverAlertChannel (#1183)', () => {
  function alert() {
    return {
      leg: 'equities' as const,
      symbol: 'SPY',
      timeframe: '1h',
      primaryName: 'alpaca',
      fallbackName: 'polygon',
      primaryError: 'stalled',
      reported_at: new Date('2026-08-17T09:00:00Z'),
      suppressed_since_last: 0,
    };
  }

  // #1181 fixed the identical split one component over
  // (production/data-failover.ts's catch-line): the transport's own log for
  // a failover already carries the tick's id, while this channel — a
  // separate DataFailoverAlertChannel implementation, selected by
  // SAMURAI_ALERTS=log-only — logged the same event under a hardcoded
  // constant. One event, two taxonomies, nothing linking them.
  it('falls back to the data-failover constant outside a tick (#1183)', async () => {
    const logger = makeLogger();

    await new LoggingDataFailoverAlertChannel(logger).postDataFailoverAlert(alert());

    expect(logger.entries[0]?.trace_id).toBe('data-failover');
  });

  it('joins the failover alert to the enclosing tick instead (#1183)', async () => {
    const logger = makeLogger();

    await runWithTraceId('tick-x', () =>
      new LoggingDataFailoverAlertChannel(logger).postDataFailoverAlert(alert()),
    );

    expect(logger.entries[0]?.trace_id).toBe('tick-x');
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

describe('LoggingBreachAlertChannel', () => {
  const alert = { breaches: ['llm_spend_cap'], reported_at: new Date('2026-09-08T09:00:00Z') };

  // Two callers, two answers, resolved at runtime (#1280): the daily kill-line
  // batch (`computeMetrics`) runs outside any tick, while `llm_spend_cap` is
  // raised by `SqliteSpendCap#refuse` inside one. Differential, so neither a
  // hardcoded `'feedback-cycle'` nor a hardcoded tick id survives.
  it('joins the enclosing tick when there is one, and the daily cycle when there is not', () => {
    const logger = makeLogger();

    new LoggingBreachAlertChannel(logger).postBreachAlert(alert);
    runWithTraceId('tick-spend-cap', () =>
      new LoggingBreachAlertChannel(logger).postBreachAlert(alert),
    );

    expect(logger.entries.map((entry) => entry.trace_id)).toEqual([
      'feedback-cycle',
      'tick-spend-cap',
    ]);
  });
});
