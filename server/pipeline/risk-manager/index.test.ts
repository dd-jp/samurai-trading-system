import type {
  Bar,
  BarWindow,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarkRead,
} from '../../providers/market-data-service/index.js';
import { collectMarks } from '../../providers/market-data-service/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../../shared/index.js';
import { CircuitBreakers } from './breakers.js';
import { PerSubclassCapUnresolvableError, RiskManagerImpl } from './index.js';
import { INVALIDATED_BINDING_CONSTRAINT, NO_CONDITIONS_REASON } from './invalidation.js';
import { computePortfolioView } from './portfolio-view.js';
import type {
  BreakerState,
  CorrelationEstimate,
  EvaluatedCondition,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticVerdict,
  RiskInput,
} from './types.js';

const fixedClock: Clock = { now: () => new Date('2026-07-15T09:30:00Z') };

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T09:30:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T09:30:00Z'),
    decided_at: new Date('2026-07-15T09:30:00Z'),
    metadata: {
      debate_id: 'debate-abc123',
      conviction: 0.72,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1.2,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: {
        neighbor_count: 5,
        weighted_mean_r: 0.4,
        no_precedent: false,
      },
    },
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioView> = {}): PortfolioView {
  return {
    equity: 100_000,
    peak_equity: 100_000,
    drawdown_pct: 0,
    exposure_by_instrument: {},
    exposure_by_class: { crypto: 0, stocks: 0 },
    gross_exposure: 0,
    reserved_exposure_by_instrument: {},
    reserved_exposure_by_class: { crypto: 0, stocks: 0 },
    reserved_gross_exposure: 0,
    daily_pnl: {
      crypto: { known: true, pct: 0 },
      stocks: { known: true, pct: 0 },
      portfolio: { known: true, pct: 0 },
    },
    consecutive_losses: 0,
    unvalued_instruments: [],
    ...overrides,
  };
}

function makeBreakers(overrides: Partial<BreakerState> = {}): BreakerState {
  return {
    portfolio_tripped: false,
    asset_class_tripped: { crypto: false, stocks: false },
    armed_breakers: [],
    ...overrides,
  };
}

function makeCorrelation(overrides: Partial<CorrelationEstimate> = {}): CorrelationEstimate {
  return {
    correlations: {},
    insufficient_history: [],
    ...overrides,
  };
}

function makePersistedBreakerState(): PersistedBreakerState[] {
  return [
    { tier: 'portfolio_drawdown', tripped: false, tripped_at: null, reset_at: null, reason: null },
    { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
  ];
}

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    max_position_size_fraction_of_equity: 10,
    per_asset_cap_fraction_of_equity: 10,
    per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 10 },
    portfolio_gross_cap_fraction_of_equity: 10,
    concentration: { cap_fraction_of_equity: 10, threshold: 0.7 },
    min_viable_size: 100,
    whole_share_sizing: false,
    cii_threshold: 70,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    ...overrides,
  };
}

function makeInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    trace_id: 'trace-1',
    intent: makeIntent(),
    clock: fixedClock,
    portfolio: makePortfolio(),
    breakers: makeBreakers(),
    next_breaker_state: makePersistedBreakerState(),
    correlation: makeCorrelation(),
    cii: {},
    mode: 'live',
    ...overrides,
  };
}

describe('RiskManagerImpl.evaluate — exits', () => {
  it('passes an exit through verbatim, bypassing every gate', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size_fraction_of_equity: 0.00001, min_viable_size: 1_000_000 }),
    );
    const input = makeInput({
      intent: makeIntent({ intent_type: 'exit', size: 100 }),
      breakers: makeBreakers({ portfolio_tripped: true }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent).toEqual(input.intent);
    expect(decision.modifications).toEqual({
      original_size: 100,
      final_size: 100,
      stop_tightened: false,
    });
    expect(decision.binding_constraint).toBeNull();
  });

  it('carries an unpriced flatten through with its flag and zeroed prices intact (#826)', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const intent = makeIntent({
      intent_type: 'exit',
      size: 100,
      entry: 0,
      stop: 0,
      target: 0,
      metadata: { ...makeIntent().metadata, exit_reason: 'flatten', unpriced_exit: true },
    });
    const input = makeInput({ intent });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.metadata.unpriced_exit).toBe(true);
    expect(decision.order_intent?.entry).toBe(0);
    expect(decision.order_intent).toEqual(intent);
    expect(decision.modifications?.final_size).toBe(100);
  });
});

