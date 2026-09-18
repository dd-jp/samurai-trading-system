import {
  AlwaysOpenCalendar,
  type Mark,
  type MarketDataService,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import type { BreakerState, RiskDecision } from '../risk-manager/index.js';
import { VerdictImpl } from './index.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  PositionStore,
  VerdictConfig,
  VerdictInput,
} from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const fixedClock: Clock = { now: () => NOW };

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    decided_at: new Date('2026-07-15T13:55:00Z'),
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

function makeRiskDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  const orderIntent = makeIntent();
  return {
    status: 'approved',
    order_intent: orderIntent,
    modifications: { original_size: 100, final_size: 100, stop_tightened: false },
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
    warnings: [],
    next_breaker_state: [],
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

function makeConfig(overrides: Partial<VerdictConfig> = {}): VerdictConfig {
  return {
    automation_level: { crypto: 'manual', stocks: 'manual' },
    max_signal_age: { crypto: 5 * 60_000, stocks: 30 * 60_000 },
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    drift_tolerance_pct: { crypto: 0.01, stocks: 0.01 },
    human_timeout: 5 * 60_000,
    allow_extended_hours: false,
    flag_thresholds: { size_over: 10_000 },
    ...overrides,
  };
}

function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    price: 100,
    observed_at: NOW,
    source: 'test',
    asset_class: 'stocks',
    ...overrides,
  };
}

function makeMarketData(mark: Mark = makeMark()): MarketDataService {
  return {
    getBars: vi.fn(),
    getIndicator: vi.fn(),
    getMark: vi.fn().mockResolvedValue(mark),
    getSpreadEstimate: vi.fn(),
    getADV: vi.fn(),
  } as unknown as MarketDataService;
}

const SESSION_BOUNDARY = new AlwaysOpenCalendar();

function makeTradingCalendar(isOpen = true): TradingCalendar {
  return {
    isOpen: () => isOpen,
    isTradingDay: () => true,
    sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
    sessionEnd: () => null,
  };
}

function makePositionStore(exists = false): PositionStore {
  return { findByKey: vi.fn().mockResolvedValue(exists) };
}

function makeApprovals(outcome: ApprovalOutcome = 'approved'): ApprovalChannel {
  return { requestApproval: vi.fn().mockResolvedValue(outcome) };
}

function makeInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    trace_id: 'trace-1',
    risk_decision: makeRiskDecision(),
    clock: fixedClock,
    marketData: makeMarketData(),
    tradingCalendar: makeTradingCalendar(),
    positionStore: makePositionStore(),
    breakers: makeBreakers(),
    config: makeConfig(),
    mode: 'live',
    approvals: makeApprovals(),
    ...overrides,
  };
}

describe('VerdictImpl.decide — full pass', () => {
  it('produces go when every gate passes and the human approves', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(makeInput());

    expect(decision.status).toBe('go');
    expect(decision.order).toEqual(makeIntent());
    expect(decision.no_go_reason).toBeNull();
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
    expect(decision.idempotency_key).toBe('AAPL-2026-07-15T13:55:00Z');
    expect(decision.timestamp).toEqual(NOW);
  });
});

