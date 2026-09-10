/**
 * `InMemoryQueryStore` — a concrete implementation of the `DashboardQueryStore`
 * port (dashboard-spec.md "Module: Query Store"), seeded with realistic
 * fixture data so the dashboard runs out of the box. Mirrors the project's
 * existing in-memory store pattern (server/pipeline/feedback-loop/fixture-stores.ts,
 * server/pipeline/trader/fixture-setup-store.ts, server/pipeline/debate-engine/debate-log-store.ts):
 * the real SQLite-backed shared store is deferred (no shared store exists
 * anywhere in the codebase yet — every stage's store is an in-memory
 * implementation of its port pending that build-out).
 *
 * Read-only by construction: only the `DashboardQueryStore` get-* methods are
 * implemented; no setters, no write path (dashboard-spec.md "Any write path
 * ... strictly read-only"). The fixture data is static; a future ticket swaps
 * this for the real SQLite-backed `DashboardQueryStore` without touching the
 * server or snapshot seam.
 */

import type { PipelineStage } from '../../../contracts/index.js';
// Imported from the concrete module, not the `debate-engine` barrel: the
// barrel re-exports `SqliteDebateLogStore`, the Anthropic/Nous LLM clients
// etc., and a value import of the barrel would drag every one of those
// runtime dependencies into a fixture module that has none today.
// `computeInfluenceScore` itself has no imports beyond `./types.js`, so this
// stays a type-only-equivalent, zero-side-effect import.
import { computeInfluenceScore } from '../../pipeline/debate-engine/analyst-contribution.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import {
  MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
  type PersistedArmComparisonSample,
} from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmSpendSummary,
  PipelineActivity,
  PipelineLiveTick,
  PipelineStageEvent,
  RiskCriticRecord,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

const NOW = new Date('2026-07-19T14:30:00Z');

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