describe('RiskManagerImpl.evaluate — long-only book (#1511)', () => {
  const saxoConfig = () => makeConfig({ long_only_instruments: new Set(['3LUS']) });

  it('refuses a sell entry with no held lot on a Saxo-venue instrument', () => {
    const manager = new RiskManagerImpl(saxoConfig());
    const input = makeInput({
      intent: makeIntent({
        instrument: '3LUS',
        asset_class: 'stocks',
        side: 'sell',
        intent_type: 'entry',
        size: 1,
      }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('long_only_book');
    expect(decision.reasons.join(' ')).toMatch(/3LUS/);
    expect(decision.reasons.join(' ')).toMatch(/#1511/);
    expect(decision.reasons.join(' ')).toMatch(/with no held lot/);
    expect(decision.order_intent).toBeNull();
  });

  it('refuses a sell scale_in the same way, as defence-in-depth against a short lot ever existing', () => {
    const manager = new RiskManagerImpl(saxoConfig());
    const input = makeInput({
      intent: makeIntent({
        instrument: '3LUS',
        asset_class: 'stocks',
        side: 'sell',
        intent_type: 'scale_in',
      }),
    });

    const decision = manager.evaluate(input);

    expect(decision.binding_constraint).toBe('long_only_book');
    expect(decision.reasons.join(' ')).not.toMatch(/with no held lot/);
  });

  it('does not refuse a sell EXIT — that is a long being closed, not a short being opened', () => {
    const manager = new RiskManagerImpl(saxoConfig());
    const input = makeInput({
      intent: makeIntent({
        instrument: '3LUS',
        asset_class: 'stocks',
        side: 'sell',
        intent_type: 'exit',
        size: 100,
      }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });

  it('does not refuse a buy entry on a Saxo-venue instrument', () => {
    const manager = new RiskManagerImpl(saxoConfig());
    const input = makeInput({
      intent: makeIntent({
        instrument: '3LUS',
        asset_class: 'stocks',
        side: 'buy',
        intent_type: 'entry',
      }),
    });

    expect(manager.evaluate(input).status).toBe('approved');
  });

  it('does not refuse a sell entry on crypto, which is never a member of long_only_instruments', () => {
    const manager = new RiskManagerImpl(saxoConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'BTC-USD', asset_class: 'crypto', side: 'sell' }),
    });

    expect(manager.evaluate(input).status).toBe('approved');
  });

  it('does not refuse a sell entry on an Alpaca-paper stocks instrument — not in long_only_instruments', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        intent_type: 'entry',
      }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('long_only_book');
  });
});

describe('RiskManagerImpl.evaluate — a partly-valued book (#841)', () => {
  it('refuses an ENTRY sized against a book with an unvalued position in it', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ intent_type: 'entry' }),
      portfolio: makePortfolio({ unvalued_instruments: ['DARK'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('unvalued_book');
    expect(decision.reasons.join(' ')).toMatch(/DARK/);
    expect(decision.order_intent).toBeNull();
  });

  it('lets an EXIT through on the same book — flat-by-close outranks a complete valuation', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ intent_type: 'exit', size: 100 }),
      portfolio: makePortfolio({ unvalued_instruments: ['DARK'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent).toEqual(input.intent);
  });

  it('a scale_in is an entry for this purpose and is refused too', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ intent_type: 'scale_in' }),
      portfolio: makePortfolio({ unvalued_instruments: ['DARK'] }),
    });

    expect(manager.evaluate(input).binding_constraint).toBe('unvalued_book');
  });
});

describe('RiskManagerImpl.evaluate — next_breaker_state pass-through (#203)', () => {
  it('echoes RiskInput.next_breaker_state onto RiskDecision unchanged on an approved entry', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = [
      {
        tier: 'portfolio_drawdown' as const,
        tripped: true,
        tripped_at: new Date('2026-07-10T00:00:00Z'),
        reset_at: null,
        reason: 'portfolio_drawdown_hard',
      },
      {
        tier: 'kill_switch' as const,
        tripped: false,
        tripped_at: null,
        reset_at: null,
        reason: null,
      },
    ];
    const input = makeInput({ next_breaker_state: persisted });

    const decision = manager.evaluate(input);

    expect(decision.next_breaker_state).toBe(persisted);
  });

  it('echoes next_breaker_state on a rejected entry (circuit-breaker gate)', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = makePersistedBreakerState();
    const input = makeInput({
      breakers: makeBreakers({ portfolio_tripped: true }),
      next_breaker_state: persisted,
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.next_breaker_state).toBe(persisted);
  });

  it('echoes next_breaker_state on an exit', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = makePersistedBreakerState();
    const input = makeInput({
      intent: makeIntent({ intent_type: 'exit' }),
      next_breaker_state: persisted,
    });

    const decision = manager.evaluate(input);

    expect(decision.next_breaker_state).toBe(persisted);
  });
});

describe('RiskManagerImpl.evaluate — circuit-breaker gate', () => {
  it('hard-rejects a new entry when the portfolio breaker is tripped', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({ breakers: makeBreakers({ portfolio_tripped: true }) });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.order_intent).toBeNull();
    expect(decision.modifications).toBeNull();
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('hard-rejects a new entry when the relevant asset-class breaker is tripped', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ asset_class: 'stocks' }),
      breakers: makeBreakers({ asset_class_tripped: { crypto: false, stocks: true } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:stocks');
  });

  it('blocks a new entry on an unknown daily figure, but still lets the exit out (#333)', () => {
    const unknown = { known: false, reason: 'no session-open equity observed' } as const;
    const breakers = new CircuitBreakers({
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 4,
      volatility: { baseline: { crypto: 2, stocks: 1 }, multiplier: 2 },
      auto_rearm: { recovery_drawdown_pct: 0.1, max_days_tripped: 5 },
    }).evaluate({
      portfolio: makePortfolio({
        daily_pnl: { crypto: unknown, stocks: unknown, portfolio: unknown },
      }),
      volatility: { crypto: 1, stocks: 0.5 },
      mode: 'live',
      clock: { now: () => new Date('2026-07-15T09:30:00Z') },
    });

    const manager = new RiskManagerImpl(makeConfig());

    const entry = manager.evaluate(makeInput({ breakers }));
    expect(entry.status).toBe('rejected');
    expect(entry.binding_constraint).toBe('circuit_breaker:portfolio');
    expect(entry.reasons.join(' ')).toContain('daily_pnl_unknown:portfolio');

    const exit = manager.evaluate(
      makeInput({ breakers, intent: makeIntent({ intent_type: 'exit' }) }),
    );
    expect(exit.status).toBe('approved');
  });

  it('does not trip on an unrelated asset-class breaker', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ asset_class: 'stocks' }),
      breakers: makeBreakers({ asset_class_tripped: { crypto: true, stocks: false } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
  });
});

