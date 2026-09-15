/**
 * Every catalogue entry, through both adapters, against
 * `alert-catalogue.golden.json` — captured from the per-alert classes the
 * catalogue replaced, so a byte moved in an event code, level, payload key,
 * message or Telegram body reddens here. The golden holds each fixture case
 * outside and inside a `runWithTraceId('tick-x')` scope, which is what pins
 * the two trace shapes: ambient join (heartbeat, data failover, breach) and
 * threaded-id-wins (threshold clamp, mi coverage, the fill-sync surfaces).
 *
 * Below the table: the properties the golden cannot express — structure,
 * invariance across fields the formatter must not read, and the control-arm
 * predicate on surfaces the fixtures do not cover.
 */
import { readFileSync } from 'node:fs';
import { noCostBasisDrops } from '../../pipeline/control-arm/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { runWithTraceId } from '../../shared/index.js';
import {
  ALERT_CATALOGUE,
  ALERT_IDS,
  type AlertId,
  type AlertOf,
  type AlertPort,
  type LoggedAlertId,
  loggingAlertChannel,
  tradeChannelAlert,
  UNLOGGED_ALERT_IDS,
} from './alert-catalogue.js';
import type { LogEntry, Logger } from './types.js';

const AT = new Date('2026-09-10T08:15:00.000Z');
const CHAT_ID = 'chat-1';

