/**
 * Offline smoke-run tests (#350).
 *
 * Two things are being protected here, and they are different in kind:
 *
 * 1. **The gate is a gate.** `evaluateSmokeGate` is pure over observations, so
 *    every "the pipeline did not transact" branch is exercised directly rather
 *    than by contriving a broken process. A gate that passes when nothing
 *    transacted is worse than no gate, so each failure mode gets its own case.
 * 2. **The fake mode stays unreachable from the real entrypoint** (#293/#320/
 *    #324) — the orchestrator barrel must not carry any of it, and the Alpaca
 *    wire client must refuse every call.
 *
 * The end-to-end case really does start the composition root, run the loop on
 * real timers and drain it. It is the only test in the suite that does, which
 * is the whole point of the ticket.
 */
import { RSI_SPEC, SMA_SPEC } from '../../pipeline/analysts/technical-analyst.js';
import type { ArmPerformance } from '../../pipeline/control-arm/index.js';
import { computeIndicator } from '../../providers/market-data-service/index.js';
import { GUARDED_THRESHOLD_NAMES } from '../../shared/index.js';
import { STAGE_OWNED_TABLES } from '../../shared/store/index.js';
import {
  type ArmComparisonEvidence,
  buildSmokeFixtureBars,
  ConstantResponseLlmClient,
  type CryptoEmulationEvidence,
  type DataFailoverEvidence,
  type EntrypointFaultGuardEvidence,
  type ExitPathEvidence,
  evaluateSmokeGate,
  FAILOVER_IN_SESSION_OPEN_TIMES,
  type FillSyncFailure,
  type FillSyncFailureEvidence,
  FillSyncFailureRecorder,
  FixedAccountStateProvider,
  formatSmokeReport,
  type LoggerResilienceEvidence,
  type MarketDataFetchEvidence,
  MarketDataFetchRecorder,
  type OutsideBenchmarkEvidence,
  type RiskCriticEvidence,
  runSmoke,
  SMOKE_GDELT_EXPECTED_AGGREGATES,
  SMOKE_GDELT_EXPECTED_ROWS,
  SMOKE_LLM_RESPONSE,
  SMOKE_RUN_INSTANT,
  type SmokeObservations,
  type ThresholdClampEvidence,
  UnreachableAlpacaClient,
  untoleratedFillSyncFailures,
} from './smoke-run.js';

/** Both sticky tiers persisted untripped — what a healthy run leaves in `breaker_state` (B1). */
const BOTH_TIERS = [
  { tier: 'portfolio_drawdown', tripped: 0 },
  { tier: 'kill_switch', tripped: 0 },
];

/**
 * A healthy exit path (#576) — every check `evaluateSmokeGate` runs against
 * `options.exitPath` passes against this shape unmodified. `twoLotFlatten`
 * defaults to no lot keys (vacuously satisfied — nothing to check) rather
 * than fabricating positions that would also have to exist in whatever
 * `SmokeObservations` the test under it supplies; tests that actually
 * exercise the phantom-open check pass their own `positions` AND their own
 * `twoLotFlatten` override together.
 */
function healthyExitPath(overrides: Partial<ExitPathEvidence> = {}): ExitPathEvidence {
  return {
    brokerCallSequence: ['cancel:lot-1', 'submitFlatten:lot-1-exit'],
    // #549: scenario 5 scripts ONE re-arm failure, so a healthy run carries
    // exactly its one inline alert — the gate now scopes the "no alerts"
    // check to every OTHER lot and requires exactly one for this one.
    residualAlerts: [
      {
        idempotency_key: 'lot-sweep',
        instrument: 'LINK-USD',
        side: 'buy',
        residual_qty: 6,
        residual_qty_is_upper_bound: false,
        stop: 90,
        target: 120,
        observed_at: SMOKE_RUN_INSTANT,
      },
    ],
    // Matches `transactedObservations()`'s 'idem-exit-1' position (closed) —
    // the fixture pairing the scoped #508/#517 check reads.
    fullExit: { lotKey: 'idem-exit-1' },
    partialFlatten: { idempotencyKey: 'lot-partial', expectedResidual: 0, protectedQty: 0 },
    twoLotFlatten: { lotKeys: [] },
    // #519/#526: matches `transactedObservations()`'s 'idem-crash-restart-1'
    // position (closed) — the fixture pairing the scoped check reads, same
    // convention as `fullExit` above. `reconcileReport` names the flatten's
    // OWN key (never the lot's — a flatten writes no `OpenPosition`) with
    // `action: 'adopted'`, the clean-settle outcome a deterministic offline
    // broker always produces.
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
            reason: "flatten journal said 'submitted'; broker reports 'submitted'",
          },
        ],
        swept: 0,
        timestamp: SMOKE_RUN_INSTANT,
      },
    },
    flattenReconcileAlerts: [],
    // #549: scenario 5's healthy outcome — the restarted sweep re-armed the
    // residual, cleared the marker, and reported it.
    residualSweep: {
      lotKey: 'lot-sweep',
      expectedResidual: 6,
      protectedQty: 6,
      markerCleared: true,
      sweepDivergenceAction: 'adopted',
    },
    // #1088: scenario 6's healthy outcome — the seeded terminal row is gone
    // after the restarted reconcile()'s sweep.
    terminalSweep: {
      seededKey: 'smoke-terminal-sweep-target',
      rowPresentAfterSweep: false,
      swept: 1,
    },
    ...overrides,
  };
}

