import { RSI_SPEC, SMA_SPEC } from '../../pipeline/analysts/technical-analyst.js';
import type { ArmPerformance } from '../../pipeline/control-arm/index.js';
import { noCostBasisDrops } from '../../pipeline/control-arm/index.js';
import type { ReconcileDivergence } from '../../pipeline/execution/index.js';
import { computeIndicator } from '../../providers/market-data-service/index.js';
import { GUARDED_THRESHOLD_NAMES } from '../../shared/index.js';
import { openSharedStore, STAGE_OWNED_TABLES } from '../../shared/store/index.js';
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD } from './paper-profile.js';
import {
  type AnalystFailureCauseEvidence,
  type ApprovalFallbackEvidence,
  type ArmComparisonEvidence,
  buildSmokeFixtureBars,
  ConstantResponseLlmClient,
  type DataFailoverEvidence,
  type DataSourceFactoryEvidence,
  type EntrypointFaultGuardEvidence,
  type ExitPathEvidence,
  evaluateSmokeGate,
  FAILOVER_IN_SESSION_OPEN_TIMES,
  type FilledZeroSizeWedgeEvidence,
  type FillSyncFailure,
  type FillSyncFailureEvidence,
  FillSyncFailureRecorder,
  FixedAccountStateProvider,
  findSweepDivergence,
  formatSmokeReport,
  type LoggerResilienceEvidence,
  type LogRetentionEvidence,
  type MarketDataFetchEvidence,
  MarketDataFetchRecorder,
  type OutsideBenchmarkEvidence,
  type PromptTierWarningEvidence,
  type RiskCriticEvidence,
  runArmComparisonProbe,
  runSmoke,
  type SizingCeilingEvidence,
  SMOKE_GDELT_EXPECTED_AGGREGATES,
  SMOKE_GDELT_EXPECTED_ROWS,
  SMOKE_LLM_RESPONSE,
  SMOKE_LSE_VENDOR,
  SMOKE_RUN_INSTANT,
  type SmokeEvidence,
  type SmokeObservations,
  type ThresholdClampEvidence,
  UnreachableAlpacaClient,
  untoleratedFillSyncFailures,
} from './smoke-run.js';

const BOTH_TIERS = [
  { tier: 'portfolio_drawdown', tripped: 0 },
  { tier: 'kill_switch', tripped: 0 },
];

function healthyExitPath(overrides: Partial<ExitPathEvidence> = {}): ExitPathEvidence {
  return {
    brokerCallSequence: ['cancel:lot-1', 'submitFlatten:lot-1-exit'],
    residualAlerts: [
      {
        trace_id: 'fill-sync',
        idempotency_key: 'lot-sweep',
        instrument: 'LINK-USD',
        side: 'buy',
        residual_qty: 6,
        residual_qty_is_upper_bound: false,
        rearm_unsupported: false,
        stop: 90,
        target: 120,
        observed_at: SMOKE_RUN_INSTANT,
      },
    ],
    fullExit: { lotKey: 'idem-exit-1' },
    partialFlatten: { idempotencyKey: 'lot-partial', expectedResidual: 0, protectedQty: 0 },
    twoLotFlatten: { lotKeys: [] },
    crashRestart: {
      lotKey: 'idem-crash-restart-1',
      flattenKey: 'idem-crash-restart-1-exit',
      reconcileReport: {
        checked: 1,
        corrected: 1,
        divergences: [
          {
            idempotency_key: 'idem-crash-restart-1-exit',
            instrument: 'DOGE-USD',
            store_state: 'submitted',
            broker_state: 'submitted',
            action: 'adopted',
            kind: 'flatten',
            reason: "flatten journal said 'submitted'; broker reports 'submitted'",
          },
        ],
        swept: 0,
        timestamp: SMOKE_RUN_INSTANT,
      },
    },
    flattenReconcileAlerts: [],
    residualSweep: {
      lotKey: 'lot-sweep',
      expectedResidual: 6,
      protectedQty: 6,
      markerCleared: true,
      sweepDivergenceAction: 'adopted',
      sweepDivergenceReason:
        'protective legs re-armed for residual 6 by the #549 sweep — ' +
        'residual-protection marker cleared',
    },
    terminalSweep: {
      seededKey: 'smoke-terminal-sweep-target',
      rowPresentAfterSweep: false,
      swept: 1,
    },
    ...overrides,
  };
}

function transactedObservations(): SmokeObservations {
  return {
    ticks: [
      {
        trace_id: 'trace-1',
        stages: [
          { stage: 'analysts', decision: 'quorum_met' },
          { stage: 'debate', decision: 'bullish' },
          { stage: 'trader', decision: 'entry' },
          { stage: 'risk', decision: 'approved' },
          { stage: 'verdict', decision: 'go' },
          { stage: 'execution', decision: 'submitted' },
        ],
      },
      { trace_id: 'trace-2', stages: [{ stage: 'analysts', decision: 'quorum_met' }] },
    ],
    debates: [
      {
        debate_id: 'debate-1',
        instrument: 'BTC-USD',
        direction: 'bullish',
        rounds: 1,
        termination: 'converged',
      },
    ],
    verdicts: [
      {
        trace_id: 'trace-1',
        instrument: 'BTC-USD',
        status: 'go',
        no_go_reason: null,
        no_go_detail_measured_ms: null,
        no_go_detail_bound_ms: null,
      },
    ],
    positions: [
      {
        idempotency_key: 'idem-1',
        instrument: 'BTC-USD',
        side: 'buy',
        requested_size: 31.25,
        filled_size: 31.25,
        avg_entry_price: 161,
        order_state: 'filled',
        arm: 'live',
      },
      {
        idempotency_key: 'idem-1-control',
        instrument: 'BTC-USD',
        side: 'buy',
        requested_size: 31.25,
        filled_size: 31.25,
        avg_entry_price: 161,
        order_state: 'filled',
        arm: 'control',
      },
      {
        idempotency_key: 'idem-exit-1',
        instrument: 'ETH-USD',
        side: 'buy',
        requested_size: 10,
        filled_size: 10,
        avg_entry_price: 160,
        order_state: 'closed',
        arm: 'live',
      },
      {
        idempotency_key: 'idem-crash-restart-1',
        instrument: 'DOGE-USD',
        side: 'buy',
        requested_size: 10,
        filled_size: 10,
        avg_entry_price: 160,
        order_state: 'closed',
        arm: 'live',
      },
    ],
    fills: [{ idempotency_key: 'idem-1', leg: 'entry', price: 161, qty: 31.25, fee: 13 }],
    closedTrades: [
      { idempotency_key: 'idem-exit-1', realized_pnl_net: 42, close_reason: 'exit', arm: 'live' },
    ],
    flattenSubmissions: [
      { idempotency_key: 'idem-exit-1', instrument: 'BTC-USD', status: 'submitted' },
    ],
    gdeltRowsArchived: SMOKE_GDELT_EXPECTED_ROWS,
    gdeltAggregateItems: SMOKE_GDELT_EXPECTED_AGGREGATES,
    polymarketRowsArchived: 1,
    polymarketItemsArchived: 1,
    polymarketIntelItems: 1,
    cosineSetups: [{ debate_id: 'debate-1', instrument: 'BTC-USD' }],
    riskThresholds: [{ name: 'max_position_size', value: 5_000 }],
    analystWeights: [{ analyst_id: 'technical' }],
    traderDecisions: [{ trace_id: 'trace-1', instrument: 'BTC-USD', intent_type: 'entry' }],
    breakerStates: BOTH_TIERS,
    riskDecisions: [{ trace_id: 'trace-1', instrument: 'BTC-USD', status: 'approved' }],
  };
}

function meteredSnapshot() {
  return { crypto: { debatesUsed: 1, llmCallsUsed: 4 } };
}

interface HealthyGateOptionOverrides {
  minTicks?: number;
  alpacaWireClientReached?: boolean;
  exitPath?: ExitPathEvidence;
  loggerResilience?: LoggerResilienceEvidence;
  logRetention?: LogRetentionEvidence;
  entrypointFaultGuards?: EntrypointFaultGuardEvidence;
  thresholdClamp?: ThresholdClampEvidence;
  approvalFallback?: ApprovalFallbackEvidence;
  dataFailover?: DataFailoverEvidence;
  dataSourceFactory?: DataSourceFactoryEvidence;
  riskCritic?: RiskCriticEvidence;
  promptTierWarning?: PromptTierWarningEvidence;
  analystFailureCause?: AnalystFailureCauseEvidence;
  filledZeroSizeWedge?: FilledZeroSizeWedgeEvidence;
  armComparison?: ArmComparisonEvidence;
  outsideBenchmarks?: OutsideBenchmarkEvidence;
  feedbackCycleScheduleWritten?: boolean;
  sizingCeiling?: Partial<SizingCeilingEvidence>;
  fillSync?: FillSyncFailureEvidence;
  marketDataFetch?: MarketDataFetchEvidence;
  publishedLlmCapUsd?: number | null;
  configuredLlmBudgetUsd?: number | undefined;
  publishedLlmCapArmedAt?: string | null;
}