const FIXTURES: { readonly [K in AlertId]: readonly AlertOf<K>[] } = {
  heartbeatChannel: [AT],
  orphanAlerts: [
    { trace_id: 'tick-7', idempotency_key: 'lot-1', instrument: 'SPY', verdict_timestamp: AT },
  ],
  unpricedFillAlerts: [
    {
      venue: 'alpaca',
      client_order_id: 'lot-1',
      broker_fill_id: 'fill-9',
      leg: 'entry',
      instrument: 'QQQ',
      qty: 3,
      first_seen_at: AT,
      unpriced_for_ms: 900_000,
      age_out_ms: 600_000,
    },
  ],
  residualExposureAlerts: [
    {
      trace_id: 'fill-sync',
      idempotency_key: 'lot-2',
      instrument: 'AAPL',
      side: 'buy',
      residual_qty: 2,
      residual_qty_is_upper_bound: false,
      rearm_unsupported: false,
      stop: 180,
      target: 190,
      observed_at: AT,
    },
    {
      trace_id: 'control-arm-fill-sync',
      idempotency_key: 'lot-2',
      instrument: 'AAPL',
      side: 'sell',
      residual_qty: 5,
      residual_qty_is_upper_bound: true,
      rearm_unsupported: true,
      stop: 180,
      target: 190,
      observed_at: AT,
    },
  ],
  ocoDoubleFillAlerts: [
    {
      client_order_id: 'lot-3',
      instrument: 'BTC-USD',
      stop_order_id: 'stop-1',
      target_order_id: 'tp-1',
      observed_at: AT,
    },
  ],
  legResizeAlerts: [
    {
      client_order_id: 'lot-4',
      instrument: '3LUS',
      requested_qty: 10,
      filled_qty: 4,
      observed_at: AT,
    },
    {
      client_order_id: 'lot-4',
      instrument: '3LUS',
      requested_qty: null,
      filled_qty: 4,
      observed_at: AT,
    },
  ],
  dormantLegsAlerts: [
    { client_order_id: 'lot-5', instrument: 'QQQ3', stuck_ms: 1_500_000, observed_at: AT },
  ],
  priceUnitAlerts: [
    { client_order_id: 'lot-6', broker_fill_id: 'act-12', uic: 12345, observed_at: AT },
  ],
  flattenReconcileAlerts: [
    {
      trace_id: 'reconcile',
      idempotency_key: 'flatten-1',
      instrument: 'TSLA',
      reason: 'venue reports open, journal reports filled',
      observed_at: AT,
    },
    {
      trace_id: 'control-arm-reconcile',
      idempotency_key: 'flatten-1',
      instrument: 'TSLA',
      reason: 'venue reports open, journal reports filled',
      observed_at: AT,
    },
  ],
  analystSkipAlerts: [
    {
      instrument: 'SPY',
      consecutive_skips: 3,
      failures: [
        { analyst_type: 'technical', role: 'mandatory', reason: 'no bars', kind: 'transport' },
        { analyst_type: 'news', role: 'optional', reason: 'rate limited', kind: 'rate_limited' },
      ],
      reported_at: AT,
    },
    { instrument: 'QQQ', consecutive_skips: 2, failures: [], reported_at: AT },
  ],
  breachAlerts: [
    { breaches: ['pbo_over_line', 'oos_sharpe_under_line'], reported_at: AT },
    { breaches: ['llm_spend_cap'], reported_at: AT },
    { breaches: ['pbo_over_line', 'llm_spend_cap'], reported_at: AT },
    { breaches: [], reported_at: AT },
  ],
  loosenNotices: [{ name: 'max_position_pct', from: 0.2, to: 0.22, applied_at: AT }],
  traderDiagnosticAlerts: [
    {
      instrument: 'SPY',
      diagnostic: {
        kind: 'lot_carried_past_session_close',
        asset_class: 'stocks',
        detail: 'grace expired 16:35',
      },
      consecutive_ticks: 4,
      reported_at: AT,
    },
    {
      instrument: 'SPY',
      diagnostic: {
        kind: 'control_arm_valuation_refused',
        asset_class: undefined,
        detail: 'shadow book unvalued',
      },
      consecutive_ticks: 1,
      reported_at: AT,
    },
    {
      instrument: 'BTC-USD',
      diagnostic: { kind: 'atr_not_finite', asset_class: 'crypto', detail: 'ATR NaN' },
      consecutive_ticks: 2,
      reported_at: AT,
    },
    {
      instrument: 'AAPL',
      diagnostic: {
        kind: 'session_end_absent_on_non_crypto',
        asset_class: 'stocks',
        detail: 'calendar returned null',
      },
      consecutive_ticks: 1,
      reported_at: AT,
    },
  ],
  miCoverageAlerts: [
    {
      trace_id: 'tick-9',
      instrument: 'SPY',
      asset_class: 'stocks',
      subclass: 'index_etp_3x',
      reported_at: AT,
    },
  ],
  thresholdClampAlerts: [
    {
      trace_id: 'tick-3',
      where: 'live-read',
      message: 'max_position_pct 0.9 above ceiling 0.5',
      reported_at: AT,
    },
    {
      trace_id: 'feedback-cycle',
      where: 'daily-kill-line-check',
      message: 'max_position_pct 0.9 above ceiling 0.5',
      reported_at: AT,
    },
  ],
  dataFailoverAlerts: [
    {
      leg: 'equities',
      symbol: 'SPY',
      timeframe: '1h',
      primaryName: 'alpaca',
      fallbackName: 'polygon',
      primaryError: 'HTTP 503',
      reported_at: AT,
      suppressed_since_last: 0,
    },
    {
      leg: 'crypto',
      symbol: 'BTC-USD',
      timeframe: '15m',
      primaryName: 'coinbase',
      fallbackName: 'bitstamp',
      primaryError: 'timeout',
      reported_at: AT,
      suppressed_since_last: 4,
    },
  ],
  exitValuationAlerts: [
    {
      instrument: 'SPY',
      seam: 'risk',
      unvalued_instruments: ['QQQ', 'AAPL'],
      reason: 'no mark for QQQ',
      reported_at: AT,
    },
    {
      instrument: 'SPY',
      seam: 'verdict',
      unvalued_instruments: ['QQQ'],
      reason: 'no mark for QQQ',
      reported_at: AT,
    },
    {
      instrument: 'SPY',
      seam: 'trader',
      unvalued_instruments: ['SPY'],
      reason: 'no mark for SPY',
      reported_at: AT,
    },
  ],
  calendarFallbackAlerts: [
    { reason: 'ECONNREFUSED', fallback_coverage_end: '2026-12-31', reported_at: AT },
  ],
  armDivergenceAlerts: [
    {
      comparison: {
        from: new Date('2026-08-02T00:00:00Z'),
        to: new Date('2026-09-01T00:00:00Z'),
        basis: 1000,
        live: {
          arm: 'live',
          trade_count: 11,
          realized_pnl_net: -4.5,
          return_pct: -0.0045,
          max_drawdown_pct: 0.031,
          refused_pass_count: 0,
          cost_basis_drops: noCostBasisDrops(),
        },
        control: {
          arm: 'control',
          trade_count: 14,
          realized_pnl_net: 18.2,
          return_pct: 0.0182,
          max_drawdown_pct: 0.019,
          refused_pass_count: 0,
          cost_basis_drops: noCostBasisDrops(),
        },
      },
      reason: 'the control arm is ahead by 2.27% of the book over this window',
      reported_at: AT,
    },
  ],
  tickSkipAlerts: [
    {
      skipped: 2,
      planned: 4,
      skipped_instruments: ['SPY', 'QQQ'],
      consecutive_ticks: 1,
      reported_at: AT,
    },
    { skipped: 0, planned: 4, skipped_instruments: [], consecutive_ticks: 3, reported_at: AT },
  ],
  promptTierAlerts: [
    {
      model: 'gpt-x',
      trace_id: 'tick-5',
      stage: 'debate',
      debate_id: 'deb-1',
      prompt_tokens: 40_000,
      above_prompt_tokens: 32_000,
      consecutive_crossings: 2,
      reported_at: AT,
    },
    {
      model: 'gpt-x',
      trace_id: 'tick-6',
      stage: 'analysts',
      debate_id: undefined,
      prompt_tokens: 33_000,
      above_prompt_tokens: 32_000,
      consecutive_crossings: 1,
      reported_at: AT,
    },
  ],
  lseCalendarCoverageAlerts: [{ coverage_end: '2026-12-31', days_remaining: 12, reported_at: AT }],
  llmFailureRateAlerts: [
    {
      rate: 0.4167,
      llm_failure_count: 5,
      total_count: 12,
      window_ms: 7_200_000,
      reported_at: AT,
    },
  ],
  nonSterlingFeeAlerts: [
    {
      trace_id: 'fill-sync',
      idempotency_key: 'lot-7',
      instrument: 'XYZ',
      broker_fill_id: 'fill-3',
      fee: 1.25,
      fee_currency: 'USD',
      book_currency: 'GBP',
    },
  ],
  unattributedFlattenFillAlerts: [
    {
      trace_id: 'fill-sync',
      flatten_idempotency_key: 'flatten-2',
      lot_idempotency_key: 'lot-9',
      broker_fill_id: 'fill-4',
      qty: 3,
      observed_at: new Date('2026-01-02T10:00:00Z'),
    },
  ],
  saxoSessionLostAlerts: [
    {
      environment: 'sim',
      reason: 'the refresh token was rejected (HTTP 400)',
      reported_at: AT,
    },
  ],
  saxoWeeklyReminderAlerts: [
    { environment: 'live', last_logged_in_at: '2026-09-07T18:00:00.000Z', reported_at: AT },
    { environment: 'sim', reported_at: AT },
  ],
};