describe('VerdictImpl.decide — staleness gate', () => {
  it('no-go with staleness when the signal has aged past max_signal_age', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decided_at: new Date('2026-07-15T13:00:00Z') }),
      }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
    expect(decision.order).toBeNull();
  });

  it('records the signal age it measured and the bound it broke (#1111)', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        risk_decision: makeRiskDecision({
          order_intent: makeIntent({ decided_at: new Date('2026-07-15T13:00:00Z') }),
        }),
      }),
    );

    expect(decision.no_go_detail).toEqual({ measured_ms: 60 * 60_000, bound_ms: 30 * 60_000 });
  });

  describe('decided_at vs the bar-floored decision_timestamp (#1190)', () => {
    const BAR = new Date('2026-07-15T13:00:00Z');
    const SHIPPED_CONFIG = makeConfig({
      automation_level: { crypto: 'auto', stocks: 'auto' },
      max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 },
    });

    it('a tick at bar+61min no longer no-goes on staleness when the decision itself is fresh', async () => {
      const verdict = new VerdictImpl();
      const decidedAt = new Date('2026-07-15T13:59:00Z');
      const tickNow = new Date('2026-07-15T14:01:00Z');

      const decision = await verdict.decide(
        makeInput({
          clock: { now: () => tickNow },
          config: SHIPPED_CONFIG,
          marketData: makeMarketData(makeMark({ observed_at: tickNow })),
          risk_decision: makeRiskDecision({
            order_intent: makeIntent({ decision_timestamp: BAR, decided_at: decidedAt }),
          }),
        }),
      );

      expect(decision.status).toBe('go');
      expect(decision.no_go_reason).toBeNull();
    });

    it('a genuinely stale decision still no-goes on staleness even with a fresh bar coordinate', async () => {
      const verdict = new VerdictImpl();
      const tickNow = new Date('2026-07-15T13:05:00Z');
      const decidedAt = new Date('2026-07-15T12:00:00Z');

      const decision = await verdict.decide(
        makeInput({
          clock: { now: () => tickNow },
          config: SHIPPED_CONFIG,
          marketData: makeMarketData(makeMark({ observed_at: tickNow })),
          risk_decision: makeRiskDecision({
            order_intent: makeIntent({ decision_timestamp: BAR, decided_at: decidedAt }),
          }),
        }),
      );

      expect(decision.status).toBe('no_go');
      expect(decision.no_go_reason).toBe('staleness');
    });

    it('treats a decision shortly after its bar opens the same as one 55 minutes in, when equally fresh', async () => {
      const verdict = new VerdictImpl();
      const runAt = (decidedAt: Date) => {
        const tickNow = new Date(decidedAt.getTime() + 5_000);
        return verdict.decide(
          makeInput({
            clock: { now: () => tickNow },
            config: SHIPPED_CONFIG,
            marketData: makeMarketData(makeMark({ observed_at: tickNow })),
            risk_decision: makeRiskDecision({
              order_intent: makeIntent({ decision_timestamp: BAR, decided_at: decidedAt }),
            }),
          }),
        );
      };

      const earlyInBar = await runAt(new Date(BAR.getTime() + 60_000));
      const lateInBar = await runAt(new Date(BAR.getTime() + 55 * 60_000));

      expect(earlyInBar.status).toBe('go');
      expect(lateInBar.status).toBe('go');
      expect(earlyInBar.no_go_reason).toBe(lateInBar.no_go_reason);
    });
  });
});