const MARKS: Record<string, Mark> = {
  'BTC-USD': {
    price: 67_250.5,
    observed_at: minutesAgo(1),
    source: 'kraken',
    asset_class: 'crypto',
  },
  'ETH-USD': {
    price: 3_512.8,
    observed_at: minutesAgo(1),
    source: 'kraken',
    asset_class: 'crypto',
  },
  AAPL: { price: 228.41, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  TSLA: { price: 246.18, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  SPY: { price: 557.92, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  QQQ: { price: 489.13, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
};

const OPEN_POSITIONS: OpenPosition[] = [
  {
    idempotency_key: 'BTC-USD-2026-07-19T13:00:00Z',
    debate_id: 'debate-btc-001',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 0.3,
    filled_size: 0.3,
    avg_entry_price: 66_100,
    stop: 64_200,
    target: 70_500,
    order_state: 'filled',
    broker_order_ids: ['kraken-1'],
    opened_at: hoursAgo(1.5),
    decision_timestamp: hoursAgo(1.5),
    conviction: 0.72,
    converged: true,
  },
  {
    idempotency_key: 'ETH-USD-2026-07-19T11:30:00Z',
    debate_id: 'debate-eth-002',
    instrument: 'ETH-USD',
    asset_class: 'crypto',
    side: 'sell',
    intent_type: 'entry',
    requested_size: 4,
    filled_size: 4,
    avg_entry_price: 3_580,
    stop: 3_720,
    target: 3_290,
    order_state: 'filled',
    broker_order_ids: ['kraken-2'],
    opened_at: hoursAgo(3),
    decision_timestamp: hoursAgo(3),
    conviction: 0.68,
    converged: true,
  },
  {
    idempotency_key: 'AAPL-2026-07-19T09:35:00Z',
    debate_id: 'debate-aapl-003',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 100,
    avg_entry_price: 224.1,
    stop: 218.5,
    target: 236,
    order_state: 'filled',
    broker_order_ids: ['alpaca-1'],
    opened_at: hoursAgo(5),
    decision_timestamp: hoursAgo(5),
    conviction: 0.61,
    converged: false,
  },
];

/**
 * Closed-trade fixtures (#940) — the two round trips `positions` above never
 * had a way to show: a WIN (SPY, target hit) and a LOSS (QQQ, stop hit), each
 * with its own entry + exit fill so the panel's fills sub-list has something
 * real to render. Every number below is internally consistent both ways
 * `buildSnapshot`'s `exit_price` can be derived — from these fills' weighted
 * price, and from `realized_pnl_net`/`fees_total` arithmetic against `entry`
 * — so the fixture cannot silently drift the two derivations apart.
 */
const CLOSED_TRADES: ClosedTrade[] = [
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    debate_id: 'debate-spy-101',
    instrument: 'SPY',
    asset_class: 'stocks',
    side: 'buy',
    entry: 552.1,
    stop: 545.0,
    filled_size: 20,
    realized_pnl_net: 151.6,
    fees_total: 2.4,
    opened_at: hoursAgo(8),
    closed_at: hoursAgo(6.5),
    close_reason: 'target',
    // #1121: a fixture row is a normally-charged trade — every leg the
    // modelled-cost mechanism COVERS was charged. Not "both legs": these two
    // rows close on `'target'` and `'stop'`, and a protective leg is outside
    // coverage (`modelledCostCharged`, ingest-fills.ts), so the flag is true
    // on the entry leg alone. Round-2 review, finding 7 — wording only, the
    // value is right either way.
    modelled_cost_charged: true,
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    debate_id: 'debate-qqq-102',
    instrument: 'QQQ',
    asset_class: 'stocks',
    side: 'sell',
    entry: 495.6,
    stop: 500.5,
    filled_size: 15,
    realized_pnl_net: -69.3,
    fees_total: 1.8,
    opened_at: hoursAgo(10),
    closed_at: hoursAgo(9),
    close_reason: 'stop',
    modelled_cost_charged: true,
  },
];

const FILLS: Fill[] = [
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-spy-entry'),
    leg: 'entry',
    price: 552.1,
    qty: 20,
    fee: 1.2,
    timestamp: hoursAgo(8),
  },
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-spy-target'),
    leg: 'target',
    price: 559.8,
    qty: 20,
    fee: 1.2,
    timestamp: hoursAgo(6.5),
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-qqq-entry'),
    leg: 'entry',
    price: 495.6,
    qty: 15,
    fee: 0.9,
    timestamp: hoursAgo(10),
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-qqq-stop'),
    leg: 'stop',
    price: 500.1,
    qty: 15,
    fee: 0.9,
    timestamp: hoursAgo(9),
  },
];

const RECENT_DEBATES: DebateLog[] = [
  {
    debate_id: 'debate-btc-001',
    instrument: 'BTC-USD',
    bar_timestamp: hoursAgo(1.5),
    direction: 'bullish',
    rounds: 3,
    created_at: hoursAgo(1.5),
    contributions: [
      contribution('technical', ['bearish', 'neutral', 'bullish']),
      contribution('fundamental', ['neutral', 'neutral', 'bullish']),
      contribution('sentiment', ['neutral', 'neutral', 'neutral']),
    ],
  },
  {
    debate_id: 'debate-eth-002',
    instrument: 'ETH-USD',
    bar_timestamp: hoursAgo(3),
    direction: 'bearish',
    rounds: 2,
    created_at: hoursAgo(3),
    contributions: [
      contribution('technical', ['neutral', 'bearish']),
      contribution('fundamental', ['neutral', 'neutral']),
      unrecordedContribution('sentiment', 'bearish'),
    ],
  },
  {
    debate_id: 'debate-aapl-003',
    instrument: 'AAPL',
    bar_timestamp: hoursAgo(5),
    direction: 'bullish',
    rounds: 3,
    created_at: hoursAgo(5),
    contributions: [
      contribution('technical', ['neutral', 'bullish', 'bullish']),
      contribution('fundamental', ['bearish', 'bearish', 'bullish']),
      contribution('sentiment', ['neutral', 'neutral', 'neutral']),
    ],
  },
  {
    debate_id: 'debate-tsla-004',
    instrument: 'TSLA',
    bar_timestamp: hoursAgo(6),
    direction: 'neutral',
    rounds: 3,
    created_at: hoursAgo(6),
    contributions: [
      contribution('technical', ['bearish', 'bullish', 'neutral']),
      contribution('fundamental', ['neutral', 'bearish', 'bearish']),
      contribution('sentiment', ['neutral', 'neutral', 'bullish']),
    ],
  },
];

/**
 * A recorded stance history has one entry per debate round — otherwise the
 * fixtures depict a 3-round debate with a 1-square strip (#618). An EMPTY
 * history is the recorded-none case and is legal at any round count; it is
 * "nothing was recorded", not a history that ran short.
 *
 * Checked at module load so editing a debate's `rounds` without its stance
 * arrays (or the reverse) fails at import in every test run, rather than
 * rendering a wrong strip nobody questions.
 */
function assertStanceLengthsMatchRounds(debates: readonly DebateLog[]): void {
  for (const debate of debates) {
    for (const entry of debate.contributions) {
      const recorded = entry.stance_during_debate.length;
      if (recorded !== 0 && recorded !== debate.rounds) {
        throw new Error(
          `fixture ${debate.debate_id}: ${entry.analyst_id} records ${recorded} round stance(s) for a ${debate.rounds}-round debate — expected ${debate.rounds} or 0 (none recorded)`,
        );
      }
    }
  }
}

assertStanceLengthsMatchRounds(RECENT_DEBATES);

/**
 * Indexed off the contract these helpers build rather than off `Direction`
 * directly, so a widening of `AnalystContribution` (a nullable final position
 * for an unresolved debate, say) reaches the fixtures as a compile error
 * instead of a signature that silently no longer matches what it constructs.
 */
type Stance = AnalystContribution['stance_during_debate'][number];
type FinalPosition = AnalystContribution['final_position'];

/**
 * A recorded round history: at least one round, oldest first, and as many
 * entries as the owning debate's `rounds` (#618). Enforced at load by
 * `assertStanceLengthsMatchRounds`.
 */
type RecordedStances = readonly [Stance, ...Stance[]];

/**
 * One analyst's contribution, built from its RECORDED round history.
 *
 * `final_position` reads off the last round; nothing here is derived from
 * `final_position` (#618) — a history synthesized from where the analyst ended
 * up makes one that was talked around indistinguishable from one that never
 * moved, which is the fabrication #599 removed from the wire. A flat history
 * in these fixtures is flat because it was recorded flat.
 *
 * `influence_score` is likewise not hand-picked (#624): it is
 * `computeInfluenceScore(stances)`, the same function
 * `buildAnalystContributions` calls in production. That function is a strict
 * transform of the stance array — fraction of consecutive-round transitions
 * that changed — so the only way to change a fixture's score is to change its
 * recorded stances, exactly like a real debate. There is no "sums to 1.0 per
 * debate" shape to preserve: the client only ever renders `influence_score`
 * as a bare 0–1 reading per analyst (`DebatesPanel.tsx`, `DetailDrawer.tsx`),
 * never as a share of a per-debate total, so nothing needed a display-only
 * normalisation layer.
 */
function contribution(type: string, stances: RecordedStances): AnalystContribution {
  const [opening, ...laterRounds] = stances;
  return {
    analyst_id: `${type}-analyst`,
    analyst_type: type,
    stance_during_debate: [...stances],
    final_position: laterRounds.at(-1) ?? opening,
    rationale: `Round-by-round ${type} read on the instrument.`,
    influence_score: computeInfluenceScore([...stances]),
  };
}

/**
 * An analyst whose round stances were never recorded: `buildAnalystContributions`
 * emits an empty `stance_during_debate` and falls back to the analyst's opening
 * view for `final_position`, so this is the recorded-none case, NOT a history
 * shorter than the debate's `rounds`. The strip renders it as its stated empty
 * state. `computeInfluenceScore([])` is 0 — no rounds recorded, no transition
 * observable — so that is what this fixture reports too, rather than a
 * hand-picked non-zero reading.
 */
function unrecordedContribution(type: string, final: FinalPosition): AnalystContribution {
  return {
    analyst_id: `${type}-analyst`,
    analyst_type: type,
    stance_during_debate: [],
    final_position: final,
    rationale: `Opening ${type} read on the instrument; no round stances recorded.`,
    influence_score: computeInfluenceScore([]),
  };
}

const VERDICT_HISTORY: VerdictAuditEntry[] = [
  {
    trace_id: 'trace-001',
    instrument: 'BTC-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(1.5),
  },
  {
    trace_id: 'trace-002',
    instrument: 'ETH-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(3),
  },
  {
    trace_id: 'trace-003',
    instrument: 'AAPL',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(5),
  },
  {
    trace_id: 'trace-004',
    instrument: 'TSLA',
    status: 'no_go',
    reason: 'risk_max_positions',
    hitl_override: false,
    timestamp: hoursAgo(6),
  },
  {
    trace_id: 'trace-005',
    instrument: 'SPY',
    status: 'no_go',
    reason: 'verdict_low_conviction',
    hitl_override: false,
    timestamp: hoursAgo(7),
  },
  {
    trace_id: 'trace-006',
    instrument: 'QQQ',
    status: 'no_go',
    reason: 'risk_correlation',
    hitl_override: true,
    timestamp: hoursAgo(8),
  },
];

/**
 * Risk decisions with their critic verdicts (#1066), keyed by the same
 * `(trace_id, instrument)` pairs the verdict history above uses so the drawer
 * finds one for a trace an operator can actually click.
 *
 * Three rows, three different facts, because a fixture store whose job is "the
 * dashboard runs out of the box" must exercise the branches or they ship
 * having never been drawn: a decision rejected on a MEASURED breach while the
 * critic's prose passed, a decision whose conditions were all refused by the
 * validator, and a row written before #994's fold that carries none at all.
 */
const RISK_CRITICS: RiskCriticRecord[] = [
  {
    trace_id: 'trace-001',
    instrument: 'BTC-USD',
    debate_id: 'debate-btc-001',
    binding_constraint: 'risk_critic:invalidated',
    critic: {
      verdict: 'pass',
      max_notional: null,
      reasoning: 'the breakout has volume behind it and the stop sits under structure',
      conditions: [
        {
          condition: {
            id: 'mark-breaks-back-under-entry',
            observable: { kind: 'mark' },
            comparator: '<',
            threshold: 61_200,
            rationale: 'a break back under the entry level falsifies the breakout',
          },
          state: 'breached',
          observed: 60_940.5,
        },
        {
          condition: {
            id: 'participation-thins',
            observable: {
              kind: 'bars',
              window: { timeframe: '5m', lookback: 20 },
              measure: 'volume_ratio',
            },
            comparator: '<',
            threshold: 0.8,
            rationale: 'a breakout on thinning volume is not a breakout',
          },
          state: 'not_breached',
          observed: 1.42,
        },
        {
          condition: {
            id: 'momentum-rolls-over',
            observable: {
              kind: 'indicator',
              spec: { indicator: 'rsi', params: {}, lookback: 14, timeframe: '5m' },
            },
            comparator: '<',
            threshold: 45,
            rationale: 'momentum leaving falsifies the continuation thesis',
          },
          state: 'unevaluable',
          observed: null,
        },
      ],
      dropped_conditions: [],
    },
    created_at: hoursAgo(1.5),
  },
  {
    trace_id: 'trace-002',
    instrument: 'ETH-USD',
    debate_id: 'debate-eth-002',
    binding_constraint: null,
    critic: {
      verdict: 'trim',
      max_notional: 250,
      reasoning: 'the size is too large for the depth on this tape',
      conditions: [],
      dropped_conditions: [
        { id: 'rsi-over-9000', raw: '{"threshold":9000}', reason: 'threshold_out_of_range' },
        { id: null, raw: 'sentiment turns negative', reason: 'unknown_observable' },
      ],
    },
    created_at: hoursAgo(3),
  },
  {
    trace_id: 'trace-003',
    instrument: 'AAPL',
    debate_id: 'debate-aapl-003',
    binding_constraint: 'risk_critic:reject',
    critic: {
      verdict: 'reject',
      max_notional: null,
      reasoning: 'the thesis rests on an earnings move that has already happened',
    },
    created_at: hoursAgo(5),
  },
];

const ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.4,
  'fundamental-analyst': 0.35,
  'sentiment-analyst': 0.25,
};