function healthyGateOptionsGroupA(overrides: HealthyGateOptionOverrides) {
  return {
    fillSync: overrides.fillSync ?? healthyFillSync(),
    marketDataFetch: overrides.marketDataFetch ?? healthyMarketDataFetch(),
    armComparison: overrides.armComparison ?? healthyArmComparison(),
    outsideBenchmarks: overrides.outsideBenchmarks ?? healthyOutsideBenchmarks(),
    feedbackCycleScheduleWritten: overrides.feedbackCycleScheduleWritten ?? true,
  };
}

function healthyGateOptionsGroupB(overrides: HealthyGateOptionOverrides) {
  return {
    exitPath: overrides.exitPath ?? healthyExitPath(),
    loggerResilience: overrides.loggerResilience ?? healthyLoggerResilience(),
    logRetention: overrides.logRetention ?? healthyLogRetention(),
    entrypointFaultGuards: overrides.entrypointFaultGuards ?? healthyEntrypointFaultGuards(),
    thresholdClamp: overrides.thresholdClamp ?? healthyThresholdClamp(),
    approvalFallback: overrides.approvalFallback ?? healthyApprovalFallback(),
  };
}

function healthyGateOptionsGroupC(overrides: HealthyGateOptionOverrides) {
  return {
    dataFailover: overrides.dataFailover ?? healthyDataFailover(),
    dataSourceFactory: overrides.dataSourceFactory ?? healthyDataSourceFactory(),
    riskCritic: overrides.riskCritic ?? healthyRiskCritic(),
    promptTierWarning: overrides.promptTierWarning ?? healthyPromptTierWarning(),
    analystFailureCause: overrides.analystFailureCause ?? healthyAnalystFailureCause(),
    filledZeroSizeWedge: overrides.filledZeroSizeWedge ?? healthyFilledZeroSizeWedge(),
  };
}

function healthyLlmSpendCap(overrides: HealthyGateOptionOverrides): SmokeEvidence['llmSpendCap'] {
  return {
    publishedCapUsd:
      'publishedLlmCapUsd' in overrides ? (overrides.publishedLlmCapUsd ?? null) : 50,
    configuredBudgetUsd:
      'configuredLlmBudgetUsd' in overrides ? overrides.configuredLlmBudgetUsd : 50,
    capArmedAt:
      'publishedLlmCapArmedAt' in overrides
        ? (overrides.publishedLlmCapArmedAt ?? null)
        : '2026-08-05T14:00:00.000Z',
  };
}

function healthyGateOptions(overrides: HealthyGateOptionOverrides = {}): SmokeEvidence {
  return {
    ...healthyGateOptionsGroupA(overrides),
    sizingCeiling: {
      configuredCeiling: LIVE_BOOK_SIZING_USD,
      rows: 1,
      allMatchConfiguredCeiling: true,
      ...overrides.sizingCeiling,
    },
    tickLoop: {
      minTicks: overrides.minTicks ?? 2,
      alpacaWireClientReached: overrides.alpacaWireClientReached ?? false,
    },
    llmRateLimiterSnapshot: meteredSnapshot(),
    ...healthyGateOptionsGroupB(overrides),
    ...healthyGateOptionsGroupC(overrides),
    llmSpendCap: healthyLlmSpendCap(overrides),
  };
}

function healthyArmComparison(
  overrides: Partial<ArmComparisonEvidence> = {},
): ArmComparisonEvidence {
  const arm = (name: 'live' | 'control'): ArmPerformance => ({
    arm: name,
    trade_count: 0,
    realized_pnl_net: 0,
    return_pct: 0,
    max_drawdown_pct: 0,
    refused_pass_count: 0,
    cost_basis_drops: noCostBasisDrops(),
  });
  return {
    live: arm('live'),
    control: arm('control'),
    persistedRows: 1,
    persistedBothDrawdowns: true,
    diverged: false,
    alerts: 0,
    comparison: {
      from: ARM_WINDOW_FROM,
      to: ARM_WINDOW_TO,
      basis: LIVE_BOOK_SIZING_USD,
      live: arm('live'),
      control: arm('control'),
    },
    ...overrides,
  };
}

const ARM_WINDOW_FROM = new Date('2026-08-02T00:00:00.000Z');
const ARM_WINDOW_TO = new Date('2026-09-01T00:00:00.000Z');

function healthyOutsideBenchmarks(
  overrides: Partial<OutsideBenchmarkEvidence> = {},
): OutsideBenchmarkEvidence {
  return {
    measured: 2,
    persistedRows: 2,
    persistedBothColumns: true,
    windowsMatchArmComparison: true,
    unmeasured: [],
    ...overrides,
  };
}

function healthyFillSync(
  overrides: Partial<FillSyncFailureEvidence> = {},
): FillSyncFailureEvidence {
  return { failures: [], ...overrides };
}

function healthyMarketDataFetch(
  overrides: Partial<MarketDataFetchEvidence> = {},
): MarketDataFetchEvidence {
  return { fetchCount: 1, traceIds: ['trace-1'], ...overrides };
}

function healthyRiskCritic(overrides: Partial<RiskCriticEvidence> = {}): RiskCriticEvidence {
  return {
    loggedVerdicts: ['pass'],
    stepError: null,
    conditionStates: ['breached'],
    bindingConstraint: 'risk_critic:invalidated',
    ...overrides,
  };
}

function healthyPromptTierWarning(
  overrides: Partial<PromptTierWarningEvidence> = {},
): PromptTierWarningEvidence {
  return {
    alertsFired: 1,
    spendRows: 2,
    costUsd: 0.812_004,
    ...overrides,
  };
}

function healthyFilledZeroSizeWedge(
  overrides: Partial<FilledZeroSizeWedgeEvidence> = {},
): FilledZeroSizeWedgeEvidence {
  return {
    warnings: [
      {
        idempotency_key: 'smoke-filled-zero-size-wedge',
        instrument: 'AAPL',
        order_state: 'filled',
        consecutive: 3,
        stuck_ms: 3_600_000,
      },
    ],
    ...overrides,
  };
}

function healthyAnalystFailureCause(
  overrides: Partial<AnalystFailureCauseEvidence> = {},
): AnalystFailureCauseEvidence {
  return {
    failureKinds: ['other'],
    debugPayloads: [
      {
        analyst_type: 'technical',
        attempt: 1,
        name: 'Error',
        message:
          'equities bars for SPY 5m: alpaca (primary, failed: alpaca down) and polygon (fallback) failed.',
        cause: 'polygon down too',
      },
    ],
    ...overrides,
  };
}

function healthyDataFailover(overrides: Partial<DataFailoverEvidence> = {}): DataFailoverEvidence {
  return {
    storedSources: FAILOVER_IN_SESSION_OPEN_TIMES.map(() => 'polygon'),
    storedOpenTimes: FAILOVER_IN_SESSION_OPEN_TIMES,
    alerts: [
      {
        leg: 'equities',
        symbol: 'SPY',
        timeframe: '1h',
        primaryName: 'alpaca',
        fallbackName: 'polygon',
        primaryError: 'alpaca 503 (smoke failover probe)',
        reported_at: new Date('2026-08-04T12:00:00.000Z'),
        suppressed_since_last: 0,
      },
    ],
    readError: null,
    ...overrides,
  };
}

function healthyDataSourceFactory(
  overrides: Partial<DataSourceFactoryEvidence> = {},
): DataSourceFactoryEvidence {
  return {
    alpacaStoredSources: ['alpaca', 'alpaca'],
    lseStoredSources: [SMOKE_LSE_VENDOR, SMOKE_LSE_VENDOR],
    error: null,
    ...overrides,
  };
}

function healthyEntrypointFaultGuards(
  overrides: Partial<EntrypointFaultGuardEvidence['entries'][number]>[] = [],
): EntrypointFaultGuardEvidence {
  const base: EntrypointFaultGuardEvidence['entries'] = [
    {
      name: 'service-api',
      faultReportedOnStderr: true,
      continuesOnArbitraryFault: true,
    },
    {
      name: 'supervisor',
      faultReportedOnStderr: true,
      continuesOnArbitraryFault: true,
    },
  ];
  return {
    entries: base.map((entry, index) => ({ ...entry, ...overrides[index] })),
  };
}

function healthyThresholdClamp(
  overrides: Partial<ThresholdClampEvidence> = {},
): ThresholdClampEvidence {
  return {
    probedNames: [...GUARDED_THRESHOLD_NAMES],
    liveReadAccepted: [],
    writeDoorAccepted: [],
    breakerConstructionRefused: true,
    killLineCheckRefused: true,
    shippedConfigAccepted: true,
    exitBypassesLiveClamp: true,
    ...overrides,
  };
}