/** A fully transacted run — the shape every failure case below mutates one field of. */
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
    verdicts: [{ trace_id: 'trace-1', instrument: 'BTC-USD', status: 'go', no_go_reason: null }],
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
      // #753: falsifier arm 2's own lot over the same tape, on the same tick.
      // A distinct key, because `arm` is a hash input to the idempotency key.
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
      // #576: scenario 1's closed lot — paired with `healthyExitPath()`'s
      // `fullExit.lotKey` default and the `closedTrades`/`flattenSubmissions`
      // rows above, all keyed on the same 'idem-exit-1'.
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
      // #519/#526: scenario 4's crash-restart lot — paired with
      // `healthyExitPath()`'s `crashRestart.lotKey` default, same convention
      // as `idem-exit-1` above.
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
    // #576: no longer always empty — see `SmokeObservations.closedTrades`'s doc.
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
    polymarketNewsItems: 1,
    // #430 — one per wired mechanism. A healthy run has all of them.
    cosineSetups: [{ debate_id: 'debate-1', instrument: 'BTC-USD' }],
    riskThresholds: [{ name: 'max_position_size', value: 5_000 }],
    analystWeights: [{ analyst_id: 'technical' }],
    traderDecisions: [{ trace_id: 'trace-1', instrument: 'BTC-USD', intent_type: 'entry' }],
    breakerStates: BOTH_TIERS,
    riskDecisions: [{ trace_id: 'trace-1', instrument: 'BTC-USD', status: 'approved' }],
  };
}

/**
 * A limiter that saw the run — the shape a healthy process produces (#388).
 * REQUIRED by `evaluateSmokeGate`, not optional: see that option's doc for the
 * mutation that made it so.
 */
function meteredSnapshot() {
  return { crypto: { debatesUsed: 1, llmCallsUsed: 4 } };
}

/**
 * A healthy crypto-emulation drive (#586) — every check `evaluateSmokeGate`
 * runs against `options.cryptoEmulation` passes against this shape
 * unmodified: the lot was journalled as crypto, both legs got venue ids, the
 * OCO edge completed, and both fills came back through the sweep.
 */
function healthyCryptoEmulation(
  overrides: Partial<CryptoEmulationEvidence> = {},
): CryptoEmulationEvidence {
  return {
    journalRow: {
      phase: 'resolved',
      asset_class: 'crypto',
      stop_order_id: 'scenario-alpaca-2',
      target_order_id: 'scenario-alpaca-3',
    },
    entryFillSeen: true,
    stopFillSeen: true,
    siblingCancelled: true,
    ...overrides,
  };
}

/** `evaluateSmokeGate`'s options for a fully healthy run — the base every test below mutates. */
function healthyGateOptions(
  overrides: {
    minTicks?: number;
    exitPath?: ExitPathEvidence;
    cryptoEmulation?: CryptoEmulationEvidence;
    loggerResilience?: LoggerResilienceEvidence;
    entrypointFaultGuards?: EntrypointFaultGuardEvidence;
    thresholdClamp?: ThresholdClampEvidence;
    dataFailover?: DataFailoverEvidence;
    riskCritic?: RiskCriticEvidence;
    armComparison?: ArmComparisonEvidence;
    outsideBenchmarks?: OutsideBenchmarkEvidence;
    feedbackCycleScheduleWritten?: boolean;
    sizingCeilingStamped?: boolean;
    fillSync?: FillSyncFailureEvidence;
    marketDataFetch?: MarketDataFetchEvidence;
  } = {},
) {
  return {
    fillSync: overrides.fillSync ?? healthyFillSync(),
    marketDataFetch: overrides.marketDataFetch ?? healthyMarketDataFetch(),
    armComparison: overrides.armComparison ?? healthyArmComparison(),
    outsideBenchmarks: overrides.outsideBenchmarks ?? healthyOutsideBenchmarks(),
    feedbackCycleScheduleWritten: overrides.feedbackCycleScheduleWritten ?? true,
    sizingCeilingStamped: overrides.sizingCeilingStamped ?? true,
    minTicks: overrides.minTicks ?? 2,
    llmRateLimiterSnapshot: meteredSnapshot(),
    exitPath: overrides.exitPath ?? healthyExitPath(),
    cryptoEmulation: overrides.cryptoEmulation ?? healthyCryptoEmulation(),
    loggerResilience: overrides.loggerResilience ?? healthyLoggerResilience(),
    entrypointFaultGuards: overrides.entrypointFaultGuards ?? healthyEntrypointFaultGuards(),
    thresholdClamp: overrides.thresholdClamp ?? healthyThresholdClamp(),
    dataFailover: overrides.dataFailover ?? healthyDataFailover(),
    riskCritic: overrides.riskCritic ?? healthyRiskCritic(),
  };
}