const ATTRIBUTION: Record<string, AttributionSummary> = {
  'technical-analyst': { analyst_id: 'technical-analyst', rolling_r: 2.31, window_days: 30 },
  'fundamental-analyst': { analyst_id: 'fundamental-analyst', rolling_r: 1.04, window_days: 30 },
  'sentiment-analyst': { analyst_id: 'sentiment-analyst', rolling_r: -0.47, window_days: 30 },
};

/** #1108. Zero — the fixture's baseline is a healthy alert channel, like every other tile here. */
const ALERT_DELIVERY_FAILURE_COUNT = 0;

const TICK_STATUS: TickStatus = {
  instrument: 'SPY',
  asset_class: 'stocks',
  stage: 'debate',
  trace_id: 'trace-007',
};

const DAILY_METRICS: MetricsSuite = {
  sharpe: 1.82,
  sortino: 2.41,
  calmar: 1.17,
  max_drawdown: 0.118,
  profit_factor: 1.94,
  expectancy: 184.5,
  skew: 0.31,
  kurtosis: 2.8,
  turnover: 3.6,
  exposure: 0.42,
  // The DSR inputs (#406). Consistent with `sharpe` above rather than
  // arbitrary: 0.1146 x 15.87 = 1.82, and 252 observations is a year of daily
  // bars — a fixture that contradicted its own Sharpe would be a confusing
  // thing to develop the dashboard against.
  per_period_sharpe: 0.1146,
  annualization_factor: 15.87,
  observations: 252,
};