function healthyApprovalFallback(
  overrides: Partial<ApprovalFallbackEvidence> = {},
): ApprovalFallbackEvidence {
  return {
    refusedFabricatedConsent: true,
    message: "Verdict's HITL gate (6) was reached, but no ApprovalChannel is wired.",
    ...overrides,
  };
}

function healthyLoggerResilience(
  overrides: Partial<LoggerResilienceEvidence> = {},
): LoggerResilienceEvidence {
  return {
    stdoutRetired: true,
    degradationRecordedInFile: true,
    linesAfterStdoutDeath: 1,
    escalatedWhenNothingCouldRecord: true,
    lastResortTraceOnStderr: true,
    fatalRecordedInFile: true,
    fatalExitCode: 1,
    ...overrides,
  };
}

function healthyLogRetention(overrides: Partial<LogRetentionEvidence> = {}): LogRetentionEvidence {
  return {
    staleFileRemoved: true,
    freshFileKept: true,
    protectedFileKeptDespiteAge: true,
    liveShapedFileKeptDespiteAge: true,
    nonLogFileKeptDespiteAge: true,
    oversizedSoakBootTruncatedByDefault: true,
    bytesReclaimed: 11,
    ...overrides,
  };
}

describe('evaluateSmokeGate', () => {
  it('passes when the pipeline transacted end to end', () => {
    const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

    expect(gate.failures).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  it('fails when no ClosedTrade was ever recorded', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), closedTrades: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no row in closed_trades'))).toBe(true);
  });

  it('fails when a debate reached the Trader but trader_log is empty (#328)', () => {
    const observations = transactedObservations();
    observations.traderDecisions = [];
    observations.riskDecisions = [];

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('no row in trader_log');
  });

  it('fails when the Trader produced an intent but risk_log is empty (#328)', () => {
    const observations = transactedObservations();
    observations.riskDecisions = [];

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('no row in risk_log');
  });

  it('does not demand a trader_log row when no debate resolved (#328)', () => {
    const observations = transactedObservations();
    observations.debates = [];
    observations.traderDecisions = [];
    observations.riskDecisions = [];

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.failures.join(' ')).not.toContain('trader_log');
  });

  it('fails when the GDELT poller archived nothing — the no-caller shape (#556)', () => {
    const observations = transactedObservations();
    observations.gdeltRowsArchived = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('GDELT archived 0 macro rows');
  });

  it('fails when the Polymarket poller archived nothing — the no-caller shape (#504)', () => {
    const observations = transactedObservations();
    observations.polymarketRowsArchived = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('Polymarket archived 0 macro rows');
  });

  it('fails when Polymarket archived raw bytes but no items (#835)', () => {
    const observations = transactedObservations();
    observations.polymarketItemsArchived = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('archived 0 items in mi_items');
  });

  it('fails when Polymarket fetched but nothing reached the intel bucket (#504)', () => {
    const observations = transactedObservations();
    observations.polymarketIntelItems = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('Polymarket put 0 items in the intel bucket');
  });

  it('fails when the GDELT theme filter stopped filtering (#556)', () => {
    const observations = transactedObservations();
    observations.gdeltRowsArchived = 2;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('GDELT archived 2 macro rows');
  });

  it('fails when the loop ran fewer ticks than asked for', () => {
    const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions({ minTicks: 5 }));

    expect(gate.passed).toBe(false);
    expect(gate.failures[0]).toContain('completed 2 of 5 expected ticks');
  });

  it('fails when every tick short-circuited at Analysts', () => {
    const observations: SmokeObservations = {
      ...transactedObservations(),
      ticks: [
        { trace_id: 'trace-1', stages: [{ stage: 'analysts', decision: 'quorum_skip' }] },
        { trace_id: 'trace-2', stages: [{ stage: 'analysts', decision: 'quorum_skip' }] },
      ],
      debates: [],
      verdicts: [],
      positions: [],
      fills: [],
    };

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no tick got past Analysts'))).toBe(
      true,
    );
  });

  it('fails when the live arm transacted but falsifier arm 2 left no row (#753)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        positions: observations.positions.filter((position) => position.arm !== 'control'),
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes("`arm = 'control'`"))).toBe(true);
  });

  it('fails when a control lot shares an idempotency key with a live lot (#753)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        positions: observations.positions.map((position) =>
          position.arm === 'control' ? { ...position, idempotency_key: 'idem-1' } : position,
        ),
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) => failure.includes('share an idempotency key with a live lot')),
    ).toBe(true);
  });

  it('fails when a debate ran but no debate_log row was written (#364)', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), debates: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
  });

  it('fails when a debate_log row has no termination classification (#1081)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        debates: observations.debates.map((debate) => ({ ...debate, termination: null })),
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('NULL termination'))).toBe(true);
  });

  it('does not demand termination from a run that never debated — that fails as #364 instead', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), debates: [] },
      healthyGateOptions(),
    );

    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('NULL termination'))).toBe(false);
  });

  it('fails when debates resolved but the rate limiter metered no LLM call (#388)', () => {
    const gate = evaluateSmokeGate(transactedObservations(), {
      ...healthyGateOptions(),
      llmRateLimiterSnapshot: { crypto: { debatesUsed: 3, llmCallsUsed: 0 } },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('#388 defect'))).toBe(true);
  });

  it('fails when the limiter admitted no debate at all, not just no call (#388)', () => {
    const gate = evaluateSmokeGate(transactedObservations(), {
      ...healthyGateOptions(),
      llmRateLimiterSnapshot: {},
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('#388 defect'))).toBe(true);
  });

  it('fails when a crypto debate ran more rounds than the crypto cap (#581)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        debates: observations.debates.map((debate) => ({ ...debate, rounds: 2 })),
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes("asset class's cap"))).toBe(true);
  });

  it('fails when a class meters more LLM calls than its per-debate worst case (#581)', () => {
    const gate = evaluateSmokeGate(transactedObservations(), {
      ...healthyGateOptions(),
      llmRateLimiterSnapshot: { crypto: { debatesUsed: 1, llmCallsUsed: 5 } },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('under-reserving'))).toBe(true);
  });

  it('does not demand metering from a run that never debated — that fails as #364 instead', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), debates: [] },
      { ...healthyGateOptions(), llmRateLimiterSnapshot: {} },
    );

    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('#388 defect'))).toBe(false);
  });

  it('fails when the LIVE risk_thresholds read accepted an out-of-bound value', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ liveReadAccepted: ['max_drawdown_pct'] }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('LIVE risk_thresholds read'))).toBe(
      true,
    );
  });

  it('fails when the Feedback Loop write door accepted an out-of-bound value', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ writeDoorAccepted: ['max_pbo'] }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('write door accepted'))).toBe(true);
  });

  it('fails when the breaker constructor accepted a drawdown pair that can never fire', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ breakerConstructionRefused: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('0.95/0.90'))).toBe(true);
  });

  it('fails when the kill-line boot check accepted a softened PBO threshold', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ killLineCheckRefused: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('PBO threshold of 0.5'))).toBe(true);
  });

  it('fails when a guarded threshold was never probed — an unseen limit is not enforced', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({
          probedNames: GUARDED_THRESHOLD_NAMES.filter((name) => name !== 'max_pbo'),
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('guarded thresholds'))).toBe(true);
  });

  it('fails when the clamp refuses the SHIPPED configuration — the bound is wrong, not the config', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ shippedConfigAccepted: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('shipped paper breaker'))).toBe(true);
  });

  it('fails when a tripped live-read clamp does not leave the exit path bypassing it', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        thresholdClamp: healthyThresholdClamp({ exitBypassesLiveClamp: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('exit intent did not reach'))).toBe(
      true,
    );
  });

  it('fails when the approvals fallback answers instead of refusing', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        approvalFallback: healthyApprovalFallback({
          refusedFabricatedConsent: false,
          message: null,
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('did NOT refuse'))).toBe(true);
  });

  it('fails when the approvals fallback throws the wrong error', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        approvalFallback: healthyApprovalFallback({ message: 'ECONNRESET' }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('not with the expected refusal'))).toBe(
      true,
    );
  });

  it('fails when a dead stdout pipe stopped the run instead of degrading it', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({
          stdoutRetired: false,
          linesAfterStdoutDeath: 0,
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('dead stdout pipe'))).toBe(true);
  });

  it('fails when the stdout failure was swallowed without a durable record', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({ degradationRecordedInFile: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('continue blind'))).toBe(true);
  });

  it('fails when a logger with nowhere left to record kept going anyway', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({ escalatedWhenNothingCouldRecord: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('swallowed its failure'))).toBe(true);
  });

  it('fails when the no-sink escalation left no trace on stderr', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({ lastResortTraceOnStderr: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('wrote nothing to stderr'))).toBe(true);
  });

  it('fails when an unhandled fault was shrugged off rather than recorded and exited', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({ fatalExitCode: 0 }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('unknown state'))).toBe(true);
  });

  it('fails when the retention sweep did not remove a stale file', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ staleFileRemoved: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('did not remove a file'))).toBe(true);
  });

  it('fails when the retention sweep removed a fresh file', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ freshFileKept: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) => failure.includes('removed a file inside its retention')),
    ).toBe(true);
  });

  it('fails when the retention sweep removed a protected path despite its age', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ protectedFileKeptDespiteAge: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('passed as protected'))).toBe(true);
  });

  it('fails when the retention sweep removed an undated bare name despite its age', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ liveShapedFileKeptDespiteAge: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('undated bare name'))).toBe(true);
  });

  it('fails when the retention sweep removed a non-log file', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ nonLogFileKeptDespiteAge: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('removed a non-log file'))).toBe(true);
  });

  it('fails when the retention sweep leaves an oversized soak-boot.out untouched by default', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ oversizedSoakBootTruncatedByDefault: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) => failure.includes('oversized soak-boot.out untouched')),
    ).toBe(true);
  });

  it('fails when the retention sweep removed a file but reclaimed no bytes', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        logRetention: healthyLogRetention({ bytesReclaimed: 0 }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('0 bytes reclaimed'))).toBe(true);
  });

  it('fails when an entrypoint stdout fault was not reported on stderr', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        entrypointFaultGuards: healthyEntrypointFaultGuards([{}, { faultReportedOnStderr: false }]),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some(
        (failure) => failure.includes('supervisor') && failure.includes('not reported on stderr'),
      ),
    ).toBe(true);
  });

  it('fails when an entrypoint fault handler did not continue the process', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        entrypointFaultGuards: healthyEntrypointFaultGuards([{ continuesOnArbitraryFault: false }]),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some(
        (failure) => failure.includes('service-api') && failure.includes('did not continue'),
      ),
    ).toBe(true);
  });

  it('fails when no GO verdict was recorded, naming the no-go reasons seen', () => {
    const gate = evaluateSmokeGate(
      {
        ...transactedObservations(),
        verdicts: [
          {
            trace_id: 'trace-1',
            instrument: 'BTC-USD',
            status: 'no_go',
            no_go_reason: 'stale_signal',
            no_go_detail_measured_ms: null,
            no_go_detail_bound_ms: null,
          },
        ],
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no_go:stale_signal'))).toBe(true);
  });

  it('fails when a staleness no-go recorded no measurement (#1111)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        verdicts: [
          ...observations.verdicts,
          {
            trace_id: 'trace-2',
            instrument: 'BTC-USD',
            status: 'no_go',
            no_go_reason: 'stale_feed',
            no_go_detail_measured_ms: null,
            no_go_detail_bound_ms: null,
          },
        ],
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) => failure.includes('without recording what was measured')),
    ).toBe(true);
  });

  it('passes a staleness no-go that recorded its measurement (#1111)', () => {
    const observations = transactedObservations();
    const gate = evaluateSmokeGate(
      {
        ...observations,
        verdicts: [
          ...observations.verdicts,
          {
            trace_id: 'trace-2',
            instrument: 'BTC-USD',
            status: 'no_go',
            no_go_reason: 'stale_feed',
            no_go_detail_measured_ms: 1_200_000,
            no_go_detail_bound_ms: 900_000,
          },
        ],
      },
      healthyGateOptions(),
    );

    expect(
      gate.failures.some((failure) => failure.includes('without recording what was measured')),
    ).toBe(false);
  });

  it('fails when a GO was recorded but Execution never reported submitted', () => {
    const observations = transactedObservations();
    const firstTick = observations.ticks[0];
    if (firstTick === undefined) throw new Error('fixture regression: no first tick');
    firstTick.stages = firstTick.stages.filter((entry) => entry.stage !== 'execution');

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('reached Execution'))).toBe(true);
  });

  it('fails when nothing was written ahead to open_positions', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), positions: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('open_positions'))).toBe(true);
  });

  it('fails when the order was submitted but no fill was ever ingested', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), fills: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('ingestFills'))).toBe(true);
  });

  it('fails when anything reached the Alpaca wire client, even if everything else transacted', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({ alpacaWireClientReached: true }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toHaveLength(1);
    expect(gate.failures[0]).toContain('Alpaca wire client was reached');
  });

  it('ignores a non-entry fill when deciding whether the lot ever filled', () => {
    const gate = evaluateSmokeGate(
      {
        ...transactedObservations(),
        fills: [{ idempotency_key: 'idem-1', leg: 'stop', price: 150, qty: 1, fee: 0 }],
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
  });
});