describe('RiskManagerImpl.evaluate — trim steps', () => {
  it('trims to the per-trade size cap', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size_fraction_of_equity: 0.05 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(50);
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.modifications).toEqual({
      original_size: 100,
      final_size: 50,
      stop_tightened: false,
    });
  });

  it('trims to the per-asset exposure cap, accounting for existing exposure', () => {
    const manager = new RiskManagerImpl(makeConfig({ per_asset_cap_fraction_of_equity: 0.12 }));
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }),
      portfolio: makePortfolio({ exposure_by_instrument: { AAPL: 5_000 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBe(70);
    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
  });

  it('trims to the per-asset-class exposure cap', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.08 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }),
      portfolio: makePortfolio({ exposure_by_class: { crypto: 0, stocks: 3_000 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBe(50);
    expect(decision.binding_constraint).toBe('per_asset_class_exposure_cap');
  });

  it('trims to the portfolio gross exposure cap', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ portfolio_gross_cap_fraction_of_equity: 0.06 }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }),
      portfolio: makePortfolio({ gross_exposure: 2_000 }),
    });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBe(40);
    expect(decision.binding_constraint).toBe('portfolio_gross_exposure_cap');
  });

  it('trims to the concentration cap when the instrument is correlated with a held one', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap_fraction_of_equity: 0.09, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.82 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBe(50);
    expect(decision.binding_constraint).toBe('concentration_correlation_cap');
  });

  describe('in-flight reservations count as deployed (#1019)', () => {
    it('trims to the per-asset exposure cap against an in-flight order on the same name', () => {
      const manager = new RiskManagerImpl(makeConfig({ per_asset_cap_fraction_of_equity: 0.12 }));
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100 }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { AAPL: 5_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 5_000 },
          reserved_gross_exposure: 5_000,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(70);
      expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
    });

    it('trims to the per-asset-class cap against an in-flight order elsewhere in the class', () => {
      const manager = new RiskManagerImpl(
        makeConfig({ per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.08 } }),
      );
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { MSFT: 3_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 3_000 },
          reserved_gross_exposure: 3_000,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(50);
      expect(decision.binding_constraint).toBe('per_asset_class_exposure_cap');
    });

    it('trims to the portfolio gross cap against an in-flight order', () => {
      const manager = new RiskManagerImpl(
        makeConfig({ portfolio_gross_cap_fraction_of_equity: 0.06 }),
      );
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100 }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { MSFT: 2_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 2_000 },
          reserved_gross_exposure: 2_000,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(40);
      expect(decision.binding_constraint).toBe('portfolio_gross_exposure_cap');
    });

    it('trims to the concentration cap against an in-flight order in the correlated set', () => {
      const manager = new RiskManagerImpl(
        makeConfig({ concentration: { cap_fraction_of_equity: 0.09, threshold: 0.7 } }),
      );
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { MSFT: 4_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 4_000 },
          reserved_gross_exposure: 4_000,
        }),
        correlation: makeCorrelation({ correlations: { MSFT: 0.82 } }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(50);
      expect(decision.binding_constraint).toBe('concentration_correlation_cap');
    });

    it('adds the filled and in-flight halves of one name rather than taking either alone', () => {
      const manager = new RiskManagerImpl(makeConfig({ per_asset_cap_fraction_of_equity: 0.12 }));
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100 }),
        portfolio: makePortfolio({
          exposure_by_instrument: { AAPL: 3_000 },
          reserved_exposure_by_instrument: { AAPL: 2_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 2_000 },
          reserved_gross_exposure: 2_000,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(70);
    });

    it('leaves a book with nothing in flight byte-identical — the reservation is purely additive', () => {
      const manager = new RiskManagerImpl(makeConfig({ per_asset_cap_fraction_of_equity: 0.12 }));
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100 }),
        portfolio: makePortfolio({ exposure_by_instrument: { AAPL: 5_000 } }),
      });

      const decision = manager.evaluate(input);

      expect(decision.order_intent?.size).toBe(70);
      expect(decision.reasons).not.toContainEqual(expect.stringContaining('in_flight_reservation'));
    });

    it('records the reservation on an APPROVED decision no cap bound on, not only on a trim', () => {
      const manager = new RiskManagerImpl(makeConfig());
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100 }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { MSFT: 250 },
          reserved_exposure_by_class: { crypto: 0, stocks: 250 },
          reserved_gross_exposure: 250,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBeNull();
      expect(decision.reasons).toContainEqual(expect.stringContaining('in_flight_reservation'));
      expect(decision.reasons).toContainEqual(expect.stringContaining('MSFT=250'));
    });

    it('an exit still bypasses every cap, reservation or not', () => {
      const manager = new RiskManagerImpl(
        makeConfig({ portfolio_gross_cap_fraction_of_equity: 0.0001 }),
      );
      const input = makeInput({
        intent: makeIntent({ size: 100, entry: 100, intent_type: 'exit' }),
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { AAPL: 500_000 },
          reserved_exposure_by_class: { crypto: 0, stocks: 500_000 },
          reserved_gross_exposure: 500_000,
        }),
      });

      const decision = manager.evaluate(input);

      expect(decision.status).toBe('approved');
      expect(decision.order_intent?.size).toBe(100);
    });
  });

  describe('adopted zero-fill lot reaches a second instrument’s caps (#1568)', () => {
    function makeMarketData(prices: Record<string, number>): MarketDataService {
      const getMark = vi.fn(
        async (instrument: string, _asOf: Date): Promise<Mark> => ({
          price: prices[instrument] ?? 0,
          observed_at: fixedClock.now(),
          source: 'test',
          asset_class: 'stocks',
        }),
      );
      const service: MarketDataService = {
        getBars: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<Bar[]> => []),
        getIndicator: vi.fn(
          async (_i: string, _s: IndicatorSpec, _a: Date): Promise<IndicatorValue> => {
            throw new Error('not used in this test');
          },
        ),
        getMark,
        getMarks: vi.fn(
          async (instruments: readonly string[], at: Date): Promise<Map<string, MarkRead>> =>
            collectMarks((instrument, a) => service.getMark(instrument, a), instruments, at),
        ),
        getSpreadEstimate: vi.fn(async (_i: string, _a: Date): Promise<number | null> => null),
        getQuote: vi.fn(async (_i: string, _a: Date): Promise<null> => null),
        getADV: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<number> => 0),
      };
      return service;
    }

    function makeAdoptedZeroFillPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
      return {
        idempotency_key: 'AAPL-2026-07-15T09:30:00Z',
        debate_id: 'debate-abc123',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        intent_type: 'entry',
        requested_size: 100,
        filled_size: 0,
        avg_entry_price: 0,
        stop: 95,
        target: 110,
        order_state: 'filled',
        broker_order_ids: ['order-1'],
        opened_at: fixedClock.now(),
        decision_timestamp: fixedClock.now(),
        conviction: 0.7,
        converged: true,
        ...overrides,
      };
    }

    it('trims a second instrument’s entry against the first lot’s reservation on the class/gross caps', async () => {
      const portfolio = await computePortfolioView({
        positions: [makeAdoptedZeroFillPosition()],
        marketData: makeMarketData({ AAPL: 100 }),
        asOf: fixedClock.now(),
        clock: fixedClock,
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
        max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
      });

      expect(portfolio.exposure_by_instrument.AAPL ?? 0).toBe(0);
      expect(portfolio.reserved_exposure_by_instrument.AAPL).toBe(10_000);
      expect(portfolio.reserved_exposure_by_class.stocks).toBe(10_000);
      expect(portfolio.reserved_gross_exposure).toBe(10_000);

      const manager = new RiskManagerImpl(
        makeConfig({ portfolio_gross_cap_fraction_of_equity: 0.15 }),
      );
      const decision = manager.evaluate(
        makeInput({
          intent: makeIntent({ instrument: 'MSFT', size: 100, entry: 100 }),
          portfolio,
        }),
      );

      expect(decision.order_intent?.size).toBe(50);
      expect(decision.binding_constraint).toBe('portfolio_gross_exposure_cap');
    });
  });

  it('does not trim on a held instrument whose correlation is below the threshold', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap_fraction_of_equity: 0.09, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.3 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(100);
    expect(decision.binding_constraint).toBeNull();
  });

  it('falls back gracefully (no trim) when correlation history is insufficient (warm-up)', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap_fraction_of_equity: 0.09, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: {} }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(100);
    expect(decision.binding_constraint).toBeNull();
  });

  it('never trims below zero when existing exposure already exceeds a cap', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ per_asset_cap_fraction_of_equity: 0.01, min_viable_size: 100 }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }),
      portfolio: makePortfolio({ exposure_by_instrument: { AAPL: 5_000 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });
});