describe('VerdictImpl.decide — stale_feed gate (#641)', () => {
  it('no-go with stale_feed when the mark was observed past max_mark_age', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      marketData: makeMarketData(makeMark({ observed_at: new Date(NOW.getTime() - 20 * 60_000) })),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('stale_feed');
    expect(decision.order).toBeNull();
  });

  it('is a DIFFERENT gate from staleness — a fresh decision on a dead feed', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        config: makeConfig({ max_signal_age: { crypto: 60 * 60_000, stocks: 60 * 60_000 } }),
        marketData: makeMarketData(
          makeMark({ observed_at: new Date(NOW.getTime() - 20 * 60_000) }),
        ),
      }),
    );

    expect(decision.no_go_reason).toBe('stale_feed');
  });

  it('reads the bound for the intent’s own asset class', async () => {
    const verdict = new VerdictImpl();
    const staleMark = makeMark({ observed_at: new Date(NOW.getTime() - 5 * 60_000) });

    const asStocks = await verdict.decide(makeInput({ marketData: makeMarketData(staleMark) }));
    const asCrypto = await verdict.decide(
      makeInput({
        risk_decision: makeRiskDecision({ order_intent: makeIntent({ asset_class: 'crypto' }) }),
        marketData: makeMarketData(staleMark),
      }),
    );

    expect(asStocks.no_go_reason).not.toBe('stale_feed');
    expect(asCrypto.no_go_reason).toBe('stale_feed');
  });

  it('runs BEFORE the drift gate, so a dead feed is not misreported as drift', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        marketData: makeMarketData(
          makeMark({ price: 105, observed_at: new Date(NOW.getTime() - 20 * 60_000) }),
        ),
      }),
    );

    expect(decision.no_go_reason).toBe('stale_feed');
  });

  it('no-go with stale_feed when the mark is observed AHEAD of our clock', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        marketData: makeMarketData(
          makeMark({ observed_at: new Date(NOW.getTime() + 10 * 60_000) }),
        ),
      }),
    );

    expect(decision.no_go_reason).toBe('stale_feed');
  });

  describe('freshness is judged at the read instant, not the gate instant (#1111)', () => {
    function slowFetchClock(fetchMs: number): Clock {
      let issued = false;
      return {
        now: () => {
          if (!issued) {
            issued = true;
            return NOW;
          }
          return new Date(NOW.getTime() + fetchMs);
        },
      };
    }

    it('passes a mark stamped 80s after the gate instant when the fetch took that long', async () => {
      const verdict = new VerdictImpl();
      const decision = await verdict.decide(
        makeInput({
          config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
          clock: slowFetchClock(83_993),
          marketData: makeMarketData(makeMark({ observed_at: new Date(NOW.getTime() + 83_793) })),
        }),
      );

      expect(decision.no_go_reason).toBeNull();
      expect(decision.status).toBe('go');
    });

    it('still refuses a mark stamped ahead of the READ instant', async () => {
      const verdict = new VerdictImpl();
      const decision = await verdict.decide(
        makeInput({
          clock: slowFetchClock(83_993),
          marketData: makeMarketData(
            makeMark({ observed_at: new Date(NOW.getTime() + 83_993 + 60_000) }),
          ),
        }),
      );

      expect(decision.no_go_reason).toBe('stale_feed');
      expect(decision.no_go_detail).toEqual({ measured_ms: -60_000, bound_ms: 5_000 });
    });

    it('still refuses a mark genuinely past its bound after a slow fetch', async () => {
      const verdict = new VerdictImpl();
      const decision = await verdict.decide(
        makeInput({
          clock: slowFetchClock(83_993),
          marketData: makeMarketData(
            makeMark({ observed_at: new Date(NOW.getTime() - 20 * 60_000) }),
          ),
        }),
      );

      expect(decision.no_go_reason).toBe('stale_feed');
      expect(decision.no_go_detail).toEqual({
        measured_ms: 20 * 60_000 + 83_993,
        bound_ms: 15 * 60_000,
      });
    });
  });

  it('records what the gate measured and the bound it broke (#1111)', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        marketData: makeMarketData(
          makeMark({ observed_at: new Date(NOW.getTime() - 20 * 60_000) }),
        ),
      }),
    );

    expect(decision.no_go_detail).toEqual({ measured_ms: 20 * 60_000, bound_ms: 15 * 60_000 });
  });

  it('passes a fresh mark through to the later gates', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
        marketData: makeMarketData(makeMark({ observed_at: new Date(NOW.getTime() - 60_000) })),
      }),
    );

    expect(decision.status).toBe('go');
    expect(decision.no_go_reason).toBeNull();
  });
});