describe('evaluateSmokeGate — fill-sync contained failures (#1049)', () => {
  const containedFailure = (key: string): FillSyncFailure => ({
    message: 'fill poll failed',
    error:
      `ingestFills: 1 contained failure(s) — every other lot in this poll was advanced; ` +
      `unresolved: lot-advance '${key}'`,
  });

  it('fails when the fill-sync poll rejected — every ingestFills call was a contained failure', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        fillSync: healthyFillSync({
          failures: [
            containedFailure('lot-a'),
            containedFailure('lot-a'),
            containedFailure('lot-b'),
          ],
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([expect.stringContaining('3 fill-sync poll failure(s)')]);
    expect(gate.failures[0]).toContain("lot-advance 'lot-a'");
    expect(gate.failures[0]).toContain('#1049');
  });

  it('fails on a periodic reconcile failure the same way — the first catch in the same poll', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        fillSync: healthyFillSync({
          failures: [{ message: 'periodic reconcile failed', error: 'SQLITE_BUSY' }],
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([expect.stringContaining('periodic reconcile failed')]);
  });

  it('fails on a residual-protection sweep failure the same way — same poll loop, same silence', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        fillSync: healthyFillSync({
          failures: [{ message: 'residual-protection sweep failed', error: 'SQLITE_BUSY' }],
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([expect.stringContaining('residual-protection sweep failed')]);
  });

  it('passes when the poll loop never rejected', () => {
    const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

    expect(gate.failures).toEqual([]);
  });

  describe('the tolerated allowlist', () => {
    const failures: FillSyncFailure[] = [
      containedFailure('lot-scripted'),
      containedFailure('lot-real'),
    ];

    it('is empty — a healthy run has no poll rejection to tolerate', () => {
      expect(untoleratedFillSyncFailures(failures)).toEqual(failures);
    });

    it('suppresses a failure by error substring and leaves every other one', () => {
      expect(untoleratedFillSyncFailures(failures, ["lot-advance 'lot-scripted'"])).toEqual([
        containedFailure('lot-real'),
      ]);
    });

    it('ignores an empty entry rather than letting it tolerate everything', () => {
      expect(untoleratedFillSyncFailures(failures, [''])).toEqual(failures);
    });
  });
});

describe('evaluateSmokeGate — market-data fetch telemetry (#1082)', () => {
  it('fails when zero market_data_fetch lines were recorded', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({ marketDataFetch: healthyMarketDataFetch({ fetchCount: 0 }) }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([expect.stringContaining('zero market_data_fetch lines')]);
    expect(gate.failures[0]).toContain('#1082');
  });

  it('passes when at least one market_data_fetch line was recorded', () => {
    const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('fails when every fetch fell back to the category label instead of a tick trace', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        marketDataFetch: healthyMarketDataFetch({ traceIds: ['market-data'] }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([
      expect.stringContaining('no market_data_fetch line carried a tick trace_id'),
    ]);
  });

  it('passes when one fetch joins, even though others ran outside a tick', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        marketDataFetch: healthyMarketDataFetch({ traceIds: ['market-data', 'trace-1'] }),
      }),
    );

    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('does not fire the join check when nothing fetched — the count check owns that', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        marketDataFetch: healthyMarketDataFetch({ fetchCount: 0, traceIds: [] }),
      }),
    );

    expect(gate.failures).toEqual([expect.stringContaining('zero market_data_fetch lines')]);
  });
});

describe('MarketDataFetchRecorder (#1082)', () => {
  it('counts only lines carrying the market_data_fetch event and forwards every line unconditionally', () => {
    const forwarded: unknown[] = [];
    const recorder = new MarketDataFetchRecorder({
      log: (entry) => forwarded.push(entry.message),
    });

    recorder.log({
      trace_id: 't1',
      stage: 'market_data',
      event: 'market_data_fetch',
      level: 'info',
      message: 'market_data_fetch: AAPL 1h fetched 2 row(s) in 5ms.',
    });
    recorder.log({
      trace_id: 't2',
      stage: 'debate',
      event: 'debate_something_else',
      level: 'info',
      message: 'unrelated line',
    });
    recorder.log({
      trace_id: 't3',
      stage: 'market_data',
      level: 'info',
      message: 'no event at all',
    });

    expect(recorder.evidence()).toEqual({ fetchCount: 1, traceIds: ['t1'] });
    expect(forwarded).toEqual([
      'market_data_fetch: AAPL 1h fetched 2 row(s) in 5ms.',
      'unrelated line',
      'no event at all',
    ]);
  });
});

