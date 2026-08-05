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
import type { OpenPosition } from '../shared/index.js';
import { NULL_PROVIDER_STATUS, type ProviderStatusReader } from './provider-status.js';
import type { DashboardQueryStore, DashboardSnapshot, PositionRow } from './types.js';

/** Matches the CLI views' default recent-history window; no config surface yet. */
const RECENT_DEBATES_LIMIT = 10;
const RECENT_VERDICTS_LIMIT = 10;

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
 * `providers` defaults to `NULL_PROVIDER_STATUS` (every tile
 * `not_configured`) rather than being required, so a dashboard started without
 * third-party credentials — and every existing test that calls this with two
 * arguments — keeps working. The reader is injected rather than called
 * directly because it is the one input here that is live, timer-refreshed
 * state; taking it as a parameter is what preserves this function's purity.
 */
export function buildSnapshot(
  store: DashboardQueryStore,
  asOf: Date,
  providers: ProviderStatusReader = NULL_PROVIDER_STATUS,
): DashboardSnapshot {
  const positions = store.getOpenPositions(asOf).map<PositionRow>((position) => {
    const mark = store.getMark(position.instrument, asOf);
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

  return {
    generated_at: new Date().toISOString(),
    as_of: asOf.toISOString(),
    tick_status: tickStatus,
    positions,
    debates,
    verdicts,
    analysts,
    metrics,
    providers: providers.readProviderStatus(),
    llm_spend: store.getLlmSpend(asOf),
  };
}
