/**
 * `buildSnapshot` — the dashboard's pure presentation seam (docs/specs/
 * dashboard-spec.md "Module: Snapshot"): a pure function of
 * `(DashboardQueryStore, asOf)` that projects the store's reads into a
 * JSON-serializable `DashboardSnapshot`. No I/O beyond the injected store
 * (dashboard-spec.md "Testing Decisions": assert on output given a fake
 * store, never on real database state).
 *
 * Unrealized PnL follows the cross-spec-contracts.md §4 rule exactly: always
 * `filled_size`, never `requested_size` — a partially filled lot is marked at
 * what actually filled. Recent-history window is fixed
 * (`RECENT_DEBATES_LIMIT` / `RECENT_VERDICTS_LIMIT`), no config surface yet.
 */
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, Fill, OpenPosition } from '../../shared/index.js';
import type { StoreMode } from '../../shared/store/index.js';
import { buildPipelineView, PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
import { NULL_PROVIDER_STATUS, type ProviderStatusReader } from './provider-status.js';
import type {
  ClosedTradeRow,
  DashboardQueryStore,
  DashboardSnapshot,
  FillRow,
  PositionRow,
} from './types.js';

/** Matches the CLI views' default recent-history window; no config surface yet. */
const RECENT_DEBATES_LIMIT = 10;
const RECENT_VERDICTS_LIMIT = 10;
/** #940: same window size as the other recent-history lists above. */
const RECENT_CLOSED_TRADES_LIMIT = 10;

/**
 * The directions the wire may carry, as a value rather than a type. Same
 * `Record<Union, true>` device as `pipeline-query.ts`'s `RUNTIME_STAGES`: the
 * `Direction` union is the authority, so a new member stops this compiling
 * instead of silently passing an unrenderable stance through.
 */
const WIRE_DIRECTIONS: Record<Direction, true> = { bullish: true, bearish: true, neutral: true };

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && Object.hasOwn(WIRE_DIRECTIONS, value);
}

/**
 * Per-round stances, projected only when EVERY element is a `Direction` —
 * `contributions` is `JSON.parse` output of `debate_log.contributions_json`,
 * so its declared type is a claim about the row, not a guarantee. Missing or
 * corrupt omits the field, which the strip renders as its stated empty state;
 * filtering bad elements out would show a 3-round debate as a 2-round history.
 */
function stanceDuringDebate(
  contribution: AnalystContribution,
): { stance_during_debate: Direction[] } | Record<string, never> {
  const stances = contribution.stance_during_debate;
  if (!Array.isArray(stances) || !stances.every(isDirection)) return {};
  return { stance_during_debate: stances };
}

/**
 * Unrealized PnL from the current mark. Buy: mark − entry; sell: entry − mark.
 * Times `filled_size`, never `requested_size`.
 */
function unrealizedPnl(position: OpenPosition, markPrice: number): number {
  const diff =
    position.side === 'buy'
      ? markPrice - position.avg_entry_price
      : position.avg_entry_price - markPrice;
  return diff * position.filled_size;
}

/**
 * A closed trade's realized exit price, preferring reality over arithmetic.
 *
 * `closed_trades` has no `exit_price` column (0001_init.sql), so this is
 * always derived — but there are two ways to derive it, and they are not
 * equally trustworthy:
 *
 * 1. **The trade's own exit fills** (`leg !== 'entry'`): the venue's actual
 *    fill prices, qty-weighted. This is what really happened.
 * 2. **Algebra against `realized_pnl_net`**: `entry + (realized_pnl_net +
 *    fees_total) / filled_size` (sign-flipped for a sell). Exact when 1 is
 *    unavailable, but only as good as `entry` — which comes from real data
 *    here: `ClosedTrade.entry` is the avg entry fill price and `.stop` the
 *    original bracket's stop, both set in `ingest-fills.ts` from
 *    `avgEntryPrice`/`position.stop`. That is a different path from #826's
 *    zeroing, which applies to the flatten `OrderIntent`'s own
 *    entry/stop/target fields on a no-reference-price close, not to this
 *    trade's recorded `entry`/`stop`.
 *
 * `weightedExitFillPrice` is tried first; the algebraic fallback only runs
 * when a trade has no exit fill on record.
 */
function weightedExitFillPrice(fills: readonly Fill[]): number | null {
  const exitFills = fills.filter((fill) => fill.leg !== 'entry');
  if (exitFills.length === 0) return null;
  let totalQty = 0;
  let totalNotional = 0;
  for (const fill of exitFills) {
    totalQty += fill.qty;
    totalNotional += fill.price * fill.qty;
  }
  if (totalQty === 0) return null;
  return totalNotional / totalQty;
}

function derivedExitPrice(trade: ClosedTrade): number {
  const grossPnl = trade.realized_pnl_net + trade.fees_total;
  const delta = grossPnl / trade.filled_size;
  return trade.side === 'buy' ? trade.entry + delta : trade.entry - delta;
}

function exitPriceFor(trade: ClosedTrade, fillsByTrade: ReadonlyMap<string, Fill[]>): number {
  const fills = fillsByTrade.get(trade.idempotency_key) ?? [];
  return weightedExitFillPrice(fills) ?? derivedExitPrice(trade);
}