describe('RiskManagerImpl.evaluate — ordering and monotonicity', () => {
  it('applies checks in documented order — an earlier, tighter cap wins over a later one', () => {
    const manager = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 0.03,
        per_asset_cap_fraction_of_equity: 9.99999,
      }),
    );
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.order_intent?.size).toBe(30);
  });

  it('never increases size relative to the original intent', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size_fraction_of_equity: 0.5 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBeLessThanOrEqual(100);
  });
});

describe('RiskManagerImpl.evaluate — min-viable-size re-check', () => {
  it('rejects with min_viable_size when a mid-pipeline trim pushes size below viable', () => {
    const manager = new RiskManagerImpl(
      makeConfig({
        per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.0005 },
        min_viable_size: 100,
        whole_share_sizing: false,
      }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.order_intent).toBeNull();
    expect(decision.modifications).toBeNull();
    expect(decision.binding_constraint).toBe('min_viable_size');
    expect(decision.reasons.some((r) => r.startsWith('min_viable_size'))).toBe(true);
  });

  it('approves when the trimmed size stays at or above the viable minimum', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size_fraction_of_equity: 0.002, min_viable_size: 100 }),
    );
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 1 }) });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
  });

  it('#740: a size refusal is distinguishable from a conviction (risk-critic) refusal — different binding_constraint tags on otherwise-identical rejected decisions', () => {
    const sizeConfig = makeConfig({
      per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.0005 },
      min_viable_size: 100,
      whole_share_sizing: false,
    });
    const sizeDecision = new RiskManagerImpl(sizeConfig).evaluate(
      makeInput({ intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }) }),
    );

    const convictionDecision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: {
          verdict: 'reject',
          max_notional: null,
          reasoning: 'debate conviction unsupported by the setup precedent',
        },
      }),
    );

    expect(sizeDecision.status).toBe('rejected');
    expect(convictionDecision.status).toBe('rejected');
    expect(sizeDecision.binding_constraint).toBe('min_viable_size');
    expect(convictionDecision.binding_constraint).toBe('risk_critic:reject');
    expect(sizeDecision.binding_constraint).not.toBe(convictionDecision.binding_constraint);
  });
});

describe('RiskManagerImpl.evaluate — audit fields', () => {
  it('attaches reason codes to every reject and modify', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size_fraction_of_equity: 0.05 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons[0]).toContain('per_trade_size_cap');
  });

  it('includes a risk_snapshot with exposure, drawdown, and armed breakers', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      portfolio: makePortfolio({
        exposure_by_instrument: { AAPL: 1_000 },
        exposure_by_class: { crypto: 0, stocks: 1_000 },
        gross_exposure: 1_000,
        drawdown_pct: 0.05,
      }),
      breakers: makeBreakers({ armed_breakers: ['crypto_daily_loss_soft'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.risk_snapshot.exposure.AAPL).toBe(1_000);
    expect(decision.risk_snapshot.exposure.stocks).toBe(1_000);
    expect(decision.risk_snapshot.exposure.portfolio).toBe(1_000);
    expect(decision.risk_snapshot.drawdown_pct).toBe(0.05);
    expect(decision.risk_snapshot.armed_breakers).toEqual(['crypto_daily_loss_soft']);
  });
});

describe('RiskManagerImpl.evaluate — CII soft signal (#205)', () => {
  it('fires macro_risk_flag when the mapped country is above the absolute threshold', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 85 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
  });

  it('does not fire when the country is at or below the threshold', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 70 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('does not fire for an instrument absent from the static country mapping', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      cii: { RU: 99 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('does not fire when the mapped country has no cached score', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: {},
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('fires every cycle a sustained high CII level is evaluated, not just on change', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 90 },
    });

    const first = manager.evaluate(input);
    const second = manager.evaluate(input);

    expect(first.warnings).toEqual(['macro_risk_flag:RU']);
    expect(second.warnings).toEqual(['macro_risk_flag:RU']);
  });

  it('never appears in binding_constraint or changes status/order_intent when it fires alongside a trim', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ cii_threshold: 70, max_position_size_fraction_of_equity: 0.05 }),
    );
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX', size: 100, entry: 100 }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(50);
  });

  it('still attaches the warning to an exit, which otherwise bypasses all entry gates', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX', intent_type: 'exit' }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });

  it('never appears in binding_constraint when a breaker rejects the intent', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      breakers: makeBreakers({ portfolio_tripped: true }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });
});

