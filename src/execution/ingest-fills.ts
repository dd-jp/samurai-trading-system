/**
 * Execution's second surface — `ingestFills()` (ticket #83). See
 * docs/specs/execution-spec.md ("Module: Order State Machine & Partial
 * Fills", "Module: Trade-Record Schema").
 *
 * A bracket's lifecycle outlives the `execute()` that placed it — a stock's
 * exit leg may fill days later — so advancing it is a separate, pollable
 * surface. Per live lot: drain the venue's fill feed, persist each new `Fill`,
 * resize the protective legs to cumulative filled quantity, and on
 * round-trip-to-flat emit the `ClosedTrade` the Feedback Loop and Risk read.
 *
 * It reads the broker's fill feed, not the broker's opinion of the store:
 * correcting store-vs-broker divergence is #86's `reconcile()`.
 *
 * Idempotent by construction, because polling is the access pattern: fills
 * dedup on `broker_fill_id`, and a lot closes once because closing makes it
 * terminal and terminal lots leave `getOpenPositions()`.
 */
import type { ClosedTrade, Fill, OpenPosition, OrderState } from '../shared/index.js';
import type { ExecutionInput, NormalizedFill } from './types.js';

/** A fill on a protective/closing leg — anything that isn't opening the lot. */
type ExitFill = Fill & { leg: 'stop' | 'target' | 'exit' };

export async function ingestFills(input: ExecutionInput): Promise<void> {
  const { clock, broker, store } = input;
  const now = clock.now();

  const positions = await store.getOpenPositions();
  if (positions.length === 0) return;

  // The feed's floor is the oldest live lot: no fill of ours predates the
  // `execute()` that opened the lot it belongs to. Re-offered fills are
  // expected and handled by the dedup below, so this only bounds the query.
  const since = earliest(positions.map((position) => position.opened_at));
  const fills = await broker.fetchNewFills(since);

  for (const position of positions) {
    await advanceLot(input, position, fills, now);
  }
}

async function advanceLot(
  input: ExecutionInput,
  position: OpenPosition,
  fills: readonly NormalizedFill[],
  now: Date,
): Promise<void> {
  const { broker, store } = input;

  const lotFills = fills.filter(
    (fill) =>
      fill.client_order_id === position.idempotency_key &&
      // No lookahead: in a backtest the feed is the whole simulated future,
      // and a fill dated past T has not happened yet.
      fill.timestamp.getTime() <= now.getTime(),
  );

  let ingested = 0;
  let ingestedEntry = false;
  for (const fill of lotFills) {
    if (await store.hasFill(fill.broker_fill_id)) continue;
    await store.writeFill(toFill(fill, position.idempotency_key));
    ingested += 1;
    ingestedEntry ||= fill.leg === 'entry';
  }

  // Nothing landed: the lot is exactly as the last poll left it.
  if (ingested === 0) return;

  // Recomputed from the persisted rows, never from a running total — the
  // `Fill` rows are the record, and rebuilding from them is what makes a
  // re-poll converge on the same numbers instead of drifting.
  const recorded = await store.getFills(position.idempotency_key);
  const entryFills = recorded.filter((fill) => fill.leg === 'entry');
  const exitFills = recorded.filter(isExitFill);

  const filledSize = totalQty(entryFills);
  // An exit fill cannot precede the entry fill that created the lot to exit.
  // If one somehow arrives first, there is no lot to size or close yet.
  if (filledSize === 0) return;

  const avgEntryPrice = weightedAvgPrice(entryFills);
  const flat = coversQty(totalQty(exitFills), filledSize);
  const orderState = nextState(position, filledSize, flat);

  // Size the protection to what actually filled, before persisting the
  // advance: leaving a lot under-protected is the failure that costs money,
  // and only a fresh entry fill can have changed the quantity to protect.
  if (!flat && ingestedEntry) {
    await broker.resizeProtectiveLegs(position.idempotency_key, filledSize);
  }

  await store.updatePositionFill(position.idempotency_key, {
    filled_size: filledSize,
    avg_entry_price: avgEntryPrice,
    order_state: orderState,
  });

  if (!flat) return;

  await store.writeClosedTrade(
    closedTrade(position, { filledSize, avgEntryPrice, entryFills, exitFills }),
  );
}

/**
 * `partially_filled` while the entry is still working, `filled` once it is
 * complete, `closed` on round-trip-to-flat. A lot that fills and exits
 * between two polls lands on `closed` directly — the intermediate states are
 * a description of reality, not a queue every lot must pass through.
 */