/**
 * What `runArmComparisonProbe` (#971) reports on a healthy run: both arms
 * derived, a sample persisted with both drawdowns, and no divergence — the
 * smoke tape is seconds long and the control arm's intents round to zero
 * shares, so the trade-count floor keeps divergence out of reach here.
 */
function healthyArmComparison(
  overrides: Partial<ArmComparisonEvidence> = {},
): ArmComparisonEvidence {
  const arm = (name: 'live' | 'control'): ArmPerformance => ({
    arm: name,
    trade_count: 0,
    realized_pnl_net: 0,
    return_pct: 0,
    max_drawdown_pct: 0,
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
      basis: 1_000,
      live: arm('live'),
      control: arm('control'),
    },
    ...overrides,
  };
}

/** The window a healthy arm comparison covers, and therefore the benchmarks'. */
const ARM_WINDOW_FROM = new Date('2026-08-02T00:00:00.000Z');
const ARM_WINDOW_TO = new Date('2026-09-01T00:00:00.000Z');

/**
 * What `runOutsideBenchmarkProbe` (#981) reports on a healthy run: both
 * benchmarks measured and persisted, both columns finite, and every persisted
 * window equal to the arm comparison's.
 */
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

/**
 * What `FillSyncFailureRecorder` reports on a healthy run (#1049): the
 * fill-sync poll never rejected. Scenario 5's scripted re-arm failure surfaces
 * as a residual-exposure alert (gated above), never as a poll rejection, so
 * the healthy shape is empty rather than a tolerated entry.
 */
function healthyFillSync(
  overrides: Partial<FillSyncFailureEvidence> = {},
): FillSyncFailureEvidence {
  return { failures: [], ...overrides };
}

/**
 * What `MarketDataFetchRecorder` reports on a healthy run (#1082): at least
 * one `market_data_fetch` line, guaranteed by the cold `:memory:` store's
 * first bar fetch through the composition root's primary `marketData`
 * instance.
 */
function healthyMarketDataFetch(
  overrides: Partial<MarketDataFetchEvidence> = {},
): MarketDataFetchEvidence {
  return { fetchCount: 1, traceIds: ['trace-1'], ...overrides };
}

/**
 * What `runRiskCriticScenario` reports when the composition root wires
 * check-pipeline step 7's producer (#957) AND the invalidation half measures
 * the fixture feed (#994).
 *
 * A `pass` verdict carrying one condition the evaluator measured as
 * `breached`, which `evaluate()` then rejects under `risk_critic:invalidated`
 * — the outcome `SmokeLlmClient`'s fixture pins deterministically.
 */
function healthyRiskCritic(overrides: Partial<RiskCriticEvidence> = {}): RiskCriticEvidence {
  return {
    loggedVerdicts: ['pass'],
    stepError: null,
    conditionStates: ['breached'],
    bindingConstraint: 'risk_critic:invalidated',
    ...overrides,
  };
}

/** What `runDataFailoverScenario` (#562) reports when the root builds a FailoverDataSource. */
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

/** What `runEntrypointFaultGuardScenario` (#764) reports when both entrypoints are wired. */
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

/** What `runThresholdClampScenario` reports when every #638 seam refuses. */
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

/** What `runLoggerResilienceScenario` reports when both #714 mechanisms hold. */
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