describe('VerdictImpl.decide — drift gate', () => {
  it('no-go with drift when current price has moved past tolerance from entry', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      marketData: makeMarketData(makeMark({ price: 105 })),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('drift');
  });

  describe('per-asset-class fractional tolerance (#381)', () => {
    const PAPER_PCT = { crypto: 0.005, stocks: 0.005 };

    it('fires on a $200 equity that the old absolute 500 could never have caught', async () => {
      const verdict = new VerdictImpl();
      const entry = 200;
      const price = 250;

      expect(Math.abs(price - entry)).toBeLessThan(500);

      const input = makeInput({
        risk_decision: makeRiskDecision({
          order_intent: makeIntent({ instrument: 'AAPL', asset_class: 'stocks', entry }),
        }),
        marketData: makeMarketData(makeMark({ price })),
        config: makeConfig({ drift_tolerance_pct: PAPER_PCT }),
      });

      const decision = await verdict.decide(input);

      expect(decision.status).toBe('no_go');
      expect(decision.no_go_reason).toBe('drift');
    });

    it("preserves BTC-USD's calibration: 0.5% of a six-figure entry still passes", async () => {
      const verdict = new VerdictImpl();
      const entry = 100_000;
      const input = makeInput({
        risk_decision: makeRiskDecision({
          order_intent: makeIntent({
            instrument: 'BTC-USD',
            asset_class: 'crypto',
            entry,
          }),
        }),
        marketData: makeMarketData(makeMark({ price: entry + 400 })),
        config: makeConfig({ drift_tolerance_pct: PAPER_PCT }),
      });

      const decision = await verdict.decide(input);

      expect(decision.status).toBe('go');
    });

    it('reads the fraction from the order asset class, not a single global number', async () => {
      const verdict = new VerdictImpl();
      const config = makeConfig({ drift_tolerance_pct: { crypto: 0.5, stocks: 0.001 } });
      const marketData = makeMarketData(makeMark({ price: 110 }));

      const stocks = await verdict.decide(
        makeInput({
          risk_decision: makeRiskDecision({
            order_intent: makeIntent({ asset_class: 'stocks', entry: 100 }),
          }),
          marketData,
          config,
        }),
      );
      const crypto = await verdict.decide(
        makeInput({
          risk_decision: makeRiskDecision({
            order_intent: makeIntent({
              asset_class: 'crypto',
              instrument: 'BTC-USD',
              entry: 100,
            }),
          }),
          marketData,
          config,
        }),
      );

      expect(stocks.no_go_reason).toBe('drift');
      expect(crypto.status).toBe('go');
    });

    it('fails closed on a non-positive entry rather than computing a zero tolerance', async () => {
      const verdict = new VerdictImpl();
      const input = makeInput({
        risk_decision: makeRiskDecision({ order_intent: makeIntent({ entry: 0 }) }),
        marketData: makeMarketData(makeMark({ price: 0 })),
        config: makeConfig({ drift_tolerance_pct: PAPER_PCT }),
      });

      const decision = await verdict.decide(input);

      expect(decision.status).toBe('no_go');
      expect(decision.no_go_reason).toBe('drift');
    });
  });
});

describe('VerdictImpl.decide — staleness vs market-open, for equities (#381)', () => {
  it('rejects a stale overnight equity signal on STALENESS, not market_closed', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({
          decided_at: new Date('2026-07-14T19:59:00Z'),
        }),
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
  });

  it('leaves market_closed to catch the case staleness cannot: a FRESH mark, shut session', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:59:30Z') }),
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('market_closed');
  });

  it('gives an equity signal far more headroom than one debate can consume', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      config: makeConfig({ max_signal_age: { crypto: 5 * 60_000, stocks: 15 * 60_000 } }),
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decided_at: new Date('2026-07-15T13:50:00Z') }),
      }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
  });
});

describe('VerdictImpl.decide — dedup gate', () => {
  it('no-go with dedup when an order/fill already exists for this idempotency key', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ positionStore: makePositionStore(true) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('dedup');
  });
});

describe('VerdictImpl.decide — market-open gate', () => {
  it('no-go with market_closed for a stock order outside session hours', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ tradingCalendar: makeTradingCalendar(false) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('market_closed');
  });

  it('skips the market-open gate for crypto', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ asset_class: 'crypto', instrument: 'BTC-USD' }),
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
  });

  it('skips the market-open gate for stocks when extended hours are allowed', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      tradingCalendar: makeTradingCalendar(false),
      config: makeConfig({ allow_extended_hours: true }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
  });

  it('exempts a mandatory flat-by-close flatten from market_closed (#1388)', async () => {
    const verdict = new VerdictImpl();
    const flatten = makeIntent();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: {
          ...flatten,
          intent_type: 'exit',
          side: 'sell',
          metadata: { ...flatten.metadata, exit_reason: 'flatten', mandatory_flatten: true },
        },
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
    expect(decision.no_go_reason).toBeNull();
  });

  it('still refuses market_closed for a discretionary exit without the marker (#1388)', async () => {
    const verdict = new VerdictImpl();
    const flatten = makeIntent();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: {
          ...flatten,
          intent_type: 'exit',
          side: 'sell',
          metadata: { ...flatten.metadata, exit_reason: 'signal_decay' },
        },
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('market_closed');
  });
});