function nextState(position: OpenPosition, filledSize: number, flat: boolean): OrderState {
  if (flat) return 'closed';
  return coversQty(filledSize, position.requested_size) ? 'filled' : 'partially_filled';
}

/**
 * Relative tolerance on the quantity comparisons, because both sides are
 * float64 sums of decimal `Fill.qty` rows and two sums of the SAME total
 * differ unless the tranches happen to share a summation order: entry
 * tranches of 0.3 + 0.3 + 0.4 total exactly 1, while exit tranches of
 * 0.7 + 0.2 + 0.1 total 0.9999999999999999. A bare `>=` therefore reads a
 * fully-exited lot as still open — forever, since no further fill is coming:
 * no `ClosedTrade` for the Feedback Loop, and a phantom lot left in
 * `getOpenPositions()` consuming Risk's exposure caps.
 *
 * The margin over float noise, measured against the same (n+2)·2^-53 bound
 * ADR-0005 §1 derives (n products, an n-term naive summation, one division),
 * is 88x at n = 100 fills (1.13e-14) and 36x at the 250-fills-per-leg worst
 * case (2.80e-14) — comfortable, but tens of times, NOT orders of
 * magnitude: a workload past ~9,000 fills on one leg would need this
 * constant revisited. The margin in the other direction is the wide one: a
 * residue of 1e-12 of a lot is orders below any venue's minimum quantity
 * increment, so it does not exist at the broker either and a lot that reads
 * flat here is flat there too. The tolerance has to carry that argument on
 * its own — `reconcile()` (#86) only inspects `pending`/`submitted` lots, so
 * it never revisits one this code has marked terminal.
 * See [ADR-0005](../../docs/adr/0005-money-math-precision.md).
 */
const QTY_EPSILON_RELATIVE = 1e-12;

/** `actual >= target`, tolerant of float64 summation noise on either side. */
function coversQty(actual: number, target: number): boolean {
  return actual >= target - Math.abs(target) * QTY_EPSILON_RELATIVE;
}

function closedTrade(
  position: OpenPosition,
  lot: {
    filledSize: number;
    avgEntryPrice: number;
    entryFills: readonly Fill[];
    exitFills: readonly ExitFill[];
  },
): ClosedTrade {
  const { filledSize, avgEntryPrice, entryFills, exitFills } = lot;

  // The fill that took the lot flat — it names how the trade ended and when.
  const closing = exitFills[exitFills.length - 1] as ExitFill;
  const avgExitPrice = weightedAvgPrice(exitFills);

  // Signed against the direction of the lot: a short earns the fall.
  const gross =
    position.side === 'buy'
      ? (avgExitPrice - avgEntryPrice) * filledSize
      : (avgEntryPrice - avgExitPrice) * filledSize;
  const feesTotal = [...entryFills, ...exitFills].reduce((sum, fill) => sum + fill.fee, 0);

  return {
    idempotency_key: position.idempotency_key,
    debate_id: position.debate_id,
    instrument: position.instrument,
    asset_class: position.asset_class,
    side: position.side,
    entry: avgEntryPrice,
    // The lot's INITIAL stop, carried from the bracket — R's denominator is
    // the risk taken at open.
    stop: position.stop,
    filled_size: filledSize,
    realized_pnl_net: gross - feesTotal,
    fees_total: feesTotal,
    opened_at: position.opened_at,
    closed_at: closing.timestamp,
    close_reason: closing.leg,
  };
}

/** Normalized broker shape → the stored record, keyed to its lot. */
function toFill(fill: NormalizedFill, idempotencyKey: string): Fill {
  return {
    idempotency_key: idempotencyKey,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: fill.fee,
    timestamp: fill.timestamp,
    ...(fill.cost_breakdown === undefined ? {} : { cost_breakdown: fill.cost_breakdown }),
  };
}

function isExitFill(fill: Fill): fill is ExitFill {
  return fill.leg !== 'entry';
}

function totalQty(fills: readonly Fill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

/** Size-weighted, so two unequal partials give the true average. */
function weightedAvgPrice(fills: readonly Fill[]): number {
  const qty = totalQty(fills);
  if (qty === 0) return 0;
  return fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / qty;
}

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((min, date) => (date.getTime() < min.getTime() ? date : min));
}