describe('FillSyncFailureRecorder (#1049)', () => {
  const entry = (level: 'info' | 'warn' | 'error', message: string, error?: string) => ({
    trace_id: 'fill-sync',
    stage: 'execution',
    event: 'fill_sync_line',
    level,
    message,
    ...(error === undefined ? {} : { payload: { error } }),
  });

  it("records only the fill-sync loop's error-level rejections, and forwards every line", () => {
    const forwarded: string[] = [];
    const recorder = new FillSyncFailureRecorder({ log: (line) => forwarded.push(line.message) });

    recorder.log(entry('error', 'periodic reconcile failed', 'reconcile boom'));
    recorder.log(entry('error', 'fill poll failed', 'ingestFills: 1 contained failure(s)'));
    recorder.log(entry('error', 'residual-protection sweep failed', 'boom'));
    recorder.log(entry('warn', 'fill poll skipped: previous poll still running'));
    recorder.log(entry('error', 'tick failed', 'unrelated'));
    recorder.log(entry('info', 'fill poll failed'));

    expect(recorder.evidence()).toEqual({
      failures: [
        { message: 'periodic reconcile failed', error: 'reconcile boom' },
        { message: 'fill poll failed', error: 'ingestFills: 1 contained failure(s)' },
        { message: 'residual-protection sweep failed', error: 'boom' },
      ],
    });
    expect(forwarded).toHaveLength(6);
  });

  it('records a rejection whose payload carries no error string, rather than dropping it', () => {
    const recorder = new FillSyncFailureRecorder({ log: () => undefined });

    recorder.log(entry('error', 'fill poll failed'));

    expect(recorder.evidence().failures).toEqual([{ message: 'fill poll failed', error: '' }]);
  });
});

describe('formatSmokeReport', () => {
  it('states the reached stages, the verdict, the lot and the fill', () => {
    const observations = transactedObservations();
    const evidence = healthyGateOptions();
    const report = formatSmokeReport(
      observations,
      evidence,
      evaluateSmokeGate(observations, evidence),
    ).join('\n');

    expect(report).toContain(
      'analysts:quorum_met -> debate:bullish -> trader:entry -> risk:approved -> ' +
        'verdict:go -> execution:submitted',
    );
    expect(report).toContain('BTC-USD go');
    expect(report).toContain('BTC-USD buy requested=31.25');
    expect(report).toContain('entry qty=31.25');
    expect(report).toContain('GATE: PASS');
    expect(report).toContain('closed trades: 1');
    expect(report).toContain('flatten submissions journalled: 1');
  });

  it('lists every unmet requirement on a failure', () => {
    const observations: SmokeObservations = {
      ticks: [],
      debates: [],
      verdicts: [],
      positions: [],
      fills: [],
      closedTrades: [],
      flattenSubmissions: [],
      gdeltRowsArchived: SMOKE_GDELT_EXPECTED_ROWS,
      gdeltAggregateItems: SMOKE_GDELT_EXPECTED_AGGREGATES,
      polymarketRowsArchived: 1,
      polymarketItemsArchived: 1,
      polymarketIntelItems: 1,

      cosineSetups: [],
      riskThresholds: [],
      analystWeights: [],
      traderDecisions: [],
      breakerStates: BOTH_TIERS,
      riskDecisions: [],
    };
    const evidence = healthyGateOptions({ minTicks: 3 });
    const report = formatSmokeReport(
      observations,
      evidence,
      evaluateSmokeGate(observations, evidence),
    ).join('\n');

    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('no tick got past Analysts');
  });
});

describe('buildSmokeFixtureBars', () => {
  const bars = buildSmokeFixtureBars();
  const countFor = (timeframe: string) => bars.filter((bar) => bar.timeframe === timeframe).length;

  it('supplies more bars than every lookback the paper profile reads', () => {
    expect(countFor('5m')).toBeGreaterThanOrEqual(RSI_SPEC.lookback);
    expect(countFor('1h')).toBeGreaterThanOrEqual(15);
    expect(countFor('1m')).toBeGreaterThanOrEqual(15);
    expect(countFor('1d')).toBeGreaterThanOrEqual(30);
  });

  it('anchors every bar strictly before the frozen run instant', () => {
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.close_time.getTime()).toBeLessThan(SMOKE_RUN_INSTANT.getTime());
      expect(bar.open_time.getTime()).toBeLessThan(bar.close_time.getTime());
    }
  });

  it('trends upward, so the analysts agree and conviction clears the floor', () => {
    const fiveMinute = bars
      .filter((bar) => bar.timeframe === '5m')
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());
    const first = fiveMinute[0];
    const last = fiveMinute[fiveMinute.length - 1];
    if (first === undefined || last === undefined) throw new Error('no 5m fixture bars');

    expect(last.close).toBeGreaterThan(first.close);
    expect(last.high - last.low).toBeGreaterThan(0);

    expect(fiveMinute.length).toBeGreaterThanOrEqual(RSI_SPEC.lookback);
    const sma = computeIndicator(fiveMinute.slice(-SMA_SPEC.lookback), SMA_SPEC);
    const rsi = computeIndicator(fiveMinute.slice(-RSI_SPEC.lookback), RSI_SPEC);

    expect(last.close).toBeGreaterThan(sma);
    expect(rsi).toBeLessThan(70);
    expect(rsi).toBeGreaterThan(50);
  });
});

describe('ConstantResponseLlmClient', () => {
  it('answers the same text forever, unlike the queue-based MockLlmClient', async () => {
    const client = new ConstantResponseLlmClient();
    const request = {
      prompt: 'p',
      context: { analyst_views: [] },
      parseResponse: (rawText: string) => ({ valid: true as const, data: JSON.parse(rawText) }),
    };

    for (let call = 0; call < 50; call += 1) {
      const response = await client.complete(request);
      expect(response.raw_text).toBe(SMOKE_LLM_RESPONSE);
    }
    expect(client.calls).toBe(50);
  });

  it('is bullish and converged, so a GO is reachable and the debate ends in one round', () => {
    const payload = JSON.parse(SMOKE_LLM_RESPONSE) as { stance: string; converged: boolean };

    expect(payload.stance).toBe('bullish');
    expect(payload.converged).toBe(true);
  });

  it('fails loudly if the fixture payload stops satisfying a call site parser', async () => {
    const client = new ConstantResponseLlmClient();

    await expect(
      client.complete({
        prompt: 'p',
        context: { analyst_views: [] },
        parseResponse: () => ({ valid: false as const, reason: 'schema drifted' }),
      }),
    ).rejects.toThrow('schema drifted');
  });
});

describe('UnreachableAlpacaClient', () => {
  it('refuses every method rather than pretending to answer', async () => {
    const client = new UnreachableAlpacaClient();

    await expect(client.submitOrder()).rejects.toThrow('must make no network call');
    await expect(client.getOrder()).rejects.toThrow('UnreachableAlpacaClient.getOrder');
    await expect(client.getOrderByClientOrderId()).rejects.toThrow('credential-free');
    await expect(client.getAccount()).rejects.toThrow('UnreachableAlpacaClient.getAccount');
    expect(client.reached).toBe(true);
  });
});

describe('FixedAccountStateProvider', () => {
  it('reports a healthy account, so no breaker halts the run for the wrong reason', async () => {
    const state = await new FixedAccountStateProvider().getAccountState();

    expect(state).toEqual({
      cash: 100_000,
      peak_equity: 100_000,
      daily_basis: {
        crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
        stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
        portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
      },
      consecutive_losses: 0,
    });
  });
});

describe('smoke-mode containment (#293/#320/#324)', () => {
  it('keeps every smoke symbol off the orchestrator barrel', async () => {
    const barrel = await import('./index.js');
    const exported = Object.keys(barrel);

    for (const symbol of [
      'runSmoke',
      'evaluateSmokeGate',
      'buildSmokeFixtureBars',
      'ConstantResponseLlmClient',
      'FixedAccountStateProvider',
      'UnreachableAlpacaClient',
      'SMOKE_RUN_INSTANT',
      'ExitPathBrokerAdapter',
      'RecordingResidualExposureAlertChannel',
    ]) {
      expect(exported).not.toContain(symbol);
    }
  });
});