describe('VerdictImpl.decide — breaker re-check gate', () => {
  it('no-go with breaker when the portfolio breaker is tripped at fire time', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ breakers: makeBreakers({ portfolio_tripped: true }) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('breaker');
  });

  it('no-go with breaker when the relevant asset-class breaker is tripped', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      breakers: makeBreakers({ asset_class_tripped: { crypto: false, stocks: true } }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('breaker');
  });
});

describe('VerdictImpl.decide — HITL gate', () => {
  it('no-go with human_rejected when the human rejects', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ approvals: makeApprovals('rejected') });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('human_rejected');
    expect(decision.approval_path).toBe('human');
  });

  it('defaults to no-go with timeout when the human does not respond in time', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ approvals: makeApprovals('timeout') });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('timeout');
    expect(decision.approval_path).toBe('human_timeout');
  });
});

describe('VerdictImpl.decide — automation dial', () => {
  it('auto mode never engages HITL, even for a near-limit (flagged) trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'auto' } }),
      risk_decision: makeRiskDecision({
        modifications: { original_size: 200, final_size: 100, stop_tightened: true },
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(false);
  });

  it('manual mode always engages HITL, even with no flags set', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'manual' } }),
      risk_decision: makeRiskDecision({ modifications: null }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
  });

  it('semi_auto skips HITL for an unflagged trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({ modifications: null }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(false);
  });

  it('semi_auto engages HITL for a near-limit trade (risk_decision.modifications != null)', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: { original_size: 200, final_size: 100, stop_tightened: true },
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a non-converged trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({ metadata: { ...makeIntent().metadata, converged: false } }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a no-precedent trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({
          metadata: {
            ...makeIntent().metadata,
            cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
          },
        }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a size-over trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({
        automation_level: { crypto: 'manual', stocks: 'semi_auto' },
        flag_thresholds: { size_over: 50 },
      }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({ size: 100 }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('the same OrderIntent produces different routing under each dial setting', async () => {
    const verdict = new VerdictImpl();
    const riskDecision = makeRiskDecision({
      modifications: { original_size: 200, final_size: 100, stop_tightened: true },
    });

    const manualApprovals = makeApprovals('approved');
    const manualDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'manual' } }),
        risk_decision: riskDecision,
        approvals: manualApprovals,
      }),
    );

    const semiAutoApprovals = makeApprovals('approved');
    const semiAutoDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
        risk_decision: riskDecision,
        approvals: semiAutoApprovals,
      }),
    );

    const autoApprovals = makeApprovals('approved');
    const autoDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'auto' } }),
        risk_decision: riskDecision,
        approvals: autoApprovals,
      }),
    );

    expect(manualApprovals.requestApproval).toHaveBeenCalledTimes(1);
    expect(semiAutoApprovals.requestApproval).toHaveBeenCalledTimes(1);
    expect(autoApprovals.requestApproval).not.toHaveBeenCalled();

    expect(manualDecision.approval_path).toBe('human');
    expect(semiAutoDecision.approval_path).toBe('human');
    expect(autoDecision.approval_path).toBe('automated');

    expect(manualDecision.would_require_approval).toBe(true);
    expect(semiAutoDecision.would_require_approval).toBe(true);
    expect(autoDecision.would_require_approval).toBe(false);
  });
});

describe('VerdictImpl.decide — paper mode', () => {
  it('requires HITL via the real ApprovalChannel, same as live', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({ mode: 'paper', approvals });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
  });

  it('no-goes when the human rejects, same as live', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected');
    const input = makeInput({ mode: 'paper', approvals });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
  });
});

describe('VerdictImpl.decide — backtest mode', () => {
  it('bypasses HITL with an automated go, recording would_require_approval', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({ mode: 'backtest', approvals });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(true);
  });
});

describe('VerdictImpl.decide — gate ordering', () => {
  it('the first failing gate wins even when later gates would also fail', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decided_at: new Date('2026-07-15T13:00:00Z') }),
      }),
      marketData: makeMarketData(makeMark({ price: 999 })),
      positionStore: makePositionStore(true),
      breakers: makeBreakers({ portfolio_tripped: true }),
      approvals: makeApprovals('rejected'),
    });

    const decision = await verdict.decide(input);

    expect(decision.no_go_reason).toBe('staleness');
  });

  it('a stale feed at the final check no-goes even though every earlier gate passed', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decided_at: new Date('2026-07-15T13:00:00Z') }),
      }),
      marketData: makeMarketData(makeMark({ price: 100 })),
      tradingCalendar: makeTradingCalendar(true),
      positionStore: makePositionStore(false),
      breakers: makeBreakers(),
      approvals: makeApprovals('approved'),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
  });
});