describe('RiskManagerImpl.evaluate — correlation warm-up warning (#303)', () => {
  it('warns for each held instrument with insufficient overlapping history', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000, TSLA: 3_000 } }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT', 'TSLA'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['correlation_warmup:MSFT', 'correlation_warmup:TSLA']);
  });

  it('does not warn when every held pair has enough history', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.1 }, insufficient_history: [] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('distinguishes a measured near-zero correlation from an unmeasurable pair', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const measured = manager.evaluate(
      makeInput({
        intent: makeIntent({ instrument: 'AAPL' }),
        portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
        correlation: makeCorrelation({ correlations: { MSFT: 0.0 }, insufficient_history: [] }),
      }),
    );
    const unmeasurable = manager.evaluate(
      makeInput({
        intent: makeIntent({ instrument: 'AAPL' }),
        portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
        correlation: makeCorrelation({ correlations: {}, insufficient_history: ['MSFT'] }),
      }),
    );

    expect(measured.warnings).toEqual([]);
    expect(unmeasurable.warnings).toEqual(['correlation_warmup:MSFT']);
    expect(measured.order_intent?.size).toBe(unmeasurable.order_intent?.size);
  });

  it('flags every peer of a six-instrument day-1 portfolio rather than reading as diversified', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap_fraction_of_equity: 0.09, threshold: 0.7 } }),
    );
    const peers = ['QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD'];
    const input = makeInput({
      intent: makeIntent({ instrument: 'SPY', size: 100, entry: 100 }),
      portfolio: makePortfolio({
        exposure_by_instrument: Object.fromEntries(peers.map((p) => [p, 4_000])),
      }),
      correlation: makeCorrelation({ correlations: {}, insufficient_history: peers }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.order_intent?.size).toBe(100);
    expect(decision.warnings).toEqual(peers.map((p) => `correlation_warmup:${p}`));
  });

  it('attaches the warm-up warning alongside a CII flag without displacing it', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 90 },
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU', 'correlation_warmup:MSFT']);
  });

  it('attaches the warm-up warning to a breaker rejection too', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      breakers: makeBreakers({ portfolio_tripped: true }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.warnings).toEqual(['correlation_warmup:MSFT']);
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('attaches the warm-up warning to an exit, which bypasses every entry gate', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL', intent_type: 'exit' }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.warnings).toEqual(['correlation_warmup:MSFT']);
  });
});

describe('RiskManagerImpl.evaluate — live risk thresholds (#433)', () => {
  function liveThresholds(initial: Record<string, number> = {}) {
    const thresholds = { ...initial };
    return {
      source: { getRiskThresholds: () => ({ ...thresholds }) },
      tighten(name: string, value: number) {
        thresholds[name] = value;
      },
    };
  }

  it('binds the tightened cap, not the constructor one', () => {
    const { source, tighten } = liveThresholds();
    const manager = new RiskManagerImpl(makeConfig(), source);
    expect(manager.evaluate(makeInput()).modifications?.final_size).toBe(100);

    tighten('max_position_size_fraction_of_equity', 0.05);
    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(50);
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
  });

  it('picks up a tightening applied BETWEEN two evaluations', () => {
    const { source, tighten } = liveThresholds();
    const manager = new RiskManagerImpl(makeConfig(), source);

    const before = manager.evaluate(makeInput());
    tighten('portfolio_gross_cap_fraction_of_equity', 0.02);
    const after = manager.evaluate(makeInput());

    expect(before.modifications?.final_size).toBe(100);
    expect(after.modifications?.final_size).toBe(20);
    expect(after.binding_constraint).toBe('portfolio_gross_exposure_cap');
  });

  it('tightens the per-asset-class cap through the nested field', () => {
    const { source } = liveThresholds({ per_asset_class_cap_fraction_of_equity_stocks: 0.04 });
    const manager = new RiskManagerImpl(makeConfig(), source);

    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(40);
    expect(decision.binding_constraint).toBe('per_asset_class_exposure_cap');
  });

  it('falls back to the static config for a threshold the table has no row for', () => {
    const { source } = liveThresholds({ max_position_size_fraction_of_equity: 0.05 });
    const manager = new RiskManagerImpl(
      makeConfig({ per_asset_cap_fraction_of_equity: 0.03 }),
      source,
    );

    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(30);
    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
  });

  it('behaves exactly as before when no source is supplied', () => {
    const withoutSource = new RiskManagerImpl(
      makeConfig({ max_position_size_fraction_of_equity: 0.05 }),
    );
    const withEmptySource = new RiskManagerImpl(
      makeConfig({ max_position_size_fraction_of_equity: 0.05 }),
      {
        getRiskThresholds: () => ({}),
      },
    );

    expect(withoutSource.evaluate(makeInput()).modifications?.final_size).toBe(
      withEmptySource.evaluate(makeInput()).modifications?.final_size,
    );
  });

  it('ignores a corrupt row rather than letting it disable the cap', () => {
    const { source } = liveThresholds({ max_position_size_fraction_of_equity: Number.NaN });
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size_fraction_of_equity: 0.05 }),
      source,
    );

    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(50);
  });
});

describe('RiskManagerImpl.evaluate — risk-critic skip record (review 2026-08-06 B3)', () => {
  it('records an explicit skip reason when no critic verdict was supplied', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(makeInput());

    expect(decision.status).toBe('approved');
    expect(decision.reasons.some((reason) => reason.includes('risk_critic: skipped'))).toBe(true);
  });

  it('does not record the skip reason when a critic verdict is present', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: { verdict: 'pass', max_notional: null, reasoning: 'fine' },
      }),
    );

    expect(decision.reasons.some((reason) => reason.includes('risk_critic: skipped'))).toBe(false);
  });

  it('#957: a critic trim below the dust floor is still attributable to the critic in `reasons`', () => {
    const decision = new RiskManagerImpl(makeConfig({ min_viable_size: 100 })).evaluate(
      makeInput({
        critic: { verdict: 'trim', max_notional: 50, reasoning: 'headline risk into the close' },
      }),
    );

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size:quantised');
    expect(
      decision.reasons.some((reason) =>
        reason.includes('risk_critic: trimmed notional from 10000 to 50'),
      ),
    ).toBe(true);
  });
});