describe('runSmoke (end-to-end, real composition root)', () => {
  it('drives one instrument through all six stages and ingests the fill', {
    timeout: 30_000,
  }, async () => {
    const result = await runSmoke({
      ticks: 1,
      tickIntervalMs: 50,
      fillPollIntervalMs: 25,
      deadlineMs: 20_000,
      logger: { log: () => undefined },
    });

    expect(result.gate.failures).toEqual([]);
    expect(result.gate.passed).toBe(true);

    const transacting = result.observations.ticks.find((tick) =>
      tick.stages.some((entry) => entry.stage === 'execution'),
    );
    expect(transacting?.stages.map((entry) => entry.stage)).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);

    expect(result.observations.verdicts.map((verdict) => verdict.status)).toContain('go');
    const sixStageLots = result.observations.positions.filter(
      (position) => position.instrument === 'BTC-USD' && position.arm === 'live',
    );
    expect(sixStageLots).toHaveLength(1);
    const controlLots = result.observations.positions.filter(
      (position) => position.instrument === 'BTC-USD' && position.arm === 'control',
    );
    expect(controlLots).toHaveLength(1);
    expect(controlLots[0]?.idempotency_key).not.toEqual(sixStageLots[0]?.idempotency_key);
    expect(result.observations.fills.some((fill) => fill.leg === 'entry')).toBe(true);
    expect(sixStageLots[0]?.order_state).toBe('filled');
    expect(sixStageLots[0]?.filled_size).toBeGreaterThan(0);

    expect(result.observations.closedTrades).toHaveLength(4);
    expect(result.observations.flattenSubmissions).toHaveLength(6);
    expect(result.observations.flattenSubmissions.every((row) => row.status === 'submitted')).toBe(
      true,
    );
  });

  it('fails the gate through the real run when every ingestFills poll rejects (#1049)', {
    timeout: 30_000,
  }, async () => {
    const owned = STAGE_OWNED_TABLES.execution;
    STAGE_OWNED_TABLES.execution = owned.filter((table) => table !== 'fills');
    try {
      const result = await runSmoke({
        ticks: 1,
        tickIntervalMs: 50,
        fillPollIntervalMs: 25,
        deadlineMs: 20_000,
        logger: { log: () => undefined },
      });

      expect(result.gate.passed).toBe(false);
      expect(result.gate.failures).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\d+ fill-sync poll failure\(s\) were logged and survived/),
        ]),
      );
      expect(result.gate.failures.join('\n')).toContain('fill poll failed: ingestFills:');
    } finally {
      STAGE_OWNED_TABLES.execution = owned;
    }
  });

  it('is deterministic across runs', { timeout: 40_000 }, async () => {
    const options = {
      ticks: 1,
      tickIntervalMs: 50,
      fillPollIntervalMs: 25,
      deadlineMs: 15_000,
      logger: { log: () => undefined },
    };
    const first = await runSmoke(options);
    const second = await runSmoke(options);

    expect(second.observations.positions).toEqual(first.observations.positions);
    expect(second.observations.fills).toEqual(first.observations.fills);
    expect(second.observations.verdicts.map((verdict) => verdict.status)).toEqual(
      first.observations.verdicts.map((verdict) => verdict.status),
    );
    expect(second.observations.closedTrades).toEqual(first.observations.closedTrades);
    expect(second.observations.flattenSubmissions).toEqual(first.observations.flattenSubmissions);
  });

  it('goes red on the quorum-skip run the real binary produces today', () => {
    const observations: SmokeObservations = {
      ticks: [{ trace_id: 't', stages: [{ stage: 'analysts', decision: 'quorum_skip' }] }],
      debates: [],
      verdicts: [],
      positions: [],
      fills: [],
      closedTrades: [],
      flattenSubmissions: [],
      gdeltRowsArchived: SMOKE_GDELT_EXPECTED_ROWS,
      gdeltAggregateItems: SMOKE_GDELT_EXPECTED_AGGREGATES,
      polymarketRowsArchived: 1,
      polymarketItemsArchived: 1,
      polymarketIntelItems: 1,

      cosineSetups: [],
      riskThresholds: [],
      analystWeights: [],
      traderDecisions: [],
      breakerStates: BOTH_TIERS,
      riskDecisions: [],
    };

    const gate = evaluateSmokeGate(
      observations,
      healthyGateOptions({
        minTicks: 1,
        marketDataFetch: healthyMarketDataFetch({ traceIds: ['t'] }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toHaveLength(12);
    expect(gate.failures.some((failure) => failure.includes('no tick got past Analysts'))).toBe(
      true,
    );
    expect(gate.failures.some((failure) => failure.includes('no GO verdict'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('reached Execution'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('open_positions'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('ingestFills'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('#508/#517'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('no row in closed_trades'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('no row in flatten_submissions'))).toBe(
      true,
    );
    expect(
      gate.failures.some((failure) => failure.includes("scenario 4's crash-restart flatten")),
    ).toBe(true);
  });
});

describe('evaluateSmokeGate — one assertion per wired mechanism (#430)', () => {
  function gateFor(observations: SmokeObservations) {
    return evaluateSmokeGate(observations, healthyGateOptions());
  }

  it('fails when a debate reached the Trader but no cosine setup was written (#432)', () => {
    const gate = gateFor({ ...transactedObservations(), cosineSetups: [] });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('cosine_setups'))).toBe(true);
  });

  it('does not demand a setup from a run that never debated — that fails as #364 instead', () => {
    const gate = gateFor({ ...transactedObservations(), debates: [], cosineSetups: [] });

    expect(gate.failures.some((failure) => failure.includes('cosine_setups'))).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('debate_log'))).toBe(true);
  });

  it('fails when the risk thresholds were never seeded (#433)', () => {
    const gate = gateFor({ ...transactedObservations(), riskThresholds: [] });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('risk_thresholds'))).toBe(true);
  });

  it('fails when the analyst weights were never seeded (#371)', () => {
    const gate = gateFor({ ...transactedObservations(), analystWeights: [] });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('analyst_weights'))).toBe(true);
  });

  it('fails when the sticky breaker state was never persisted (review 2026-08-06 B1)', () => {
    const gate = gateFor({ ...transactedObservations(), breakerStates: [] });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('breaker_state'))).toBe(true);
  });

  it('fails when only one sticky tier reached breaker_state', () => {
    const gate = gateFor({
      ...transactedObservations(),
      breakerStates: [{ tier: 'portfolio_drawdown', tripped: 0 }],
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('breaker_state'))).toBe(true);
  });

  it('passes only when every mechanism left its own evidence', () => {
    expect(gateFor(transactedObservations()).passed).toBe(true);
  });
});