/**
 * Spend fixtures. `last_24h` carries a non-zero `unpriced_calls` on purpose:
 * it is the case a fixture set is most likely to omit and the one the UI most
 * needs to prove it renders, since a silently-dropped unpriced call is how a
 * spend total understates itself. `per_debate.unattributed_calls` is non-zero
 * for the same reason (#326) — it is the caveat that travels with the
 * percentiles, and a fixture that never exercises it lets the UI ship without
 * a place to show it.
 *
 * p95 sits well above p50 in every window, deliberately: LLM latency is
 * long-tailed and a fixture set with p50 == p95 would let a percentile bug
 * that collapses the two render as plausible.
 */
const LLM_SPEND_24H = {
  cost_usd: 0.4183,
  input_tokens: 214_500,
  output_tokens: 38_200,
  cache_read_input_tokens: 96_000,
  cache_creation_input_tokens: 12_800,
  calls: 142,
  unpriced_calls: 3,
  per_debate: {
    debates: 14,
    unattributed_calls: 2,
    cost_usd_p50: 0.0281,
    cost_usd_p95: 0.0472,
    llm_latency_ms_p50: 8_400,
    llm_latency_ms_p95: 19_700,
  },
};

const LLM_SPEND_7D = {
  cost_usd: 2.9106,
  input_tokens: 1_502_300,
  output_tokens: 271_400,
  cache_read_input_tokens: 688_100,
  cache_creation_input_tokens: 84_600,
  calls: 991,
  unpriced_calls: 3,
  per_debate: {
    debates: 98,
    unattributed_calls: 2,
    cost_usd_p50: 0.0274,
    cost_usd_p95: 0.0511,
    llm_latency_ms_p50: 8_150,
    llm_latency_ms_p95: 21_300,
  },
};