/** Each port through its own method name — what makes `asPort`'s cast in the catalogue safe. */
const INVOKE: { readonly [K in AlertId]: (port: AlertPort<K>, alert: AlertOf<K>) => unknown } = {
  heartbeatChannel: (port, alert) => port.postHeartbeat(alert),
  orphanAlerts: (port, alert) => port.postOrphanAlert(alert),
  unpricedFillAlerts: (port, alert) => port.postUnpricedFillAlert(alert),
  residualExposureAlerts: (port, alert) => port.postResidualExposureAlert(alert),
  ocoDoubleFillAlerts: (port, alert) => port.postOcoDoubleFillAlert(alert),
  legResizeAlerts: (port, alert) => port.postLegResizeUnverifiedAlert(alert),
  dormantLegsAlerts: (port, alert) => port.postDormantLegsUnresolvedAlert(alert),
  priceUnitAlerts: (port, alert) => port.postUnresolvedPriceUnitAlert(alert),
  flattenReconcileAlerts: (port, alert) => port.postFlattenReconcileAlert(alert),
  analystSkipAlerts: (port, alert) => port.postAnalystSkipAlert(alert),
  breachAlerts: (port, alert) => port.postBreachAlert(alert),
  loosenNotices: (port, alert) => port.notifyLoosenApplied(alert),
  traderDiagnosticAlerts: (port, alert) => port.postTraderDiagnosticAlert(alert),
  miCoverageAlerts: (port, alert) => port.postCoverageAlert(alert),
  thresholdClampAlerts: (port, alert) => port.postThresholdClampAlert(alert),
  dataFailoverAlerts: (port, alert) => port.postDataFailoverAlert(alert),
  exitValuationAlerts: (port, alert) => port.postExitValuationDegradedAlert(alert),
  calendarFallbackAlerts: (port, alert) => port.postCalendarFallbackAlert(alert),
  armDivergenceAlerts: (port, alert) => port.postArmDivergenceAlert(alert),
  tickSkipAlerts: (port, alert) => port.postTickSkipAlert(alert),
  promptTierAlerts: (port, alert) => port.postPromptTierAlert(alert),
  lseCalendarCoverageAlerts: (port, alert) => port.postLseCalendarCoverageAlert(alert),
  llmFailureRateAlerts: (port, alert) => port.postLlmFailureRateAlert(alert),
  nonSterlingFeeAlerts: (port, alert) => port.postNonSterlingFeeAlert(alert),
  unattributedFlattenFillAlerts: (port, alert) => port.postUnattributedFlattenFillAlert(alert),
  saxoSessionLostAlerts: (port, alert) => port.postSaxoSessionLostAlert(alert),
  saxoWeeklyReminderAlerts: (port, alert) => port.postSaxoWeeklyReminderAlert(alert),
};