describe('evaluateSmokeGate', () => {
  it('passes when the pipeline transacted end to end', () => {
    const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

    expect(gate.failures).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  /**
   * #576: no longer the #82/#83 exception it used to be — the exit-path
   * harness (`runExitPathScenarios`) round-trips a lot to flat on every
   * healthy run, so an empty `closed_trades` is now a real defect, not an
   * expected offline limitation.
   */
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
    // A rejected intent never reaches Verdict, so with this unwired a
    // rejection has no durable record anywhere — which is why the check is
    // anchored on the Trader having written, not on a trade having happened.
    const observations = transactedObservations();
    observations.riskDecisions = [];

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('no row in risk_log');
  });

  it('does not demand a trader_log row when no debate resolved (#328)', () => {
    // The anchor that keeps the check honest: a run where nothing debated never
    // reached the Trader, so demanding a row would fail for a reason that is
    // not the one this check exists to catch. Same anchoring as cosine_setups.
    const observations = transactedObservations();
    observations.debates = [];
    observations.traderDecisions = [];
    observations.riskDecisions = [];

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.failures.join(' ')).not.toContain('trader_log');
  });

  it('fails when the GDELT poller archived nothing — the no-caller shape (#556)', () => {
    // 0 is the defect this repo keeps producing: a fully-built, fully-tested
    // component that the composition root never calls. Printing the count in
    // the report catches nothing on its own; the gate has to fail on it.
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
    // The regression #835 fixed: `write(raws, [])` leaves the raw count healthy
    // and the source unreplayable as items.
    const observations = transactedObservations();
    observations.polymarketItemsArchived = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('archived 0 items in mi_items');
  });

  it('fails when Polymarket fetched but nothing reached the news bucket (#504)', () => {
    // The half an archive count cannot see: rows written, items invisible to
    // the analyst that the whole source exists to feed.
    const observations = transactedObservations();
    observations.polymarketNewsItems = 0;

    const gate = evaluateSmokeGate(observations, healthyGateOptions());

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('Polymarket put 0 items in the news bucket');
  });

  it('fails when the GDELT theme filter stopped filtering (#556)', () => {
    // The canned batch is two rows, one watched. 2 means the filter matched
    // both — the archive would then be taking the whole world's news at 14.9KB
    // a row, which is the other half of what this observation exists to catch.
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

  /**
   * The headline condition #350 names: this is exactly what the real binary
   * does today against a 401ing market-data feed. If this case ever passes,
   * the gate is decoration.
   */
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

  /**
   * #753, expressed as a gate condition: the live arm transacted and every
   * other observation is green, while `open_positions` holds no control row at
   * all. That is `TickSteps.controlArm` left unbound in the composition root —
   * which is not a compile error, because the member is optional — and it is
   * the state a whole soak would run in, producing a live track with no matched
   * control. Nothing else in this gate, and no unit of the control arm, can see
   * it.
   */
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

  /**
   * The other half of #753's wiring: `arm` must be a HASH INPUT to the
   * idempotency key, not merely a recorded label. Sharing a key means
   * Execution's `findByKey` gate drops the control order on exactly the bars
   * the two arms agree on — a bias in the comparison, invisible everywhere
   * else because both arms still look busy.
   */
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

  /**
   * The #364 defect, expressed as a gate condition: every other observation
   * in a run like this is green — ticks reached Debate, a `go` was recorded,
   * a lot filled — and `debate_log` is still empty, because the store had no
   * caller. Nothing else in this gate could see that.
   */
  it('fails when a debate ran but no debate_log row was written (#364)', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), debates: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
  });

  /**
   * The #1081 defect, expressed as a gate condition: a `debate_log` row
   * exists — #364's check passes — but its `termination` is NULL, meaning
   * `buildDebateLog` stopped classifying the row. A truncated debate would
   * again be indistinguishable from a genuinely non-converged one, which is
   * exactly the ambiguity #1081 closes. Deleting the `termination` assignment
   * from an otherwise-healthy observation set is what this test proves the
   * gate catches — mirroring the "prove the assertion can fail" standard
   * PR #390 was reviewed against.
   */
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

  /**
   * The #388 defect, expressed as a gate condition, and the exact mirror of
   * the #364 case above: every observation is green — a debate resolved, a row
   * was written, a lot filled — while the rate limiter metered zero LLM calls,
   * because it is constructed beside the LLM path rather than in it. No table
   * records this, so nothing else in this gate could see it.
   */
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
      // 5 calls for one crypto debate: one above the 1-round worst case of 4.
      llmRateLimiterSnapshot: { crypto: { debatesUsed: 1, llmCallsUsed: 5 } },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('under-reserving'))).toBe(true);
  });

  it('does not demand metering from a run that never debated — that fails as #364 instead', () => {
    // Ordering matters for the operator: a run with no debates must be told
    // the debate never happened, not that the limiter saw nothing.
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), debates: [] },
      { ...healthyGateOptions(), llmRateLimiterSnapshot: {} },
    );

    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('#388 defect'))).toBe(false);
  });

  // #638 — the in-code threshold clamp. Each of these fails the gate on its
  // own: ADR-0013 leaves the numeric thresholds as the only stop, so any seam
  // that accepts an out-of-bound value is the whole control gone.
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

  // #766.
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

  // #714 — the logging-fault mechanisms. Each of these fails the gate on its
  // own, because each is a different way for an unattended soak to end or to
  // go quietly blind.
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
    // The throw is swallowed inside a tick by design (#573), so stderr is the
    // only thing standing between that ordering and a run trading blind.
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
    // The constraint that matters most: a blanket swallow at the composition
    // root would leave a live-money process trading in an unknown state.
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        loggerResilience: healthyLoggerResilience({ fatalExitCode: 0 }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('unknown state'))).toBe(true);
  });

  // #764 — the service-api and supervisor entrypoint fault guards, on the
  // same "each check fails the gate on its own" basis as #714's above.
  //
  // There is no test here for "stdout error subscription did not degrade a
  // destroyed pipe": that outcome is not a boolean the gate reads, it is
  // `NoListenerBreakablePipe.breakPipe` throwing inside
  // `runEntrypointFaultGuardScenario` and aborting the whole smoke run before
  // `evaluateSmokeGate` is ever called — proven directly by the mutation
  // table in the #764 PR description, not by a fixture flag here.

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
          },
        ],
      },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no_go:stale_signal'))).toBe(true);
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

  /**
   * The fill only lands on the fill-sync poll, never on the tick that
   * submitted — so this is the one branch that proves `ingestFills()` is
   * actually scheduled rather than merely wired.
   */
  it('fails when the order was submitted but no fill was ever ingested', () => {
    const gate = evaluateSmokeGate(
      { ...transactedObservations(), fills: [] },
      healthyGateOptions(),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('ingestFills'))).toBe(true);
  });

  /**
   * `startTickLoop` catches and logs whatever a tick throws, so a run that
   * reached the network would otherwise fail for a downstream symptom and never
   * name the cause. This turns it into its own named failure.
   */
  it('fails when anything reached the Alpaca wire client, even if everything else transacted', () => {
    const gate = evaluateSmokeGate(transactedObservations(), {
      ...healthyGateOptions(),
      alpacaWireClientReached: true,
    });

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

  /**
   * The mutation this gate exists to catch: dropping `runWithTraceId` from
   * `SequentialTickRunner.runInstrument` leaves the fetch count untouched and
   * every site's fallback is a legal return, so the count check above still
   * passes and only the join fails.
   */
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
      level: 'info',
      message: 'market_data_fetch: AAPL 1h fetched 2 row(s) in 5ms.',
      payload: { event: 'market_data_fetch' },
    });
    recorder.log({
      trace_id: 't2',
      stage: 'debate',
      level: 'info',
      message: 'unrelated line',
      payload: { event: 'debate_something_else' },
    });
    recorder.log({
      trace_id: 't3',
      stage: 'market_data',
      level: 'info',
      message: 'no payload at all',
    });

    expect(recorder.evidence()).toEqual({ fetchCount: 1, traceIds: ['t1'] });
    expect(forwarded).toEqual([
      'market_data_fetch: AAPL 1h fetched 2 row(s) in 5ms.',
      'unrelated line',
      'no payload at all',
    ]);
  });
});