/**
 * Two Feedback Loop cycles' matched-control comparisons (#971), newest first.
 *
 * The live arm leads on both columns here — the healthy reading, and the one an
 * operator opening the dashboard for the first time should see. The divergent
 * case has its own coverage in `arm-comparison-cycle.test.ts` and in the panel's
 * own test; baking a permanent divergence into the out-of-the-box fixtures would
 * teach the reader that the alert state is normal.
 */
/**
 * #981. The outside benchmarks over the SAME window as `ARM_COMPARISONS[0]` —
 * that match is the fixture's whole point, since the panel states it. Two
 * benchmarks per cycle, populated for `getArmComparisons`' reason: a fixture
 * store whose job is "the dashboard runs out of the box" must exercise the
 * populated branch or the panel ships never having been drawn.
 *
 * The numbers are deliberately unremarkable and NOT chosen to make the live arm
 * look good: over this window SPY beat the live arm's 1.84%. That is a normal
 * reading for a flat-by-close book against a fully-invested index, it is not a
 * failure, and the panel's copy has to hold up when it happens.
 */
const OUTSIDE_BENCHMARKS: OutsideBenchmarkSample[] = [
  {
    computed_at: NOW,
    from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
    to: NOW,
    performance: {
      benchmark: 'spy',
      buy_and_hold_return_pct: 0.0241,
      max_drawdown_pct: 0.0473,
      observation_count: 21,
    },
  },
  {
    computed_at: NOW,
    from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
    to: NOW,
    performance: {
      benchmark: 'sixty_forty',
      buy_and_hold_return_pct: 0.0158,
      max_drawdown_pct: 0.0289,
      observation_count: 21,
    },
  },
];