describe('evaluateSmokeGate — exit path (#576)', () => {
  function gateFor(exitPath: Partial<ExitPathEvidence>) {
    return evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        exitPath: healthyExitPath(exitPath),
      }),
    );
  }

  it('fails when no flatten was ever journalled (#508)', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), flattenSubmissions: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no row in flatten_submissions'))).toBe(
      true,
    );
  });

  it("fails when scenario 1's own lot never closed, even though other lots did (#508/#517)", () => {
    const observations = {
      ...transactedObservations(),
      positions: transactedObservations().positions.map((position) =>
        position.idempotency_key === 'idem-exit-1'
          ? { ...position, order_state: 'partially_filled' }
          : position,
      ),
    };

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('idem-exit-1'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('#508/#517'))).toBe(true);
  });

  it("fails when a flatten_submissions row never resolved to 'submitted'", () => {
    const gate = evaluateSmokeGate(
      {
        ...transactedObservations(),
        flattenSubmissions: [
          { idempotency_key: 'idem-exit-1', instrument: 'BTC-USD', status: 'error' },
        ],
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes("not resolved to 'submitted'"))).toBe(
      true,
    );
  });

  it('fails when a submitFlatten call has no cancel call recorded before it (#516)', () => {
    const gate = gateFor({
      brokerCallSequence: ['submitFlatten:lot-1-exit', 'cancel:lot-1'],
    });

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) =>
        failure.includes("have no 'cancel' call recorded before them"),
      ),
    ).toBe(true);
  });

  it('fails when no submitFlatten call was ever recorded (#508)', () => {
    const gate = gateFor({ brokerCallSequence: [] });

    expect(gate.passed).toBe(false);
    expect(
      gate.failures.some((failure) => failure.includes('recorded no submitFlatten call')),
    ).toBe(true);
  });

  it('fails when a partial flatten left no protective legs armed (#525)', () => {
    const gate = gateFor({
      partialFlatten: { idempotencyKey: 'lot-2', expectedResidual: 6, protectedQty: null },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no protective legs armed'))).toBe(
      true,
    );
  });

  it('fails when the re-arm protected the wrong quantity (#525)', () => {
    const gate = gateFor({
      partialFlatten: { idempotencyKey: 'lot-2', expectedResidual: 6, protectedQty: 4 },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('sized the wrong quantity'))).toBe(
      true,
    );
  });

  it('fails when a residual-exposure alert fired — a successful re-arm posts nothing (#525)', () => {
    const gate = gateFor({
      residualAlerts: [
        {
          trace_id: 'fill-sync',
          idempotency_key: 'lot-2',
          instrument: 'SOL-USD',
          side: 'buy',
          residual_qty: 6,
          residual_qty_is_upper_bound: false,
          rearm_unsupported: false,
          stop: 90,
          target: 120,
          observed_at: SMOKE_RUN_INSTANT,
        },
      ],
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('re-arm failed'))).toBe(true);
  });

  describe('the residual-protection sweep (#549)', () => {
    it("fails when the restarted reconcile() named no divergence for scenario 5's lot — the marker or the sweep is unwired", () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: 6,
          markerCleared: true,
          sweepDivergenceAction: undefined,
          sweepDivergenceReason: undefined,
        },
      });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) => failure.includes('never written by the observing poll')),
      ).toBe(true);
    });

    it('fails when the sweep retry could not settle the marker (undetermined)', () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: null,
          markerCleared: false,
          sweepDivergenceAction: 'undetermined',
          sweepDivergenceReason: 're-arm retry failed for residual 6: connection reset',
        },
      });

      expect(gate.passed).toBe(false);
      expect(gate.failures.some((failure) => failure.includes("not 'adopted'"))).toBe(true);
    });

    it('fails when the marker survived the restarted sweep — protection was never confirmed', () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: 6,
          markerCleared: false,
          sweepDivergenceAction: 'adopted',
          sweepDivergenceReason:
            'protective legs re-armed for residual 6 by the #549 sweep — ' +
            'residual-protection marker cleared',
        },
      });

      expect(gate.passed).toBe(false);
      expect(gate.failures.some((failure) => failure.includes('is still set'))).toBe(true);
    });

    it("fails when the sweep's retry left the lot naked or mis-sized", () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: null,
          markerCleared: true,
          sweepDivergenceAction: 'adopted',
          sweepDivergenceReason:
            'protective legs re-armed for residual 6 by the #549 sweep — ' +
            'residual-protection marker cleared',
        },
      });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) =>
          failure.includes('either never re-armed (the lot is naked) or sized the wrong quantity'),
        ),
      ).toBe(true);
    });

    it("fails when an 'adopted' divergence's reason does not name the #549 sweep — a wrong-key lookup found a different scenario's divergence (#1285 B2)", () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: 6,
          markerCleared: true,
          sweepDivergenceAction: 'adopted',
          sweepDivergenceReason: "flatten journal said 'submitted'; broker reports 'filled'",
        },
      });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) => failure.includes('does not name the #549 sweep')),
      ).toBe(true);
    });

    it("fails when an 'adopted' divergence names the #549 sweep but for a DIFFERENT residual — a wrong-key lookup landing on another lot's real re-arm (#1285 N3)", () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: 6,
          markerCleared: true,
          sweepDivergenceAction: 'adopted',
          sweepDivergenceReason:
            'protective legs re-armed for residual 99 by the #549 sweep — ' +
            'residual-protection marker cleared',
        },
      });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) => failure.includes('does not name the #549 sweep')),
      ).toBe(true);
    });

    it('fails when the episode paged more than once — the once-per-episode dedup regressed (#342)', () => {
      const [healthyAlert] = healthyExitPath().residualAlerts;
      if (healthyAlert === undefined) throw new Error('fixture invariant: one healthy alert');
      const gate = gateFor({
        residualAlerts: [healthyAlert, { ...healthyAlert, observed_at: SMOKE_RUN_INSTANT }],
      });

      expect(gate.passed).toBe(false);
      expect(gate.failures.some((failure) => failure.includes('once-per-episode dedup'))).toBe(
        true,
      );
    });

    it('fails when the deliberately-failed re-arm no longer pages at all', () => {
      const gate = gateFor({ residualAlerts: [] });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) =>
          failure.includes('0 means the failed re-arm no longer pages'),
        ),
      ).toBe(true);
    });
  });

  describe('the terminal-row sweep (#1088)', () => {
    it('fails when the seeded terminal row survives the restarted reconcile()', () => {
      const gate = gateFor({
        terminalSweep: {
          seededKey: 'smoke-terminal-sweep-target',
          rowPresentAfterSweep: true,
          swept: 0,
        },
      });

      expect(gate.passed).toBe(false);
      expect(gate.failures.some((failure) => failure.includes('STILL present'))).toBe(true);
    });

    it('passes when the seeded row is gone, whatever else the pass swept', () => {
      const gate = gateFor({
        terminalSweep: {
          seededKey: 'smoke-terminal-sweep-target',
          rowPresentAfterSweep: false,
          swept: 3,
        },
      });

      expect(gate.passed).toBe(true);
    });
  });

  it('fails when a lot named by a two-lot flatten is left phantom-open (#571)', () => {
    const observations = {
      ...transactedObservations(),
      positions: [
        {
          idempotency_key: 'lot-control',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'closed',
          arm: 'control' as const,
        },
        {
          idempotency_key: 'lot-older',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'closed',
          arm: 'live' as const,
        },
        {
          idempotency_key: 'lot-newer',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'partially_filled',
          arm: 'live' as const,
        },
      ],
    };
    const gate = evaluateSmokeGate(
      observations,
      healthyGateOptions({
        exitPath: healthyExitPath({ twoLotFlatten: { lotKeys: ['lot-older', 'lot-newer'] } }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('lot-newer'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('lot-older'))).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('#571'))).toBe(true);
  });

  it('does not phantom-open when both named lots reached closed', () => {
    const observations = {
      ...transactedObservations(),
      positions: [
        {
          idempotency_key: 'lot-control',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'closed',
          arm: 'control' as const,
        },
        {
          idempotency_key: 'lot-older',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'closed',
          arm: 'live' as const,
        },
        {
          idempotency_key: 'lot-newer',
          instrument: 'AVAX-USD',
          side: 'buy',
          requested_size: 10,
          filled_size: 10,
          avg_entry_price: 160,
          order_state: 'closed',
          arm: 'live' as const,
        },
      ],
    };
    const gate = evaluateSmokeGate(
      observations,
      healthyGateOptions({
        exitPath: healthyExitPath({ twoLotFlatten: { lotKeys: ['lot-older', 'lot-newer'] } }),
      }),
    );

    expect(gate.failures.some((failure) => failure.includes('lot-older, lot-newer'))).toBe(false);
  });

  describe('the OHLCV failover (#562)', () => {
    it('fails when the composition root read threw instead of failing over', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          dataFailover: healthyDataFailover({
            readError: 'alpaca 503 (smoke failover probe)',
            storedSources: [],
            storedOpenTimes: [],
            alerts: [],
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('threw instead of failing over');
    });

    it('fails when an out-of-session fallback bar reached the store', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          dataFailover: healthyDataFailover({
            storedSources: ['polygon', 'polygon', 'polygon'],
            storedOpenTimes: ['2026-08-03T09:00:00.000Z', ...FAILOVER_IN_SESSION_OPEN_TIMES],
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('session-normalized set');
    });

    it('fails when the fallback served bars but alerted nobody', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ dataFailover: healthyDataFailover({ alerts: [] }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('DataFailoverAlertChannel');
    });

    it('passes when the root failed over, normalized and alerted', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#562'))).toEqual([]);
    });
  });

  describe('createDataSource reached from the composition root (#1151)', () => {
    it('fails when a factory-resolved source refused to build or read', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          dataSourceFactory: healthyDataSourceFactory({
            alpacaStoredSources: [],
            error: 'Unknown data source kind: {"kind":"alpaca"}',
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('refused to build or read');
    });

    it('fails when the Alpaca arm persisted nothing', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          dataSourceFactory: healthyDataSourceFactory({ alpacaStoredSources: [] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('the Alpaca arm persisted');
    });

    it('fails when the LSE arm persisted another vendor, so the mark path is not the one kept', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          dataSourceFactory: healthyDataSourceFactory({ lseStoredSources: ['alpaca'] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('the LSE arm persisted');
    });

    it('passes when both surviving arms served and persisted through the root', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#1151'))).toEqual([]);
    });
  });

  describe('the arm-comparison surface (#971)', () => {
    it('fails when the cycle produced no comparison at all', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ armComparison: healthyArmComparison({ live: null, control: null }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('produced no comparison');
    });

    it('fails when nothing was persisted for the dashboard panel to read', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ armComparison: healthyArmComparison({ persistedRows: 0 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('arm_comparison_samples');
    });

    it('fails when a persisted arm came back without its drawdown', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          armComparison: healthyArmComparison({ persistedBothDrawdowns: false }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('return-only view');
    });

    it('fails when a divergence verdict reached nobody', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          armComparison: healthyArmComparison({ diverged: true, alerts: 0 }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('come apart');
    });

    it('fails when an alert fired on a comparison that did not diverge', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ armComparison: healthyArmComparison({ alerts: 1 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('come apart');
    });

    it('passes on a computed, persisted, non-diverged comparison', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('arm-comparison'))).toEqual([]);
    });

    it('fails when the basis and the run’s sizing ceiling are different numbers (#1112 AC3)', () => {
      const healthy = healthyArmComparison();
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          armComparison: healthyArmComparison({
            comparison: {
              ...healthy.comparison,
              basis: LIVE_BOOK_GBP,
            },
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('divided both arms by');
    });

    it('drives the shipped cycle at the converted sizing ceiling (#1180)', () => {
      const db = openSharedStore(':memory:');
      try {
        expect(runArmComparisonProbe(db).comparison.basis).toBe(LIVE_BOOK_SIZING_USD);
      } finally {
        db.close();
      }
    });
  });

  describe('the daily feedback cycle schedule (#1110)', () => {
    it('fails when the composition root never wrote a schedule row', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ feedbackCycleScheduleWritten: false }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('feedback_cycle_schedule');
    });

    it('passes when the composition root caught up on a boundary', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(
        gate.failures.filter((failure) => failure.includes('feedback_cycle_schedule')),
      ).toEqual([]);
    });
  });

  describe('the sizing capital ceiling stamp (#1112)', () => {
    it('fails when a BTC-USD row carries a ceiling other than the configured one', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ sizingCeiling: { allMatchConfiguredCeiling: false } }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('sizing_capital_ceiling');
    });

    it('names the missing profile ceiling, not the stamp wire, when the profile stopped setting one', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          sizingCeiling: { configuredCeiling: undefined, allMatchConfiguredCeiling: false },
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('capitalCeilingUsd');
    });

    it('names the absent row as no-evidence rather than a broken wire', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ sizingCeiling: { rows: 0, allMatchConfiguredCeiling: false } }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('no evidence either way');
    });

    it('passes when every BTC-USD row carries the declared ceiling', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('sizing_capital_ceiling'))).toEqual(
        [],
      );
    });
  });

  describe("the dashboard's LLM cap (#1140)", () => {
    it('fails when the published cap is not the budget this run armed', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ publishedLlmCapUsd: 50, configuredLlmBudgetUsd: 275 }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain("dashboard's LLM cap");
    });

    it('fails when nothing published a cap at all for a capped run', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ publishedLlmCapUsd: null }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain("dashboard's LLM cap");
    });

    it('passes when the wire carries the enforced budget', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ publishedLlmCapUsd: 275, configuredLlmBudgetUsd: 275 }),
      );

      expect(gate.failures.filter((failure) => failure.includes("dashboard's LLM cap"))).toEqual(
        [],
      );
    });
  });

  describe("the dashboard's LLM cap_armed_at (#1196)", () => {
    it('fails when a booted run reports cap_armed_at: null', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ publishedLlmCapArmedAt: null }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('cap_armed_at: null');
    });

    it('passes when the wire carries the arming instant', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('cap_armed_at'))).toEqual([]);
    });
  });

  describe('the outside benchmarks (#981)', () => {
    it('fails when the cycle measured no benchmark at all', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          outsideBenchmarks: healthyOutsideBenchmarks({
            measured: 0,
            unmeasured: ['spy: series unavailable', 'sixty_forty: series unavailable'],
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('measured nothing');
      expect(gate.failures.join(' ')).toContain('series unavailable');
    });

    it('fails when nothing was persisted for the panel to read', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ outsideBenchmarks: healthyOutsideBenchmarks({ persistedRows: 0 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('outside_benchmark_samples');
    });

    it('fails when a persisted benchmark lost one of its two columns (D4)', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          outsideBenchmarks: healthyOutsideBenchmarks({ persistedBothColumns: false }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('return-only view');
    });

    it('fails when a benchmark was measured over a window of its own', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          outsideBenchmarks: healthyOutsideBenchmarks({ windowsMatchArmComparison: false }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('SAME window');
    });

    it('passes on measured, persisted benchmarks over the comparison’s window', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('outside-benchmark'))).toEqual([]);
      expect(gate.failures.filter((failure) => failure.includes('outside benchmark'))).toEqual([]);
    });
  });

  describe('the risk critic (#957)', () => {
    it('fails when no risk_critic_log row was written for a viable entry', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ riskCritic: healthyRiskCritic({ loggedVerdicts: [] }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('no risk_critic_log row was written');
    });

    it('fails when consulting the critic threw instead of failing open', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          riskCritic: healthyRiskCritic({ stepError: 'nous 503', loggedVerdicts: [] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('threw while consulting the critic');
    });

    it('passes when the root wired the producer and it recorded its verdict', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#957'))).toEqual([]);
    });
  });

  describe('the prompt-tier crossing warning (#1155)', () => {
    it('fails when no alert fired for two consecutive crossings on the same model', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ promptTierWarning: healthyPromptTierWarning({ alertsFired: 0 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('not exactly 1');
    });

    it('fails when both consecutive crossings alert — the throttle is not suppressing a repeat', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ promptTierWarning: healthyPromptTierWarning({ alertsFired: 2 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('not exactly 1');
    });

    it('fails when the scenario itself did not record both metered calls', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ promptTierWarning: healthyPromptTierWarning({ spendRows: 1 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('the scenario itself is broken');
    });

    it('fails when the fixture usage does not actually price at the tier rate', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ promptTierWarning: healthyPromptTierWarning({ costUsd: 0.3248 }) }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('does not actually cross the tier');
    });

    it('passes when two consecutive crossings on the same model produce exactly one alert', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#1155'))).toEqual([]);
    });
  });

  describe('the analyst failure-cause logging (#1114)', () => {
    it('fails when the probe itself produced no genuine (non-timeout) rejection', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          analystFailureCause: healthyAnalystFailureCause({ failureKinds: ['timeout'] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('probe itself is broken');
    });

    it('fails when a genuine rejection happened and nothing was logged at debug', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          analystFailureCause: healthyAnalystFailureCause({ debugPayloads: [] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('no `stage: "analysts", level: "debug"` line');
    });

    it('fails when the recorded debug lines carry no rendered cause', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          analystFailureCause: healthyAnalystFailureCause({
            debugPayloads: [{ analyst_type: 'technical', attempt: 1 }],
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('none carried the rendered name/message/cause');
    });

    it('passes when the probe rejected genuinely and the cause reached the logger', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#1114'))).toEqual([]);
    });
  });

  describe('the FILLED_WITH_ZERO_SIZE smoke wedge (#1125)', () => {
    it('fails when the wedge scenario produced no warning', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          filledZeroSizeWedge: healthyFilledZeroSizeWedge({ warnings: [] }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('expected exactly 1');
    });

    it('fails when the warning fired with the wrong shape', () => {
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({
          filledZeroSizeWedge: healthyFilledZeroSizeWedge({
            warnings: [
              {
                idempotency_key: 'smoke-filled-zero-size-wedge',
                instrument: 'AAPL',
                order_state: 'filled',
                consecutive: 1,
                stuck_ms: 1,
              },
            ],
          }),
        }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('unexpected shape');
    });

    it('passes when the wedge scenario produced exactly one throttled warning', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(gate.failures.filter((failure) => failure.includes('#1125'))).toEqual([]);
    });
  });
});