describe('VerdictImpl.decide — unpriced mandatory flatten (#826)', () => {
  function unpricedFlatten(overrides: Partial<OrderIntent> = {}): OrderIntent {
    const base = makeIntent();
    return {
      ...base,
      intent_type: 'exit',
      side: 'sell',
      entry: 0,
      stop: 0,
      target: 0,
      metadata: { ...base.metadata, exit_reason: 'flatten', unpriced_exit: true },
      ...overrides,
    };
  }

  function inputFor(intent: OrderIntent, overrides: Partial<VerdictInput> = {}): VerdictInput {
    return makeInput({
      risk_decision: makeRiskDecision({ order_intent: intent }),
      config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
      ...overrides,
    });
  }

  it('goes, rather than no-going on drift, when the intent carries no price', async () => {
    const verdict = new VerdictImpl();

    const decision = await verdict.decide(inputFor(unpricedFlatten()));

    expect(decision.no_go_reason).toBeNull();
    expect(decision.status).toBe('go');
  });

  it('does not read the mark at all — the stalled call is not paid a second time', async () => {
    const verdict = new VerdictImpl();
    const marketData = makeMarketData();

    await verdict.decide(inputFor(unpricedFlatten(), { marketData }));

    expect(marketData.getMark).not.toHaveBeenCalled();
  });

  it('goes even against a feed so stale every other intent would be refused', async () => {
    const verdict = new VerdictImpl();
    const stale = makeMarketData(makeMark({ observed_at: new Date(NOW.getTime() - 60 * 60_000) }));

    const decision = await verdict.decide(inputFor(unpricedFlatten(), { marketData: stale }));

    expect(decision.status).toBe('go');
  });

  it('still dedupes — a repeated flatten must not double-submit while the feed is down', async () => {
    const verdict = new VerdictImpl();

    const decision = await verdict.decide(
      inputFor(unpricedFlatten(), { positionStore: makePositionStore(true) }),
    );

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('dedup');
  });

  it('still re-checks the breaker at fire time', async () => {
    const verdict = new VerdictImpl();

    const decision = await verdict.decide(
      inputFor(unpricedFlatten(), { breakers: makeBreakers({ portfolio_tripped: true }) }),
    );

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('breaker');
  });

  it('leaves a normally-priced exit fully gated', async () => {
    const verdict = new VerdictImpl();
    const priced = unpricedFlatten({ entry: 100, stop: 100, target: 100 });
    const metadata = { ...priced.metadata };
    delete metadata.unpriced_exit;

    const decision = await verdict.decide(
      inputFor(
        { ...priced, metadata },
        { marketData: makeMarketData(makeMark({ price: 140 })) },
      ),
    );

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('drift');
  });

  it('still refuses an unflagged intent with no positive entry', async () => {
    const verdict = new VerdictImpl();
    const metadata = { ...unpricedFlatten().metadata };
    delete metadata.unpriced_exit;

    const decision = await verdict.decide(inputFor({ ...unpricedFlatten(), metadata }));

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('drift');
  });
});