const ARM_COMPARISONS: PersistedArmComparisonSample[] = [
  {
    computed_at: NOW,
    comparison: {
      from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
      to: NOW,
      basis: 1_000,
      live: {
        arm: 'live',
        trade_count: 24,
        realized_pnl_net: 18.4,
        return_pct: 0.0184,
        max_drawdown_pct: 0.021,
        refused_pass_count: 0,
      },
      control: {
        arm: 'control',
        trade_count: 19,
        realized_pnl_net: 6.2,
        return_pct: 0.0062,
        max_drawdown_pct: 0.028,
        refused_pass_count: 2,
      },
    },
    divergence: {
      diverged: false,
      reason: null,
      min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
    },
  },
  {
    // Predates migration 0057 (#1483): `refused_pass_count` is `null` on both
    // arms, not `0` — the fixture server's demo of the honest historical case
    // a real pre-migration row reads back as.
    computed_at: new Date(NOW.getTime() - 24 * 3_600_000),
    comparison: {
      from: new Date(NOW.getTime() - 31 * 24 * 3_600_000),
      to: new Date(NOW.getTime() - 24 * 3_600_000),
      basis: 1_000,
      live: {
        arm: 'live',
        trade_count: 22,
        realized_pnl_net: 15.1,
        return_pct: 0.0151,
        max_drawdown_pct: 0.021,
        refused_pass_count: null,
      },
      control: {
        arm: 'control',
        trade_count: 18,
        realized_pnl_net: 7.9,
        return_pct: 0.0079,
        max_drawdown_pct: 0.026,
        refused_pass_count: null,
      },
    },
    divergence: {
      diverged: false,
      reason: null,
      min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
    },
  },
];

/**
 * #1140: the fixture server states a cap rather than sending `null`, so the
 * demo exercises the meter rather than its empty state. ADR-0008's paper
 * figure, which is what a fixture run stands in for.
 */
const FIXTURE_LLM_CAP_USD = 50;

/**
 * #1196: a fixed, arbitrary past instant standing in for the real
 * orchestrator's arm-at-boot timestamp — armed, not absent, for the same
 * "demo exercises the real state" reason `FIXTURE_LLM_CAP_USD` exists.
 */
const FIXTURE_LLM_CAP_ARMED_AT = '2026-08-01T00:00:00.000Z';