interface GoldenCase {
  readonly log: unknown;
  readonly logInTrace: unknown;
  readonly text: string | null;
  readonly rejected: string | null;
  readonly sendFailed: unknown;
  readonly sendFailedInTrace: unknown;
}

const GOLDEN: { readonly [K in AlertId]: readonly GoldenCase[] } = JSON.parse(
  readFileSync(new URL('./alert-catalogue.golden.json', import.meta.url), 'utf8'),
);

/** The golden went through JSON once, so the live value must too (Dates become ISO strings). */
function roundTrip(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function telegramStub(outcome: 'sends' | 'fails'): TelegramClient & { sent: [string, string][] } {
  const sent: [string, string][] = [];
  return {
    sent,
    sendMessage: async (chatId, text) => {
      if (outcome === 'fails') throw new Error('telegram 502');
      sent.push([chatId, text]);
    },
  };
}

/** Lets a detached send's `.catch` run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function outcomeOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isLogged(id: AlertId): id is LoggedAlertId {
  return !UNLOGGED_ALERT_IDS.some((unlogged) => unlogged === id);
}

describe('ALERT_CATALOGUE', () => {
  it('lists exactly the ids without a log-only form in UNLOGGED_ALERT_IDS', () => {
    const unlogged = ALERT_IDS.filter((id) => ALERT_CATALOGUE[id].log === undefined);
    expect(unlogged).toEqual([...UNLOGGED_ALERT_IDS]);
  });

  it('has a golden case for every fixture case', () => {
    for (const id of ALERT_IDS) {
      expect(GOLDEN[id], id).toHaveLength(FIXTURES[id].length);
    }
  });
});

function describeLogging<K extends LoggedAlertId>(id: K): void {
  describe(`loggingAlertChannel('${id}')`, () => {
    FIXTURES[id].forEach((alert, index) => {
      const expected = GOLDEN[id][index];

      it(`case ${index}: writes the golden log line`, async () => {
        const logger = recordingLogger();

        await INVOKE[id](loggingAlertChannel(id, logger), alert);

        expect(logger.entries.map(roundTrip)).toEqual([expected?.log]);
      });

      it(`case ${index}: writes the golden log line from inside a tick`, async () => {
        const logger = recordingLogger();
        const channel = loggingAlertChannel(id, logger);

        await runWithTraceId('tick-x', () => INVOKE[id](channel, alert));

        expect(logger.entries.map(roundTrip)).toEqual([expected?.logInTrace]);
      });
    });
  });
}

function describeTradeChannel<K extends AlertId>(id: K): void {
  const { delivery } = ALERT_CATALOGUE[id];

  describe(`tradeChannelAlert('${id}')`, () => {
    FIXTURES[id].forEach((alert, index) => {
      const expected = GOLDEN[id][index];

      it(`case ${index}: sends the golden text, and logs nothing`, async () => {
        const telegram = telegramStub('sends');
        const logger = recordingLogger();
        const channel = tradeChannelAlert(id, { telegram, chatId: CHAT_ID, logger });

        const returned = INVOKE[id](channel, alert);
        await returned;
        await settle();

        // A detached port answers nothing, so no caller can await a page
        // that was never going to reach it; an awaited one hands back the send.
        expect(returned === undefined).toBe(delivery === 'detached');
        expect(telegram.sent).toEqual(expected?.text === null ? [] : [[CHAT_ID, expected?.text]]);
        expect(logger.entries).toEqual([]);
      });

      it(`case ${index}: on a failed send, rejects or logs exactly as the golden says`, async () => {
        const telegram = telegramStub('fails');
        const logger = recordingLogger();
        const channel = tradeChannelAlert(id, { telegram, chatId: CHAT_ID, logger });

        const rejected = await outcomeOf(() => INVOKE[id](channel, alert));
        await settle();

        expect(rejected).toBe(expected?.rejected);
        expect(logger.entries.map(roundTrip)).toEqual(
          expected?.sendFailed === null ? [] : [expected?.sendFailed],
        );
      });

      it(`case ${index}: on a failed send inside a tick, logs exactly as the golden says`, async () => {
        const telegram = telegramStub('fails');
        const logger = recordingLogger();
        const channel = tradeChannelAlert(id, { telegram, chatId: CHAT_ID, logger });

        await runWithTraceId('tick-x', () => outcomeOf(() => INVOKE[id](channel, alert)));
        await settle();

        expect(logger.entries.map(roundTrip)).toEqual(
          expected?.sendFailedInTrace === null ? [] : [expected?.sendFailedInTrace],
        );
      });
    });
  });
}

for (const id of ALERT_IDS) {
  if (isLogged(id)) describeLogging(id);
  describeTradeChannel(id);
}

describe('armDivergenceAlerts text', () => {
  const [ALERT] = FIXTURES.armDivergenceAlerts;
  const { text } = ALERT_CATALOGUE.armDivergenceAlerts;

  it('prints both arms with return AND drawdown — no return-only line exists (doc 12 D4)', () => {
    // Structural rather than by substring, so an edit that splits the
    // columns onto separate lines fails here.
    const armLines = text(ALERT)
      .split('\n')
      .filter((line) => line.includes('return '));
    expect(armLines).toHaveLength(2);
    for (const line of armLines) {
      expect(line).toContain('max drawdown');
    }
  });

  /**
   * #1099 added `refused_pass_count` to `ArmPerformance`, which this alert
   * carries whole. The ruling kept refusals OUT of alerting, so the message an
   * operator's phone shows must not move — the formatter picks its fields
   * explicitly and reads no refusal count.
   */
  it('renders the identical message whether or not the window carried refusals', () => {
    const refused = {
      ...ALERT,
      comparison: {
        ...ALERT.comparison,
        live: { ...ALERT.comparison.live, refused_pass_count: 3 },
        control: { ...ALERT.comparison.control, refused_pass_count: 27 },
      },
    };

    expect(text(refused)).toBe(text(ALERT));
  });
});