describe('VerdictImpl.decide — mandatory flatten and staleness (#894)', () => {
  const STALE_AT = new Date(NOW.getTime() - 56 * 60_000);

  function staleExit(overrides: Partial<OrderIntent> = {}): OrderIntent {
    const base = makeIntent();
    return {
      ...base,
      intent_type: 'exit',
      side: 'sell',
      decision_timestamp: STALE_AT,
      decided_at: STALE_AT,
      metadata: { ...base.metadata, exit_reason: 'flatten', mandatory_flatten: true },
      ...overrides,
    };
  }

  function inputFor(intent: OrderIntent, overrides: Partial<VerdictInput> = {}): VerdictInput {
    return makeInput({
      risk_decision: makeRiskDecision({ order_intent: intent }),
      config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
      ...overrides,
    });
  }

  it('goes on a signal far older than the bound', async () => {
    const decision = await new VerdictImpl().decide(inputFor(staleExit()));

    expect(decision.no_go_reason).toBeNull();
    expect(decision.status).toBe('go');
  });

  it('still dedupes — the clock does not authorise a second submission', async () => {
    const decision = await new VerdictImpl().decide(
      inputFor(staleExit(), { positionStore: makePositionStore(true) }),
    );

    expect(decision.no_go_reason).toBe('dedup');
  });

  it('still re-checks the breaker at fire time', async () => {
    const decision = await new VerdictImpl().decide(
      inputFor(staleExit(), { breakers: makeBreakers({ portfolio_tripped: true }) }),
    );

    expect(decision.no_go_reason).toBe('breaker');
  });

  it('leaves a stale DISCRETIONARY exit refused — it is acting on an opinion', async () => {
    const flatten = staleExit();
    const metadata = { ...flatten.metadata, exit_reason: 'signal_decay' as const };
    delete metadata.mandatory_flatten;

    const decision = await new VerdictImpl().decide(inputFor({ ...flatten, metadata }));

    expect(decision.no_go_reason).toBe('staleness');
  });

  it('leaves a stale ENTRY refused — no entry carries the marker', async () => {
    const flatten = staleExit();
    const metadata = { ...flatten.metadata };
    delete metadata.mandatory_flatten;
    delete metadata.exit_reason;

    const decision = await new VerdictImpl().decide(
      inputFor({ ...flatten, intent_type: 'entry', side: 'buy', metadata }),
    );

    expect(decision.no_go_reason).toBe('staleness');
  });

  it('leaves a FRESH mandatory flatten gated on everything else, unchanged', async () => {
    const decision = await new VerdictImpl().decide(
      inputFor(staleExit({ decided_at: NOW }), {
        marketData: makeMarketData(makeMark({ price: 140 })),
      }),
    );

    expect(decision.no_go_reason).toBe('drift');
  });
});

describe('VerdictImpl.decide — stale AND unpriced mandatory flatten (#826, #894 stacked)', () => {
  const STALE_AT = new Date(NOW.getTime() - 56 * 60_000);

  function staleUnpricedFlatten(overrides: Partial<OrderIntent> = {}): OrderIntent {
    const base = makeIntent();
    return {
      ...base,
      intent_type: 'exit',
      side: 'sell',
      decision_timestamp: STALE_AT,
      decided_at: STALE_AT,
      entry: 0,
      stop: 0,
      target: 0,
      metadata: {
        ...base.metadata,
        exit_reason: 'flatten',
        unpriced_exit: true,
        mandatory_flatten: true,
      },
      ...overrides,
    };
  }

  it('is not refused for staleness or stale_feed when the mark itself is stale', async () => {
    const verdict = new VerdictImpl();
    const stale = makeMarketData(makeMark({ observed_at: new Date(NOW.getTime() - 60 * 60_000) }));
    const input = makeInput({
      risk_decision: makeRiskDecision({ order_intent: staleUnpricedFlatten() }),
      config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
      marketData: stale,
    });

    const decision = await verdict.decide(input);

    expect(decision.no_go_reason).not.toBe('staleness');
    expect(decision.no_go_reason).not.toBe('stale_feed');
    expect(decision.status).toBe('go');
  });

  it('is not refused for drift when the mark is fresh but the intent carries no entry price', async () => {
    const verdict = new VerdictImpl();
    const fresh = makeMarketData(makeMark({ observed_at: NOW }));
    const input = makeInput({
      risk_decision: makeRiskDecision({ order_intent: staleUnpricedFlatten() }),
      config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }),
      marketData: fresh,
    });

    const decision = await verdict.decide(input);

    expect(decision.no_go_reason).not.toBe('drift');
    expect(decision.status).toBe('go');
  });
});

describe('VerdictImpl.decide — precondition', () => {
  it('throws if handed a RiskDecision without an approved order_intent', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({ status: 'rejected', order_intent: null }),
    });

    await expect(verdict.decide(input)).rejects.toThrow();
  });
});