describe('RiskManagerImpl.evaluate — invalidation conditions (#994, per #997)', () => {
  const conditionOn = (
    state: 'breached' | 'not_breached' | 'unevaluable',
    id = 'thesis-needs-price-above-95',
  ): EvaluatedCondition => ({
    condition: {
      id,
      observable: { kind: 'mark' },
      comparator: '<',
      threshold: 95,
      rationale: 'below 95 the breakout that justified the entry has already failed',
    },
    state,
    observed: state === 'unevaluable' ? null : 90,
  });

  it('hard-rejects a MEASURED breach even when the prose verdict says pass', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: {
          verdict: 'pass',
          max_notional: null,
          reasoning: 'no narrative risk',
          conditions: [conditionOn('breached')],
        },
      }),
    );

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe(INVALIDATED_BINDING_CONSTRAINT);
    expect(decision.binding_constraint).not.toBe('risk_critic:reject');
  });

  it('rejects on a breach with every OTHER producer failed open — the mechanical steps are clean', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        cii: {},
        correlation: { correlations: {}, insufficient_history: ['3LQQ'] },
        critic: {
          verdict: 'pass',
          max_notional: null,
          reasoning: 'nothing narrative',
          conditions: [conditionOn('breached')],
        },
      }),
    );

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe(INVALIDATED_BINDING_CONSTRAINT);
  });

  it('does NOT reject on an unevaluable condition — a data gap must never block a trade', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: {
          verdict: 'pass',
          max_notional: null,
          reasoning: 'nothing narrative',
          conditions: [conditionOn('unevaluable')],
        },
      }),
    );

    expect(decision.status).toBe('approved');
    expect(decision.reasons.some((reason) => reason.includes('unevaluable'))).toBe(true);
  });

  it('keeps risk_critic:reject for a PROSE reject, and still records the condition states', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: {
          verdict: 'reject',
          max_notional: null,
          reasoning: 'the catalyst is already priced',
          conditions: [conditionOn('breached')],
        },
      }),
    );

    expect(decision.binding_constraint).toBe('risk_critic:reject');
    expect(decision.reasons.some((reason) => reason.includes('breached'))).toBe(true);
  });

  it('records no_conditions when the conditions half produced nothing, and enforces nothing', () => {
    const decision = new RiskManagerImpl(makeConfig()).evaluate(
      makeInput({
        critic: {
          verdict: 'pass',
          max_notional: null,
          reasoning: 'nothing narrative',
          conditions: [],
          dropped_conditions: [{ id: 'c2', raw: '{"kind":"runes"}', reason: 'unknown_observable' }],
        },
      }),
    );

    expect(decision.status).toBe('approved');
    expect(decision.reasons).toContain(NO_CONDITIONS_REASON);
    expect(decision.reasons.some((reason) => reason.includes('unknown_observable'))).toBe(true);
  });

  it('replays a PRE-FOLD verdict — no `conditions` field — to the same DECISION, plus one reason line', () => {
    const preFold: RiskCriticVerdict = {
      verdict: 'pass',
      max_notional: null,
      reasoning: 'nothing narrative',
    };

    const decision = new RiskManagerImpl(makeConfig()).evaluate(makeInput({ critic: preFold }));

    const preFoldReasons = decision.reasons.filter((reason) => reason !== NO_CONDITIONS_REASON);
    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications).toEqual({
      original_size: 100,
      final_size: 100,
      stop_tightened: false,
    });
    expect(decision.order_intent?.size).toBe(makeInput().intent.size);
    expect(decision.reasons).toEqual([NO_CONDITIONS_REASON]);
    expect(preFoldReasons).toEqual([]);
  });
});

describe('RiskManagerImpl.evaluate — exit bypasses the live threshold clamp (#766)', () => {
  it('approves an exit even when the live risk_thresholds table has an out-of-bound row', () => {
    const manager = new RiskManagerImpl(makeConfig(), {
      getRiskThresholds: () => ({ max_pbo: 0.5 }),
    });

    const decision = manager.evaluate(makeInput({ intent: makeIntent({ intent_type: 'exit' }) }));

    expect(decision.status).toBe('approved');
  });

  it('still refuses an ENTRY when the live risk_thresholds table has an out-of-bound row', () => {
    const manager = new RiskManagerImpl(makeConfig(), {
      getRiskThresholds: () => ({ max_pbo: 0.5 }),
    });

    expect(() => manager.evaluate(makeInput())).toThrow(/in-code clamp/);
  });

  it("leaves an exit's cii_threshold-driven warnings unchanged whether or not the table is consulted", () => {
    const withoutSource = new RiskManagerImpl(makeConfig({ cii_threshold: 70 })).evaluate(
      makeInput({ intent: makeIntent({ intent_type: 'exit' }) }),
    );
    const withSource = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }), {
      getRiskThresholds: () => ({ max_position_size_fraction_of_equity: 0.05 }),
    }).evaluate(makeInput({ intent: makeIntent({ intent_type: 'exit' }) }));

    expect(withSource.warnings).toEqual(withoutSource.warnings);
  });
});