const LLM_SPEND_ALL = {
  cost_usd: 6.7742,
  input_tokens: 3_488_900,
  output_tokens: 630_050,
  cache_read_input_tokens: 1_602_400,
  cache_creation_input_tokens: 196_700,
  calls: 2_310,
  unpriced_calls: 3,
  per_debate: {
    debates: 229,
    unattributed_calls: 2,
    cost_usd_p50: 0.0269,
    cost_usd_p95: 0.0538,
    llm_latency_ms_p50: 8_050,
    llm_latency_ms_p95: 22_900,
  },
};

/**
 * Pipeline-view fixtures (#411). One lane per instrument in `MARKS`, chosen so
 * every cell state and every outcome the render layer has to draw appears at
 * least once without the developer having to run a tick:
 *
 *  - BTC-USD — a clean walk to Execution (`go`).
 *  - ETH-USD — a debate retried once, then rejected at Verdict (`no_go`),
 *    which is what puts a two-attempt cell and a completed-but-negative
 *    traversal on screen together.
 *  - AAPL    — stopped at Trader on `no_trade`.
 *  - TSLA    — stopped at Analysts on `quorum_skip`.
 *  - SPY     — in flight at Debate, on the same trace as `TICK_STATUS` so the
 *              two views of the live tick agree.
 *  - QQQ     — no trace at all: the idle lane (#413).
 *
 * AAPL and TSLA are the deliberate ones: short-circuits that end before
 * Verdict, which the UI must draw and which the SQLite store now serves too
 * (`audit_log.instrument`, migration 0013 — see `pipeline-query.ts`'s header).
 * They stayed in the fixtures after that landed because a fixture the real
 * store cannot reproduce is a fixture nobody can trust.
 */
const PIPELINE_NOW = NOW;

function pipelineEvent(
  trace_id: string,
  instrument: string,
  asset_class: PipelineStageEvent['asset_class'],
  stage: PipelineStage,
  decision: string,
  secondsAgo: number,
): PipelineStageEvent {
  return {
    trace_id,
    instrument,
    asset_class,
    stage,
    decision,
    timestamp: new Date(PIPELINE_NOW.getTime() - secondsAgo * 1_000),
  };
}

const PIPELINE_EVENTS: PipelineStageEvent[] = [
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'analysts', 'quorum_met', 190),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'debate', 'bullish', 186),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'trader', 'entry', 175),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'risk', 'approved', 173),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'verdict', 'go', 172),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'execution', 'filled', 170),

  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'analysts', 'quorum_met', 130),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'debate', 'retry', 127),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'debate', 'bearish', 118),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'trader', 'entry', 114),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'risk', 'approved', 113),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'verdict', 'no_go', 112),

  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'analysts', 'quorum_met', 95),
  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'debate', 'neutral', 91),
  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'trader', 'no_trade', 84),

  pipelineEvent('trace-p-tsla', 'TSLA', 'stocks', 'analysts', 'quorum_skip', 47),

  // The live trace's completed stages. Its current stage has no row yet — the
  // audit row is written after the stage returns — which is exactly the state
  // a `live` cell has to render from.
  pipelineEvent('trace-007', 'SPY', 'stocks', 'analysts', 'quorum_met', 6),
];

const PIPELINE_LIVE: PipelineLiveTick[] = [
  {
    instrument: 'SPY',
    asset_class: 'stocks',
    stage: 'debate',
    trace_id: TICK_STATUS.trace_id,
    entered_at: new Date(PIPELINE_NOW.getTime() - 4_000),
  },
];

export class InMemoryQueryStore implements DashboardQueryStore {
  getRecentDebates(limit: number, _asOf: Date): DebateLog[] {
    return RECENT_DEBATES.slice(0, limit);
  }

  getTickStatus(_asOf: Date): TickStatus | null {
    return TICK_STATUS;
  }

  getOpenPositions(_asOf: Date): OpenPosition[] {
    return OPEN_POSITIONS;
  }

  getRecentClosedTrades(limit: number, _asOf: Date): ClosedTrade[] {
    return CLOSED_TRADES.slice(0, limit);
  }

