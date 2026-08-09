/**
 * Alpaca order/fill normalization shared by the two consumers of the wire
 * shape: `AlpacaBrokerAdapter` (the native equities path) and
 * `AlpacaCryptoLegEmulation` (#586's emulated crypto path). Split out of
 * alpaca-adapter.ts on PR #600 review to break a genuine runtime import
 * cycle — the adapter constructs the emulation, so the emulation must not
 * import the adapter back for these; both import THIS module instead, and
 * one copy of the unpriced-fill refusal cannot drift from the other.
 *
 * Everything here is a pure function of one order (plus `UnpricedFillError`,
 * the typed refusal `collectFill` throws) — no venue calls, no state.
 */
import type { OrderState } from '../../../shared/index.js';
import type { UnpricedFillObservation } from '../broker-state-store.js';
import type { NormalizedFill } from '../types.js';
import type { AlpacaOrder, AlpacaOrderLeg } from './alpaca-client.js';

/**
 * A fill the venue reports filled and cannot price. Carries the observation so
 * `fetchNewFills` can start (or continue) its age-out clock — the plain `Error`
 * this replaces left the sweep nothing to remember it by.
 *
 * Thrown rather than returned so the existing per-bracket isolation is
 * unchanged: a bracket whose entry cannot be priced must not have its exit legs
 * booked either.
 */
export class UnpricedFillError extends Error {
  readonly observation: UnpricedFillObservation;

  constructor(message: string, observation: UnpricedFillObservation) {
    super(message);
    this.name = 'UnpricedFillError';
    this.observation = observation;
  }
}

/**
 * `instrument` comes from the BRACKET PARENT, not from `order`: `AlpacaOrderLeg`
 * carries no `symbol`, and an alert that cannot name the symbol is not
 * actionable. A bracket's legs trade the parent's symbol by construction.
 */