describe('whole-share sizing (#941)', () => {
  const trimmingConfig = (whole: boolean) =>
    makeConfig({ max_position_size_fraction_of_equity: 0.07145, whole_share_sizing: whole });

  it('floors a trimmed size to whole shares', () => {
    const decision = new RiskManagerImpl(trimmingConfig(true)).evaluate(makeInput());

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(71);
    expect(decision.modifications?.final_size).toBe(71);
    expect(decision.modifications?.original_size).toBe(100);
  });

  it('leaves the trimmed size fractional when the flag is off', () => {
    const decision = new RiskManagerImpl(trimmingConfig(false)).evaluate(makeInput());

    expect(decision.order_intent?.size).toBeCloseTo(71.45, 10);
  });

  it('deploys no more notional than the cap allowed', () => {
    const decision = new RiskManagerImpl(trimmingConfig(true)).evaluate(makeInput());

    expect((decision.order_intent?.size ?? 0) * 100).toBeLessThanOrEqual(7_145);
  });

  it('returns an untrimmed size verbatim rather than round-tripping it through the notional', () => {
    const decision = new RiskManagerImpl(
      makeConfig({ whole_share_sizing: true, min_viable_size: 0.1 }),
    ).evaluate(makeInput({ intent: makeIntent({ size: 3, entry: 0.35, stop: 0.3, target: 0.4 }) }));

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(3);
  });

  it('rejects a trim that leaves less than one whole share', () => {
    const decision = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 0.0024,
        min_viable_size: 10,
        whole_share_sizing: true,
      }),
    ).evaluate(makeInput({ intent: makeIntent({ size: 5, entry: 300 }) }));

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('whole_share_sizing:rounds_to_zero');
    expect(decision.order_intent).toBeNull();
  });

  it('approves that same sub-one-share trim when the flag is off', () => {
    const decision = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 0.0024,
        min_viable_size: 10,
        whole_share_sizing: false,
      }),
    ).evaluate(makeInput({ intent: makeIntent({ size: 5, entry: 300 }) }));

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBeCloseTo(0.8, 10);
  });

  it('re-tests the dust floor on the QUANTISED notional, not the pre-floor one', () => {
    const decision = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 0.0011,
        min_viable_size: 100,
        whole_share_sizing: true,
      }),
    ).evaluate(makeInput({ intent: makeIntent({ size: 5, entry: 60 }) }));

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size:quantised');
  });

  it('approves that same order when the grid is off — the pre-floor notional was viable', () => {
    const decision = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 0.0011,
        min_viable_size: 100,
        whole_share_sizing: false,
      }),
    ).evaluate(makeInput({ intent: makeIntent({ size: 5, entry: 60 }) }));

    expect(decision.status).toBe('approved');
  });

  it('records the floor in `reasons` — `modifications` alone cannot attribute it', () => {
    const decision = new RiskManagerImpl(trimmingConfig(true)).evaluate(makeInput());

    expect(decision.reasons.some((r) => r.startsWith('whole_share_sizing: floored size'))).toBe(
      true,
    );
  });

  it('records no floor when the grid did not move the size', () => {
    const decision = new RiskManagerImpl(makeConfig({ whole_share_sizing: true })).evaluate(
      makeInput(),
    );

    expect(decision.reasons.some((r) => r.startsWith('whole_share_sizing:'))).toBe(false);
  });

  it('never quantises an exit', () => {
    const decision = new RiskManagerImpl(makeConfig({ whole_share_sizing: true })).evaluate(
      makeInput({ intent: makeIntent({ intent_type: 'exit', size: 10.5 }) }),
    );

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(10.5);
  });
});