describe('FillSyncFailureRecorder (#1049)', () => {
  const entry = (level: 'info' | 'warn' | 'error', message: string, error?: string) => ({
    trace_id: 'fill-sync',
    stage: 'execution',
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
    const report = formatSmokeReport(
      observations,
      evaluateSmokeGate(observations, healthyGateOptions()),
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
      polymarketNewsItems: 1,

      cosineSetups: [],
      riskThresholds: [],
      analystWeights: [],
      traderDecisions: [],
      breakerStates: BOTH_TIERS,
      riskDecisions: [],
    };
    const report = formatSmokeReport(
      observations,
      evaluateSmokeGate(observations, healthyGateOptions({ minTicks: 3 })),
    ).join('\n');

    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('no tick got past Analysts');
  });
});

describe('buildSmokeFixtureBars', () => {
  const bars = buildSmokeFixtureBars();
  const countFor = (timeframe: string) => bars.filter((bar) => bar.timeframe === timeframe).length;

  /**
   * #319's `computeIndicator` minimum-length guard rejects a window shorter
   * than `period + 1` (ATR spends its first bar seeding `previousClose`). The
   * consumers here are `traderConfig.atr_lookback` (14),
   * `DEFAULT_VOLATILITY_INDICATOR` / `executionConfig.simulated.volatility_indicator`
   * (ATR(14) — HARD floor still `period + 1` = 15; both now ask for the
   * converged warm-up of 57, `recommendedWarmupFor`, #757 — a SOFT floor,
   * same shape as `RSI_SPEC`'s), `adv_window` ({'1d', 20}) and
   * `correlationConfig` ({'1d', 30}, min_bars 20). A fixture that stopped
   * clearing any of these would not fail loudly — it would degrade a stage
   * into skipping, which is the failure the gate exists to catch. Pinned
   * here so it fails as a test instead.
   */
  it('supplies more bars than every lookback the paper profile reads', () => {
    // #742: RSI_SPEC/SMA_SPEC read '5m' now; '1h' remains the Trader's ATR
    // timeframe (unchanged) and the technical analyst's context read.
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
    // #742: the technical analyst's read moved from '1h' to '5m'; this test
    // now filters the '5m' series, which is what `SMA_SPEC`/`RSI_SPEC`
    // actually read in production. `buildTrendingCloses` depends only on
    // `count`/`lastClose`, not `timeframe`, so the '5m' series carries the
    // same close values the '1h' series always has — the RSI/margin figures
    // quoted below (68.52, 1.48 points) are unchanged by the move.
    const fiveMinute = bars
      .filter((bar) => bar.timeframe === '5m')
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());
    const first = fiveMinute[0];
    const last = fiveMinute[fiveMinute.length - 1];
    if (first === undefined || last === undefined) throw new Error('no 5m fixture bars');

    expect(last.close).toBeGreaterThan(first.close);
    // A non-degenerate true range, so the Trader's ATR stop is a real distance
    // rather than a volatility-floor artefact.
    expect(last.high - last.low).toBeGreaterThan(0);

    // "Trends upward" was the whole assertion here, and it was too weak to
    // catch what it was for: the previous monotonic ramp trended upward AND
    // made the technical analyst read `neutral`, because a series with no down
    // bars has RSI exactly 100 and `directionFrom` treats >= 70 as overbought.
    // The desk therefore never agreed, and the run's only directional
    // participant was the mediator. Assert the analyst's own rule instead.
    //
    // The REAL specs, not rebuilt literals (#722): this used to hand-build
    // `lookback: 15` while feeding it all 60 hourly bars, so it agreed with the
    // analyst only by accident and would have gone on passing had the fixture
    // stopped clearing the spec's warm-up. Slicing by `RSI_SPEC.lookback` also
    // makes the fixture-depth requirement an assertion rather than a comment.
    expect(fiveMinute.length).toBeGreaterThanOrEqual(RSI_SPEC.lookback);
    const sma = computeIndicator(fiveMinute.slice(-SMA_SPEC.lookback), SMA_SPEC);
    const rsi = computeIndicator(fiveMinute.slice(-RSI_SPEC.lookback), RSI_SPEC);

    expect(last.close).toBeGreaterThan(sma);
    // 68.52 under the converged warm-up, against 63.16 under the old floor —
    // still bullish, with 1.48 points of headroom to the overbought gate.
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
  /**
   * The tripwire, not a stub: the composition root builds the Alpaca wire
   * client eagerly, but with `broker` and `accountState` both overridden it has
   * no call sites. If that ever changes, the smoke run must fail loudly rather
   * than quietly exercise a fabricated Alpaca.
   */
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
  /**
   * The safety property the ticket asks for in one assertion: it must be
   * impossible for `yarn orchestrator` to select fixtures or the simulated
   * broker. `smoke-run.ts` is a leaf — nothing on the shipped entrypoint's
   * import graph reaches it, and nothing on the package's export surface names
   * it. Re-exporting any of it from the barrel would make it reachable, so
   * that is what this guards.
   */
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
  /**
   * The only test that starts the real process assembly: `startFromEnvironment`
   * -> `buildProductionOrchestrator`, real `setTimeout` tick loop, real fill
   * poll, real shutdown drain, real SQLite round-trip. Everything else in this
   * suite is a unit test around it.
   *
   * Real timers on purpose — fake timers would replace exactly the mechanism
   * under test. Kept to one tick with tight intervals so it stays quick.
   */
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

    // The observable effects, not the log lines.
    expect(result.observations.verdicts.map((verdict) => verdict.status)).toContain('go');
    const sixStageLots = result.observations.positions.filter(
      (position) => position.instrument === 'BTC-USD' && position.arm === 'live',
    );
    expect(sixStageLots).toHaveLength(1);
    // #753 — falsifier arm 2 ran on the SAME tick, over the same tape, and left
    // its own lot in the same book, distinguishable by a real column rather
    // than inferred. Distinct idempotency keys prove `arm` is a hash input:
    // without that, Execution's `findByKey` would have deduped the control lot
    // away on exactly the bars the two arms agree on.
    const controlLots = result.observations.positions.filter(
      (position) => position.instrument === 'BTC-USD' && position.arm === 'control',
    );
    expect(controlLots).toHaveLength(1);
    expect(controlLots[0]?.idempotency_key).not.toEqual(sixStageLots[0]?.idempotency_key);
    expect(result.observations.fills.some((fill) => fill.leg === 'entry')).toBe(true);
    // Reachable only through the fill-sync poll: the lot advanced past
    // `submitted` because `ingestFills()` ran, not because `execute()` said so.
    expect(sixStageLots[0]?.order_state).toBe('filled');
    expect(sixStageLots[0]?.filled_size).toBeGreaterThan(0);

    // #576 — the exit path, driven by `runExitPathScenarios` against the same
    // store: scenario 1 closes one lot, scenario 2 leaves its lot open with a
    // protected residual (not closed — that is the point), scenario 3 closes
    // both of its lots, (#519/#526) scenario 4 closes its own lot too — via
    // the RESTARTED Execution's reconcile() + ingestFills(), not the original
    // one — and (#549) scenario 5 leaves its lot open like scenario 2's, its
    // residual re-armed by the restarted sweep. 1 + 0 + 2 + 1 + 0 = 4
    // `ClosedTrade`s; 6 `flatten_submissions` rows (one per exit call across
    // the five scenarios), every one resolved.
    expect(result.observations.closedTrades).toHaveLength(4);
    expect(result.observations.flattenSubmissions).toHaveLength(6);
    expect(result.observations.flattenSubmissions.every((row) => row.status === 'submitted')).toBe(
      true,
    );
  });

  /**
   * #1049 — the recorder is WIRED, not merely built: the same fault #1048's
   * measurement used (Execution's owned-table set without `fills`, so the
   * sole-writer guard rejects every `ingestFills` write) must flip the gate
   * to FAIL through `runSmoke` itself, naming the fill-sync line. A
   * `fillSync: { failures: [] }` regression in `runSmoke` leaves every other
   * `runSmoke` case green and only this one red. `guardedStore` reads
   * `STAGE_OWNED_TABLES` at construction, so the swap has to precede the run
   * and is restored whatever the outcome.
   */
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

  /**
   * Determinism: the issue asks for responses "stable run-to-run". Two runs
   * over the same frozen instant must price and size the lot identically —
   * anything else means something is reading the wall clock or the network.
   */
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
    // #576: the exit-path harness's fixed fractions and fixed clock steps
    // must reproduce identically too — a flaky ClosedTrade count would mean
    // something in the harness reads real wall-clock time.
    expect(second.observations.closedTrades).toEqual(first.observations.closedTrades);
    expect(second.observations.flattenSubmissions).toEqual(first.observations.flattenSubmissions);
  });

  /**
   * The counterpart to the passing case above, on the same observation shape:
   * a run that reaches nothing but `quorum_skip` — the exact state a
   * credential-less real run reaches today — must trip every downstream
   * requirement, not just the Analysts one. Five distinct failures, because
   * five different things did not happen.
   *
   * The end-to-end version of this is a manual mutation (starve
   * `buildSmokeFixtureBars`, rebuild, run `yarn smoke`, observe exit 1) and is
   * recorded in the PR body — it cannot be expressed here without giving
   * `runSmoke` a seam whose only purpose would be to weaken the run.
   */
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
      polymarketNewsItems: 1,

      cosineSetups: [],
      riskThresholds: [],
      analystWeights: [],
      traderDecisions: [],
      breakerStates: BOTH_TIERS,
      riskDecisions: [],
    };

    const gate = evaluateSmokeGate(
      observations,
      // The fetch telemetry joins to this fixture's own tick: the run below
      // is about an EMPTY STORE, not about traces, and a mismatched trace
      // here would add an unrelated failure to the count.
      healthyGateOptions({
        minTicks: 1,
        marketDataFetch: healthyMarketDataFetch({ traceIds: ['t'] }),
      }),
    );

    expect(gate.passed).toBe(false);
    // Eight since #430 added the seeded-mechanism checks, plus three since
    // #576 made `closed_trades`/`flatten_submissions` unconditional
    // requirements AND scoped the #508/#517 check to scenario 1's own lot:
    // an empty `positions` table means that lookup finds nothing either,
    // plus one since #519/#526 scoped its own crash-restart check to
    // scenario 4's lot the same way — an empty `positions` table means THAT
    // lookup finds nothing either. Every other exit-path-SPECIFIC check
    // (ordering, residual, phantom-open, the reconcile-divergence half of
    // the #519/#526 check) stays healthy (see `healthyGateOptions`) — this
    // test is about the STORE being empty, not about the exit path.
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