export function collectFill(
  order: AlpacaOrder | AlpacaOrderLeg,
  leg: NormalizedFill['leg'],
  clientOrderId: string,
  instrument: string,
  since: Date,
  fills: NormalizedFill[],
): void {
  const filledQty = Number.parseFloat(order.filled_qty);

  // `NaN <= 0` is FALSE, so an unparseable quantity ('', 'N/A', anything
  // non-numeric) would sail past the guard below and be booked as `qty: NaN` —
  // which then silently propagates through weighted-average pricing, realized
  // PnL and the R-multiple, poisoning every figure it touches without ever
  // failing. Checked before the ordering guard for exactly that reason.
  if (!Number.isFinite(filledQty)) {
    throw new Error(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports an unparseable ` +
        `filled_qty '${order.filled_qty}'`,
    );
  }

  if (filledQty <= 0 || order.filled_at === null) {
    return;
  }

  const filledAt = new Date(order.filled_at);
  if (filledAt.getTime() < since.getTime()) {
    return;
  }

  // A positive filled quantity with no average price is Alpaca contradicting
  // itself, and there is no safe way to record it: a zero price is not a
  // conservative guess but a fabricated one, and it flows straight into
  // realized PnL, the R-multiple and the feedback loop's weighting — a lot
  // booked at 0 reads as a total loss or an infinite gain depending on side.
  // Same posture the ccxt adapter takes in `toFill`: refuse rather than
  // silently degrade, and let the poll retry once the venue is coherent.
  //
  // "Let the poll retry" is only half an answer, though, and the other half is
  // #298: if the venue NEVER prices this fill, retrying forever is silence.
  // The typed error carries what the caller needs to start an age-out clock on
  // it — refusing to book the fill and refusing to notice are different things.
  if (order.filled_avg_price === null) {
    throw new UnpricedFillError(
      `Alpaca order ${order.id} (${leg} leg of '${clientOrderId}') reports filled_qty ` +
        `${order.filled_qty} but no filled_avg_price to record`,
      {
        client_order_id: clientOrderId,
        broker_fill_id: order.id,
        leg,
        instrument,
        qty: filledQty,
      },
    );
  }

  fills.push({
    client_order_id: clientOrderId,
    broker_fill_id: order.id,
    leg,
    price: Number.parseFloat(order.filled_avg_price),
    qty: filledQty,
    // Alpaca is commission-free on US equities; crypto fee attribution is
    // deferred (out of scope for this ticket's entry/stop-out equities path).
    fee: 0,
    timestamp: filledAt,
  });
}

/**
 * Alpaca's crypto trading endpoints reject dash-form symbols outright — an
 * order for `'BTC-USD'` gets a `422 asset "BTC-USD" not found` (#550, PR
 * #584, empirically verified) — and only accept slash form (`'BTC/USD'`).
 * Equities are unaffected either way (`'AAPL'` has no separator to convert).
 *
 * This is the ONE seam that must translate: the rest of the system speaks
 * dash-form crypto exclusively (ADR-0001's `BrokerAdapter` abstraction;
 * `DEFAULT_UNIVERSE`/`SMOKE_TEST_UNIVERSE` in orchestrator/scheduler.ts and
 * orchestrator/production.ts both spell it `'BTC-USD'`/`'ETH-USD'`), and no
 * conversion existed anywhere in the trading path before this ticket. Mirrors
 * the already-verified conversion the market-data path independently arrived
 * at for the same reason (`toAlpacaCryptoSymbol`,
 * market-data-service/sources/alpaca-http-client.ts, #358) — same `-USD`
 * suffix rule, same believed-correct-because-verified posture. That path is
 * untouched by this change and does its own conversion on its own requests;
 * this function does not call it, to keep the two modules' seams independent.
 *
 * `submitBracket` carries an explicit `asset_class` on `NativeBracketRequest`
 * and is asked directly rather than guessing from the symbol's shape.
 * `submitFlatten`/`rearmProtectiveLegs` receive only a bare `instrument`
 * string on the `BrokerAdapter` interface — no `asset_class` alongside it —
 * so `assetClass` is `undefined` at those two call sites and this falls back
 * to the syntactic `-USD`-suffix rule.
 *
 * That fallback is safe for every instrument this adapter is configured to
 * ever see: `DEFAULT_UNIVERSE`/`SMOKE_TEST_UNIVERSE` list crypto ONLY as
 * `'BTC-USD'`/`'ETH-USD'` (both `-USD`-suffixed) and equities ONLY as bare
 * tickers with no separator at all (`'SPY'`, `'QQQ'`, `'AAPL'`, `'TSLA'`) — so
 * a `-USD` suffix unambiguously means crypto today. It would NOT misfire on a
 * dotted-class equity ticker such as `'BRK.B'` (no `-USD` suffix, so it
 * passes through unchanged) — the narrower "`-USD` suffix" test is
 * deliberately chosen over a broader "contains a dash" one for exactly this
 * reason, even though neither rule can currently be exercised by a dashed
 * equity ticker, since the configured universes have none. If a future
 * instrument violates either assumption (a `-USD`-suffixed equity, or a
 * crypto pair this adapter must submit through `submitFlatten`/
 * `rearmProtectiveLegs` without ever having gone through `submitBracket`
 * first), this must become explicit-list or asset-class-driven instead of
 * syntactic.
 */
export function toAlpacaSymbol(instrument: string, assetClass?: 'crypto' | 'stocks'): string {
  const isCrypto = assetClass === undefined ? instrument.endsWith('-USD') : assetClass === 'crypto';
  if (!isCrypto || !instrument.endsWith('-USD')) return instrument;
  return `${instrument.slice(0, -'-USD'.length)}/USD`;
}

/**
 * The read-back inverse of `toAlpacaSymbol`: `'BTC/USD'` -> `'BTC-USD'`.
 * Applied to every symbol the venue hands back before it reaches anything
 * that compares it against, or stores it under, the repo's own instrument
 * identity — `getOpenPositions` (Risk's exposure caps, `reconcile()`'s
 * store-vs-venue diff) and `fetchNewFills`'s three `symbolOf` call sites
 * (bracket, flatten, re-arm sweeps), which feed the age-out alert an operator
 * reads. Nothing above this adapter's boundary may ever see Alpaca's slash
 * form — the same ADR-0001 abstraction `toAlpacaSymbol` documents above.
 *
 * Narrowed to a `/USD`-suffix test, mirroring `toAlpacaSymbol`'s own
 * `-USD`-suffix rule on the way out, rather than "contains a slash" — no
 * equity symbol Alpaca returns contains a `/` today, so a broader rule would
 * currently behave identically, but the narrower one is what keeps this
 * function from silently mangling a future non-crypto venue symbol that
 * happens to contain a `/` for some other reason (Alpaca has no such symbol
 * today; a hypothetical options contract or foreign-listing spelling might).
 * Review comment on PR #588.
 */
export function fromAlpacaSymbol(symbol: string): string {
  return symbol.endsWith('/USD') ? `${symbol.slice(0, -'/USD'.length)}-USD` : symbol;
}

export function mapOrderState(status: string): OrderState {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    // 'new' | 'accepted' | 'pending_new' | 'accepted_for_bidding' and any
    // other acknowledgement status: the bracket has landed at the venue but
    // nothing has filled yet, which is 'submitted' in our state machine.
    default:
      return 'submitted';
  }
}