describe('residualExposureAlerts text', () => {
  const [ALERT] = FIXTURES.residualExposureAlerts;
  const { text } = ALERT_CATALOGUE.residualExposureAlerts;

  // #1348: `trace_id` was added to `ResidualExposureAlert` purely to
  // distinguish the two arms at the LOG line — the Telegram body must not
  // change with it, or the arm label would leak onto an operator's phone
  // through a formatter no one intended to touch.
  it('does not vary with trace_id', () => {
    expect(text({ ...ALERT, trace_id: 'control-arm-fill-sync' })).toBe(
      text({ ...ALERT, trace_id: 'fill-sync' }),
    );
  });
});

describe('flattenReconcileAlerts page predicate (#1349)', () => {
  const [ALERT] = FIXTURES.flattenReconcileAlerts;

  // DECISION (David, 2026-09-08, #1349): the control arm's broker is
  // `SimulatedBrokerAdapter` — there is no venue, so this page's "check the
  // order on the venue by hand" instruction is never actionable for a
  // control-arm trace_id. The predicate reads the whole trace_id, not a
  // fixed literal, so both surfaces of each arm resolve the same way.
  it.each([
    ['reconcile', true],
    ['fill-sync', true],
    ['control-arm-reconcile', false],
    ['control-arm-fill-sync', false],
  ])('%s pages: %s', async (trace_id, pages) => {
    const telegram = telegramStub('sends');
    const channel = tradeChannelAlert('flattenReconcileAlerts', {
      telegram,
      chatId: CHAT_ID,
      logger: recordingLogger(),
    });

    await expect(
      channel.postFlattenReconcileAlert({ ...ALERT, trace_id }),
    ).resolves.toBeUndefined();

    expect(telegram.sent).toHaveLength(pages ? 1 : 0);
    if (pages) expect(telegram.sent[0]?.[1]).toContain(`[${trace_id}]`);
  });
});