describe('RiskManagerImpl.evaluate — exact gate boundaries and reasons', () => {
  const evaluate = (config: Partial<RiskConfig>, input: Partial<RiskInput> = {}) =>
    new RiskManagerImpl(makeConfig(config)).evaluate(makeInput(input));

  const thrownBy = (run: () => unknown): PerSubclassCapUnresolvableError => {
    try {
      run();
    } catch (error) {
      if (error instanceof PerSubclassCapUnresolvableError) return error;
      throw error;
    }
    throw new Error('expected a PerSubclassCapUnresolvableError');
  };

  it('records the verbatim exit pass-through reason', () => {
    const decision = evaluate({}, { intent: makeIntent({ intent_type: 'exit' }) });

    expect(decision.reasons).toEqual(['exit: bypasses all entry gates, passes through verbatim']);
  });

  it('names every unvalued instrument in the unvalued_book refusal', () => {
    const decision = evaluate(
      {},
      { portfolio: makePortfolio({ unvalued_instruments: ['X', 'Y'] }) },
    );

    expect(decision.reasons).toEqual([
      'unvalued_book: 2 held instrument(s) could not be valued (X, Y), so every exposure cap ' +
        'below would read them as zero exposure and allow a larger entry than the book ' +
        'supports. Exits are unaffected (they return above this line).',
    ]);
  });

  it('spells out each in-flight reservation in the reasons', () => {
    const decision = evaluate(
      {},
      {
        portfolio: makePortfolio({
          reserved_exposure_by_instrument: { MSFT: 300, NVDA: 200 },
          reserved_gross_exposure: 500,
        }),
      },
    );

    expect(decision.reasons[0]).toBe(
      'in_flight_reservation: 500 of submitted-but-unfilled notional counts as deployed ' +
        'against every cap below (MSFT=300, NVDA=200)',
    );
  });

  it('does not trim a notional that sits exactly on a cap', () => {
    const decision = evaluate({ max_position_size_fraction_of_equity: 0.1 });

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.reasons).toEqual([
      'risk_critic: skipped — no critic verdict was supplied for this evaluation',
    ]);
  });

  it('counts a correlation exactly at the threshold as concentrated', () => {
    const decision = evaluate(
      { concentration: { cap_fraction_of_equity: 0.05, threshold: 0.7 } },
      { correlation: makeCorrelation({ correlations: { MSFT: -0.7 } }) },
    );

    expect(decision.binding_constraint).toBe('concentration_correlation_cap');
    expect(decision.modifications?.final_size).toBe(50);
  });

  it('raises no macro flag for an instrument with no mapped country', () => {
    const decision = evaluate({}, { cii: { null: 99 } });

    expect(decision.warnings).toEqual([]);
  });

  it('names the PerSubclassCapUnresolvableError class', () => {
    expect(new PerSubclassCapUnresolvableError('m', 'AAPL', 'b').name).toBe(
      'PerSubclassCapUnresolvableError',
    );
  });

  describe('risk critic', () => {
    it('records a prose reject verbatim', () => {
      const decision = evaluate(
        {},
        { critic: { verdict: 'reject', max_notional: null, reasoning: 'earnings tonight' } },
      );

      expect(decision.binding_constraint).toBe('risk_critic:reject');
      expect(decision.reasons).toContain('risk_critic: earnings tonight');
    });

    it.each(['pass', 'unavailable'] as const)(
      'never trims on a %s verdict, even one carrying a max_notional',
      (verdict) => {
        const decision = evaluate({}, { critic: { verdict, max_notional: 500, reasoning: 'x' } });

        expect(decision.status).toBe('approved');
        expect(decision.binding_constraint).toBeNull();
        expect(decision.modifications?.final_size).toBe(100);
      },
    );

    it('binds risk_critic:trim when the critic cap is below the notional', () => {
      const decision = evaluate(
        {},
        { critic: { verdict: 'trim', max_notional: 5_000, reasoning: 'thin book' } },
      );

      expect(decision.binding_constraint).toBe('risk_critic:trim');
      expect(decision.modifications?.final_size).toBe(50);
      expect(decision.reasons).toContain(
        'risk_critic: trimmed notional from 10000 to 5000 (thin book)',
      );
    });

    it.each([10_000, 20_000])(
      'leaves the notional alone when the critic cap (%s) is at or above it',
      (cap) => {
        const decision = evaluate(
          {},
          { critic: { verdict: 'trim', max_notional: cap, reasoning: 'fine' } },
        );

        expect(decision.status).toBe('approved');
        expect(decision.binding_constraint).toBeNull();
        expect(decision.modifications?.final_size).toBe(100);
        expect(decision.reasons.some((reason) => reason.startsWith('risk_critic: trimmed'))).toBe(
          false,
        );
      },
    );
  });

  describe('whole-share and quantised floors', () => {
    it('words the rounds-to-zero refusal exactly', () => {
      const decision = evaluate(
        { whole_share_sizing: true },
        {
          intent: makeIntent({ size: 10, entry: 1_000 }),
          critic: { verdict: 'trim', max_notional: 500, reasoning: 'r' },
        },
      );

      expect(decision.binding_constraint).toBe('whole_share_sizing:rounds_to_zero');
      expect(decision.reasons.at(-1)).toBe(
        'whole_share_sizing: trimmed notional 500 at entry 1000 is less than one whole share',
      );
    });

    it('words the quantised min-viable refusal exactly', () => {
      const decision = evaluate(
        { whole_share_sizing: true, min_viable_size: 600 },
        {
          intent: makeIntent({ size: 10, entry: 400 }),
          critic: { verdict: 'trim', max_notional: 700, reasoning: 'r' },
        },
      );

      expect(decision.binding_constraint).toBe('min_viable_size:quantised');
      expect(decision.reasons.at(-1)).toBe(
        'min_viable_size: quantised notional 400 below viable minimum 600',
      );
    });
  });

  describe('live_book_ceiling', () => {
    const ceiling = (same_currency_verified?: boolean) => ({
      live_book_ceiling: {
        book: 100_000,
        refuse_above_tolerance: 0.05,
        ...(same_currency_verified === undefined ? {} : { same_currency_verified }),
      },
    });
    const atEquity = (equity: number) => ({ portfolio: makePortfolio({ equity }) });

    it('refuses to arm until the currencies are verified, naming the instrument', () => {
      const error = thrownBy(() => evaluate(ceiling(), atEquity(50_000)));

      expect(error.instrument).toBe('AAPL');
      expect(error.bindingConstraint).toBe('live_book_ceiling:currency_mismatch:AAPL');
      expect(error.message).toBe(
        'live_book_ceiling: currency mismatch, cannot verify funding — ' +
          "live_book_ceiling's declared book (100000) is GBP but portfolio.equity " +
          "(50000) is read from Alpaca's USD-denominated GET /v2/account. #1180 added " +
          'a configured GBP->USD rate for the SIZING inlet and deliberately did not arm this ' +
          "comparison with it: a rate error is proportional at the Trader's ask and absolute here, " +
          'where it decides a total refusal against a few percent of tolerance. So this ' +
          'account-level check (#888 review fix-up, arms regardless of whether any instrument is ' +
          'D5-classified yet) refuses to arm rather than silently compare GBP to USD. Resolve with ' +
          "a live FX-rate feed, or by running a venue whose account read reports the book's own " +
          'currency — Saxo GET /port/v1/balances, wired as saxoFunding (#1509), which arms ' +
          'live_book_ceiling.same_currency_verified via armSameCurrencyCeilings when it does.',
      );
    });

    it('refuses an account funded past the tolerance above the book', () => {
      const error = thrownBy(() => evaluate(ceiling(true), atEquity(105_001)));

      expect(error.bindingConstraint).toBe('live_book_ceiling:equity_exceeds_book:AAPL');
      expect(error.message).toBe(
        "live_book_ceiling's declared book is 100000 but portfolio.equity is 105001, more " +
          'than 5% above it. This account-level check (#888 review fix-up) arms regardless of ' +
          'whether any instrument is D5-classified yet — an account funded this far past the ' +
          'declared book invalidates every sizing assumption built on that book, not just a ' +
          "classified subclass's. Refusing to size this entry — re-fund the account down to " +
          'the declared book, or raise the book deliberately.',
      );
    });

    it.each([95_000, 105_000])(
      'passes a verified account at equity %s without binding',
      (equity) => {
        const decision = evaluate(ceiling(true), atEquity(equity));

        expect(decision.status).toBe('approved');
        expect(decision.binding_constraint).toBeNull();
      },
    );

    it('scales the refusal line with the book, not against it', () => {
      const wideCeiling = {
        live_book_ceiling: { book: 10, refuse_above_tolerance: 1, same_currency_verified: true },
      };

      expect(() => evaluate(wideCeiling, atEquity(20))).not.toThrow();
      expect(() => evaluate(wideCeiling, atEquity(21))).toThrow(PerSubclassCapUnresolvableError);
    });
  });
});
