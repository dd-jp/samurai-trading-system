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
import {
  buildSmokeFixtureBars,
  ConstantResponseLlmClient,
  evaluateSmokeGate,
  FixedAccountStateProvider,
  formatSmokeReport,
  runSmoke,
  SMOKE_CLOSED_TRADE_NOTE,
  SMOKE_LLM_RESPONSE,
  SMOKE_RUN_INSTANT,
  type SmokeObservations,
  UnreachableAlpacaClient,
} from './smoke-run.js';

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
    debates: [{ debate_id: 'debate-1', instrument: 'BTC-USD', direction: 'bullish', rounds: 1 }],
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
      },
    ],
    fills: [{ idempotency_key: 'idem-1', leg: 'entry', price: 161, qty: 31.25, fee: 13 }],
    closedTrades: [],
  };
}

describe('evaluateSmokeGate', () => {
  it('passes when the pipeline transacted end to end', () => {
    const gate = evaluateSmokeGate(transactedObservations(), { minTicks: 2 });

    expect(gate.failures).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  it('does NOT require a ClosedTrade — unreachable offline (#82/#83)', () => {
    const observations = transactedObservations();
    expect(observations.closedTrades).toEqual([]);

    expect(evaluateSmokeGate(observations, { minTicks: 2 }).passed).toBe(true);
  });

  it('fails when the loop ran fewer ticks than asked for', () => {
    const gate = evaluateSmokeGate(transactedObservations(), { minTicks: 5 });

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

    const gate = evaluateSmokeGate(observations, { minTicks: 2 });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no tick got past Analysts'))).toBe(
      true,
    );
  });

  /**
   * The #364 defect, expressed as a gate condition: every other observation
   * in a run like this is green — ticks reached Debate, a `go` was recorded,
   * a lot filled — and `debate_log` is still empty, because the store had no
   * caller. Nothing else in this gate could see that.
   */
  it('fails when a debate ran but no debate_log row was written (#364)', () => {
    const gate = evaluateSmokeGate({ ...transactedObservations(), debates: [] }, { minTicks: 2 });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no row in debate_log'))).toBe(true);
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
      { minTicks: 2 },
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('no_go:stale_signal'))).toBe(true);
  });

  it('fails when a GO was recorded but Execution never reported submitted', () => {
    const observations = transactedObservations();
    const firstTick = observations.ticks[0];
    if (firstTick === undefined) throw new Error('fixture regression: no first tick');
    firstTick.stages = firstTick.stages.filter((entry) => entry.stage !== 'execution');

    const gate = evaluateSmokeGate(observations, { minTicks: 2 });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('reached Execution'))).toBe(true);
  });

  it('fails when nothing was written ahead to open_positions', () => {
    const gate = evaluateSmokeGate({ ...transactedObservations(), positions: [] }, { minTicks: 2 });

    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.includes('open_positions'))).toBe(true);
  });

  /**
   * The fill only lands on the fill-sync poll, never on the tick that
   * submitted — so this is the one branch that proves `ingestFills()` is
   * actually scheduled rather than merely wired.
   */
  it('fails when the order was submitted but no fill was ever ingested', () => {
    const gate = evaluateSmokeGate({ ...transactedObservations(), fills: [] }, { minTicks: 2 });

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
      minTicks: 2,
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
      { minTicks: 2 },
    );

    expect(gate.passed).toBe(false);
  });
});

describe('formatSmokeReport', () => {
  it('states the reached stages, the verdict, the lot and the fill', () => {
    const observations = transactedObservations();
    const report = formatSmokeReport(
      observations,
      evaluateSmokeGate(observations, { minTicks: 2 }),
    ).join('\n');

    expect(report).toContain(
      'analysts:quorum_met -> debate:bullish -> trader:entry -> risk:approved -> ' +
        'verdict:go -> execution:submitted',
    );
    expect(report).toContain('BTC-USD go');
    expect(report).toContain('BTC-USD buy requested=31.25');
    expect(report).toContain('entry qty=31.25');
    expect(report).toContain('GATE: PASS');
    // The zero-ClosedTrade explanation travels with the output, so nobody has
    // to rediscover why a passing run shows none.
    expect(report).toContain(SMOKE_CLOSED_TRADE_NOTE);
  });

  it('lists every unmet requirement on a failure', () => {
    const observations: SmokeObservations = {
      ticks: [],
      debates: [],
      verdicts: [],
      positions: [],
      fills: [],
      closedTrades: [],
    };
    const report = formatSmokeReport(
      observations,
      evaluateSmokeGate(observations, { minTicks: 3 }),
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
   * (ATR(14), lookback 15), `adv_window` ({'1d', 20}) and `correlationConfig`
   * ({'1d', 30}, min_bars 20). A fixture that stopped clearing any of these
   * would not fail loudly — it would degrade a stage into skipping, which is
   * the failure the gate exists to catch. Pinned here so it fails as a test
   * instead.
   */
  it('supplies more bars than every lookback the paper profile reads', () => {
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
    const hourly = bars
      .filter((bar) => bar.timeframe === '1h')
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());
    const first = hourly[0];
    const last = hourly[hourly.length - 1];
    if (first === undefined || last === undefined) throw new Error('no hourly fixture bars');

    expect(last.close).toBeGreaterThan(first.close);
    // A non-degenerate true range, so the Trader's ATR stop is a real distance
    // rather than a volatility-floor artefact.
    expect(last.high - last.low).toBeGreaterThan(0);
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
    expect(result.observations.positions).toHaveLength(1);
    expect(result.observations.fills.some((fill) => fill.leg === 'entry')).toBe(true);
    // Reachable only through the fill-sync poll: the lot advanced past
    // `submitted` because `ingestFills()` ran, not because `execute()` said so.
    expect(result.observations.positions[0]?.order_state).toBe('filled');
    expect(result.observations.positions[0]?.filled_size).toBeGreaterThan(0);
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
    };

    const gate = evaluateSmokeGate(observations, { minTicks: 1 });

    expect(gate.passed).toBe(false);
    expect(gate.failures).toHaveLength(6);
    expect(gate.failures.some((failure) => failure.includes('no tick got past Analysts'))).toBe(
      true,
    );
    expect(gate.failures.some((failure) => failure.includes('no GO verdict'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('reached Execution'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('open_positions'))).toBe(true);
    expect(gate.failures.some((failure) => failure.includes('ingestFills'))).toBe(true);
  });
});