  /** Same "scoped to the named lots" contract as `SqliteQueryStore` — see there. */
  getFillsForTrades(idempotencyKeys: readonly string[], _asOf: Date): Fill[] {
    const keys = new Set(idempotencyKeys);
    return FILLS.filter((fill) => keys.has(fill.idempotency_key));
  }

  getVerdictHistory(limit: number, _asOf: Date): VerdictAuditEntry[] {
    return VERDICT_HISTORY.slice(0, limit);
  }

  /** #1066. `limit` is honoured for `getPipelineActivity`'s reason. */
  getRiskCritics(limit: number, _asOf: Date): RiskCriticRecord[] {
    return RISK_CRITICS.slice(0, limit).map((record) => ({ ...record }));
  }

  getAnalystWeights(_asOf: Date): Record<string, number> {
    return { ...ANALYST_WEIGHTS };
  }

  getAttribution(_asOf: Date): Record<string, AttributionSummary> {
    return { ...ATTRIBUTION };
  }

  getDailyMetrics(_asOf: Date): MetricsSuite {
    return { ...DAILY_METRICS };
  }

  getMark(instrument: string, _asOf: Date): Mark {
    const mark = MARKS[instrument];
    if (mark === undefined) {
      throw new Error(`no mark fixture for instrument "${instrument}"`);
    }
    return { ...mark };
  }

  /** Same throw-on-missing contract as `getMark`, per instrument in request order. */
  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark> {
    return new Map(instruments.map((instrument) => [instrument, this.getMark(instrument, asOf)]));
  }

  /**
   * #971. One sample, not zero: an empty array is the honest "FL has computed
   * none yet" state and the panel renders it as those words — a fixture store
   * whose whole job is "the dashboard runs out of the box" must exercise the
   * populated branch instead, or the panel ships never having been drawn.
   * `limit` is honoured for `getPipelineActivity`'s reason.
   */
  getArmComparisons(limit: number, _asOf: Date): PersistedArmComparisonSample[] {
    return ARM_COMPARISONS.slice(0, limit).map((sample) => ({ ...sample }));
  }

  /** #981. `limit` counts rows, not cycles — see the port's doc. */
  getOutsideBenchmarks(limit: number, _asOf: Date): OutsideBenchmarkSample[] {
    return OUTSIDE_BENCHMARKS.slice(0, limit).map((sample) => ({ ...sample }));
  }

  getLlmSpend(_asOf: Date): LlmSpendSummary {
    return {
      last_24h: { ...LLM_SPEND_24H },
      last_7d: { ...LLM_SPEND_7D },
      all_time: { ...LLM_SPEND_ALL },
      cap_usd: FIXTURE_LLM_CAP_USD,
      cap_armed_at: FIXTURE_LLM_CAP_ARMED_AT,
    };
  }

  /**
   * `maxLanes` is honoured (the fixtures are the universe, and a store that
   * ignored its own bound would let the dashboard ship never having exercised
   * one); `lookbackMs` and `asOf` are not, for the same reason every method
   * above ignores `asOf` — the fixture data is static, so every trace is
   * always "recent".
   */
  getPipelineActivity(maxLanes: number, _lookbackMs: number, _asOf: Date): PipelineActivity {
    const universe = Object.entries(MARKS)
      .map(([instrument, mark]) => ({ instrument, asset_class: mark.asset_class }))
      .slice(0, maxLanes);
    const laneInstruments = new Set(universe.map((entry) => entry.instrument));
    return {
      universe,
      events: PIPELINE_EVENTS.filter((event) => laneInstruments.has(event.instrument)),
      live: PIPELINE_LIVE.filter((tick) => laneInstruments.has(tick.instrument)),
    };
  }

  getAlertDeliveryFailureCount(_asOf: Date): number {
    return ALERT_DELIVERY_FAILURE_COUNT;
  }
}

/** Exposed so tests can pin the clock against the same fixtures. */
export const FIXTURE_NOW = NOW;