/**
 * #430 — the composition-root assertions, one per wired mechanism.
 *
 * The repo's dominant defect class is a complete, tested mechanism with no
 * production caller. Per-ticket fixes have not stopped it, because each
 * instance is individually correct code and the gap is always at the
 * composition root, where unit tests cannot see it.
 *
 * These tests are the mutation proof the issue asks for: each one deletes a
 * mechanism's EFFECT from an otherwise-healthy run and confirms the gate goes
 * red. A check that cannot fail is the defect it is meant to catch.
 */
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
    // Naming the real cause rather than a downstream symptom, the same way the
    // rate-limiter check hangs off `debates.length`.
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
    // The conjunction is the point: each row is written by exactly one
    // mechanism, so no single wiring can carry another's check.
    expect(gateFor(transactedObservations()).passed).toBe(true);
  });
});

/**
 * #576 — one case per exit-path invariant, the same convention #430 above
 * uses: each test mutates exactly one piece of evidence off an otherwise
 * healthy run and confirms the gate names the right one. These are the
 * checks `runExitPathScenarios`' real end-to-end evidence has to satisfy
 * (see `runSmoke`'s test above) — here each is pinned in isolation, the same
 * way every other branch in this file is.
 */
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

  /**
   * The gap an aggregate-only `closed_trades.length === 0` check would miss:
   * scenario 3 alone closes two lots, so a regression confined to scenario
   * 1 (e.g. a reintroduced #517 fill-misattribution on its instrument)
   * would leave `closedTrades` nonzero and the aggregate check green. The
   * `fullExit` evidence is scoped to scenario 1's own lot for exactly this
   * reason — mirroring the #571 check's per-lot scoping below.
   */
  it("fails when scenario 1's own lot never closed, even though other lots did (#508/#517)", () => {
    const observations = {
      ...transactedObservations(),
      // 'idem-exit-1' (scenario 1's lot) regresses to 'partially_filled';
      // 'idem-1' is untouched and `closedTrades` still carries its one row
      // from a DIFFERENT scenario — the aggregate signal alone would pass.
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
    // The reverse of the healthy sequence — cancel AFTER, not before.
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
          idempotency_key: 'lot-2',
          instrument: 'SOL-USD',
          side: 'buy',
          residual_qty: 6,
          residual_qty_is_upper_bound: false,
          stop: 90,
          target: 120,
          observed_at: SMOKE_RUN_INSTANT,
        },
      ],
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('re-arm failed'))).toBe(true);
  });

  // #549 — the residual-protection sweep's own enforcement branches, each
  // pinned in isolation the same way every other exit-path check above is.
  describe('the residual-protection sweep (#549)', () => {
    it("fails when the restarted reconcile() named no divergence for scenario 5's lot — the marker or the sweep is unwired", () => {
      const gate = gateFor({
        residualSweep: {
          lotKey: 'lot-sweep',
          expectedResidual: 6,
          protectedQty: 6,
          markerCleared: true,
          sweepDivergenceAction: undefined,
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
        },
      });

      expect(gate.passed).toBe(false);
      expect(
        gate.failures.some((failure) =>
          failure.includes('either never re-armed (the lot is naked) or sized the wrong quantity'),
        ),
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

  // #1088 — the terminal-row sweep's own enforcement branch. The mutation
  // this kills: deleting `sweepTerminalPositions`'s call from `reconcile()`
  // (or narrowing/breaking its predicate) leaves scenario 6's seeded row in
  // `open_positions` forever — nothing else in the gate would notice, since
  // every other check reads `getOpenPositions()`, which already excluded a
  // terminal row from its view whether or not the sweep ever ran.
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
        // #753: the control arm's lot from the same run. Present in every
        // positions fixture because the gate now requires falsifier arm 2 to
        // have produced a row whenever a tick reached Execution — a fixture
        // without one is a run with no matched control.
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
          // Never reached 'closed' — the #571 regression shape.
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
        // #753: the control arm's lot from the same run. Present in every
        // positions fixture because the gate now requires falsifier arm 2 to
        // have produced a row whenever a tick reached Execution — a fixture
        // without one is a run with no matched control.
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

  // #586 — the crypto-emulation checks. Each mutates one field of a healthy
  // evidence shape, naming a distinct way the emulation can stop being wired
  // while every other observation stays green.
  it('fails when no emulated-leg journal row exists for the crypto lot (#586)', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({ cryptoEmulation: healthyCryptoEmulation({ journalRow: undefined }) }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no crypto row'))).toBe(true);
  });

  it('fails when the journal row never got protective-leg order ids (#586)', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        cryptoEmulation: healthyCryptoEmulation({
          journalRow: {
            phase: 'pending_entry',
            asset_class: 'crypto',
            stop_order_id: null,
            target_order_id: null,
          },
        }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('never submitted as plain'))).toBe(
      true,
    );
    expect(gate.failures.some((failure) => failure.includes("expected 'resolved'"))).toBe(true);
  });

  it('fails when the sibling was never cancelled after the stop filled (#586)', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({ cryptoEmulation: healthyCryptoEmulation({ siblingCancelled: false }) }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('one-cancels-other'))).toBe(true);
  });

  it('fails when the emulated fills never came back through the sweep (#586)', () => {
    const gate = evaluateSmokeGate(
      transactedObservations(),
      healthyGateOptions({
        cryptoEmulation: healthyCryptoEmulation({ entryFillSeen: false, stopFillSeen: false }),
      }),
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('entry fill never came back'))).toBe(
      true,
    );
    expect(gate.failures.some((failure) => failure.includes('stop-leg fill never came back'))).toBe(
      true,
    );
  });

  describe('the OHLCV failover (#562)', () => {
    it('fails when the composition root read threw instead of failing over', () => {
      // The mutation this check exists to catch: delete
      // `buildFailoverDataSource` from production.ts and the primary's throw
      // reaches the caller. No unit test of the wrapper can see that.
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
      // The mutation this catches: drop the `samples.append(sample)` line, or
      // migration 0034, and the panel shows "no comparison computed yet"
      // forever while every unit test stays green.
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
  });

  describe('the daily feedback cycle schedule (#1110)', () => {
    it('fails when the composition root never wrote a schedule row', () => {
      // The mutation this catches: delete `scheduleFeedbackCycle` (or its
      // call site in `start()`) from production.ts. `armComparison` and
      // `outsideBenchmarks` above stay green throughout, because both are
      // read from probes that call the shipped cycle functions DIRECTLY —
      // this is the one check that can only pass if the real timer ran.
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
    it('fails when a BTC-USD open_positions row carries no declared ceiling', () => {
      // The mutation this catches: drop `config.capitalCeilingUsd` from
      // `new SqliteExecutionStore(...)` in production.ts. Every other check
      // in the gate stays green — the Trader still sizes and the position
      // still fills — because the missing wire is in the STAMP, not in the
      // sizing arithmetic itself.
      const gate = evaluateSmokeGate(
        transactedObservations(),
        healthyGateOptions({ sizingCeilingStamped: false }),
      );

      expect(gate.passed).toBe(false);
      expect(gate.failures.join(' ')).toContain('sizing_capital_ceiling_gbp');
    });

    it('passes when every BTC-USD row carries the declared ceiling', () => {
      const gate = evaluateSmokeGate(transactedObservations(), healthyGateOptions());

      expect(
        gate.failures.filter((failure) => failure.includes('sizing_capital_ceiling_gbp')),
      ).toEqual([]);
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
      // The reasons travel with the failure, so an operator is not left to
      // guess between "the vendor was down" and "the cycle is unwired".
      expect(gate.failures.join(' ')).toContain('series unavailable');
    });

    it('fails when nothing was persisted for the panel to read', () => {
      // The mutation this catches: drop `samples.append(...)`, or migration
      // 0036, and the panel shows "not measured yet" forever while every unit
      // test stays green.
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
      // The invariant #636 turns on, and the one that would rot silently: give
      // the benchmark cycle its own `window_ms` and every unit test still
      // passes while the panel quietly compares two different periods.
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
      // The mutation this check exists to catch, verified by hand: delete the
      // `critic:` line from `buildProductionComponents` and `yarn smoke` goes
      // red here, while every unit test stays green.
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
});