describe('findSweepDivergence (#1285)', () => {
  function divergence(overrides: Partial<ReconcileDivergence>): ReconcileDivergence {
    return {
      idempotency_key: 'decoy-lot',
      instrument: 'BTC-USD',
      store_state: 'submitted',
      broker_state: 'filled',
      action: 'rejected',
      kind: 'sweep',
      reason: '',
      ...overrides,
    };
  }

  it("returns the matching lot's own divergence, not a decoy for another lot", () => {
    const divergences = [
      divergence({ idempotency_key: 'other-lot', action: 'rejected' }),
      divergence({ idempotency_key: 'smoke-exit-sweep-lot', action: 'adopted', reason: 'ok' }),
      divergence({ idempotency_key: 'another-other-lot', action: 'undetermined' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')?.action).toBe('adopted');
    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')?.reason).toBe('ok');
  });

  it('returns undefined when no divergence names the lot, even with other lots present', () => {
    const divergences = [
      divergence({ idempotency_key: 'other-lot', action: 'adopted' }),
      divergence({ idempotency_key: 'another-other-lot', action: 'adopted' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('does not match a decoy key that starts with the lot key (lot key is its prefix)', () => {
    const divergences = [
      divergence({ idempotency_key: 'smoke-exit-sweep-lot-2', action: 'adopted' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('does not match a decoy key that is a prefix of the lot key', () => {
    const divergences = [divergence({ idempotency_key: 'smoke-exit-sweep-lo', action: 'adopted' })];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('does not match a decoy key that ends with the lot key', () => {
    const divergences = [
      divergence({ idempotency_key: 'x-smoke-exit-sweep-lot', action: 'adopted' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('does not match a decoy key that is a suffix of the lot key', () => {
    const divergences = [divergence({ idempotency_key: 'sweep-lot', action: 'adopted' })];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('does not match a decoy key of the same length as the lot key', () => {
    const divergences = [
      divergence({ idempotency_key: 'zzzzz-exit-sweep-lot', action: 'adopted' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')).toBeUndefined();
  });

  it('returns the first divergence when the key appears more than once, not the last', () => {
    const divergences = [
      divergence({ idempotency_key: 'smoke-exit-sweep-lot', action: 'adopted', reason: 'first' }),
      divergence({ idempotency_key: 'smoke-exit-sweep-lot', action: 'rejected', reason: 'last' }),
    ];

    expect(findSweepDivergence(divergences, 'smoke-exit-sweep-lot')?.reason).toBe('first');
  });
});