/**
 * `providers` defaults to `NULL_PROVIDER_STATUS` (every tile
 * `not_configured`) rather than being required, so a dashboard started without
 * third-party credentials — and every existing test that calls this with two
 * arguments — keeps working. The reader is injected rather than called
 * directly because it is the one input here that is live, timer-refreshed
 * state; taking it as a parameter is what preserves this function's purity.
 *
 * `mode` is required and has NO default, deliberately (#539). It is the run
 * the operator is looking at, and the one wrong answer that matters is
 * "paper" during a live run — so the caller that resolved `SAMURAI_MODE`
 * states it, and a caller that never resolved one does not compile. It sits
 * before `providers` for the same reason: a defaulted trailing parameter is
 * exactly the shape that lets a new call site forget it.
 */
export function buildSnapshot(
  store: DashboardQueryStore,
  asOf: Date,
  mode: StoreMode,
  providers: ProviderStatusReader = NULL_PROVIDER_STATUS,
): DashboardSnapshot {
  const openPositions = store.getOpenPositions(asOf);
  // One query for every position's mark rather than one per position — this
  // runs per dashboard HTTP request, not per tick. `getMarks` still throws for
  // an instrument with no mark, so a priceless row can never be rendered.
  const marks = store.getMarks(
    openPositions.map((position) => position.instrument),
    asOf,
  );

  const positions = openPositions.map<PositionRow>((position) => {
    const mark = marks.get(position.instrument) as Mark;
    return {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      asset_class: position.asset_class,
      side: position.side,
      filled_size: position.filled_size,
      avg_entry_price: position.avg_entry_price,
      stop: position.stop,
      target: position.target,
      order_state: position.order_state,
      mark_price: mark.price,
      unrealized_pnl: unrealizedPnl(position, mark.price),
      opened_at: position.opened_at.toISOString(),
    };
  });

  const debates = store.getRecentDebates(RECENT_DEBATES_LIMIT, asOf).map((debate) => ({
    debate_id: debate.debate_id,
    instrument: debate.instrument,
    direction: debate.direction,
    rounds: debate.rounds,
    created_at: debate.created_at.toISOString(),
    contributions: debate.contributions.map((c) => ({
      analyst_id: c.analyst_id,
      analyst_type: c.analyst_type,
      final_position: c.final_position,
      influence_score: c.influence_score,
      // #427/#599: how an analyst got there, not only where it ended up.
      ...stanceDuringDebate(c),
    })),
  }));

  const verdicts = store.getVerdictHistory(RECENT_VERDICTS_LIMIT, asOf).map((v) => ({
    trace_id: v.trace_id,
    instrument: v.instrument,
    status: v.status,
    reason: v.reason,
    hitl_override: v.hitl_override,
    timestamp: v.timestamp.toISOString(),
  }));

  const weights = store.getAnalystWeights(asOf);
  const attribution = store.getAttribution(asOf);
  const analysts = Object.keys(weights).map((analyst_id) => ({
    analyst_id,
    weight: weights[analyst_id] ?? 0,
    rolling_r: attribution[analyst_id]?.rolling_r ?? 0,
    window_days: attribution[analyst_id]?.window_days ?? 0,
  }));

  const metrics = store.getDailyMetrics(asOf);
  const tickStatus = store.getTickStatus(asOf);

  // #940: closed trades and their fills. Fills are fetched FOR the trades
  // just read (`getFillsForTrades`, keyed by idempotency_key) rather than as
  // an independent "recent fills" window — a separately-limited recent-fills
  // query would silently starve older closed trades of their fills the
  // moment open-position churn fills the window with entry-leg noise.
  const closedTradesDomain = store.getRecentClosedTrades(RECENT_CLOSED_TRADES_LIMIT, asOf);
  const tradeFills = store.getFillsForTrades(
    closedTradesDomain.map((trade) => trade.idempotency_key),
    asOf,
  );
  const fillsByTrade = new Map<string, Fill[]>();
  for (const fill of tradeFills) {
    const forTrade = fillsByTrade.get(fill.idempotency_key);
    if (forTrade === undefined) {
      fillsByTrade.set(fill.idempotency_key, [fill]);
    } else {
      forTrade.push(fill);
    }
  }

  const closed_trades = closedTradesDomain.map<ClosedTradeRow>((trade) => ({
    idempotency_key: trade.idempotency_key,
    debate_id: trade.debate_id,
    instrument: trade.instrument,
    asset_class: trade.asset_class,
    side: trade.side,
    entry_price: trade.entry,
    exit_price: exitPriceFor(trade, fillsByTrade),
    filled_size: trade.filled_size,
    realized_pnl_net: trade.realized_pnl_net,
    fees_total: trade.fees_total,
    opened_at: trade.opened_at.toISOString(),
    closed_at: trade.closed_at.toISOString(),
    close_reason: trade.close_reason,
  }));

  const fills = tradeFills.map<FillRow>((fill) => ({
    idempotency_key: fill.idempotency_key,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: fill.fee,
    timestamp: fill.timestamp.toISOString(),
  }));

  return {
    generated_at: new Date().toISOString(),
    as_of: asOf.toISOString(),
    mode,
    tick_status: tickStatus,
    positions,
    closed_trades,
    fills,
    debates,
    verdicts,
    analysts,
    metrics,
    providers: providers.readProviderStatus(),
    llm_spend: store.getLlmSpend(asOf),
    // Same `asOf` as every other field above, which is the reason the Pipeline
    // view rides this payload instead of its own endpoint: two polls would let
    // the lanes and the tables describe different instants and leave the
    // operator to reconcile them.
    pipeline: buildPipelineView(
      store.getPipelineActivity(PIPELINE_MAX_LANES, PIPELINE_LOOKBACK_MS, asOf),
    ),
  };
}
