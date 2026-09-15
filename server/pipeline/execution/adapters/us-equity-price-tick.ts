/**
 * The US-equity minimum pricing increment, and the directional rounding that
 * puts a computed bracket onto it (#983).
 *
 * MEASURED, not assumed. Against live Alpaca paper on 2026-09-01, a
 * whole-share SPY bracket whose only defect was price precision:
 *
 *   limit_price "762.335"  ->  422 {"code":42210000,"message":"invalid
 *                               limit_price 762.335. sub-penny increment does
 *                               not fulfill minimum pricing criteria"}
 *   limit_price "762.34"   ->  200
 *
 * The stop and target are computed as bracket multiples of the entry, so they
 * carry full float precision (`766.40805334`) and the adapter used to forward
 * every digit. This module is the second half of the same lesson as #941's
 * whole-share grid: a venue's submission constraints are the adapter's
 * problem, applied at the boundary, never the strategy's.
 *
 * WHY DIRECTION MATTERS. A bare `toFixed` would round each leg to whichever
 * side is nearer, which for a stop can mean WIDENING the loss past what the
 * Risk Manager approved — quantisation silently handing back exposure a gate
 * just removed. Every leg here moves TOWARD the entry instead, so rounding can
 * only ever shrink risk and shrink reward. `TOWARD_ENTRY` below is that rule,
 * as a table rather than prose: for a long, the entry limit is the most it
 * will pay (down never pays more), the stop sits below the entry (up is a
 * smaller loss) and the target above it (down is an earlier, easier fill). A
 * short mirrors all three.
 */

/** SEC Rule 612: a penny at or above $1.00, an order of magnitude finer below */
const TICK_AT_OR_ABOVE_ONE_DOLLAR = 0.01;
const TICK_BELOW_ONE_DOLLAR = 0.0001;

/**
 * The tick is a property of the PRICE, not of the order, so it is resolved per
 * leg: a bracket straddling $1.00 has legs on two different grids.
 *
 * NOT a claim about the live book. This is Rule 612's USD grid on Alpaca, the
 * paper venue; the live venue is Saxo (ADR-0015, 2026-08-30) and LSE tick
 * bands in GBX are its own rules, not these. Nothing routes through this
 * module live. The sub-dollar branch is implemented because the rule has two
 * bands and hardcoding one would be wrong, not because a live instrument
 * needs it — on the current paper universe (SPY/QQQ/AAPL/TSLA) it never fires.
 */
export function tickFor(price: number): number {
  return price < 1 ? TICK_BELOW_ONE_DOLLAR : TICK_AT_OR_ABOVE_ONE_DOLLAR;
}

const decimalsFor = (tick: number): number => (tick === TICK_BELOW_ONE_DOLLAR ? 4 : 2);

/**
 * Snap `value` onto its tick grid, in the named direction.
 *
 * The on-tick short-circuit is not an optimisation, and it is the same defect
 * class #941 guarded with `originalNotional`: `766.41 / 0.01` is
 * `76641.00000000001`, so a `Math.ceil` on an ALREADY VALID price would bump it
 * a whole tick every time. A price the venue would have accepted verbatim must
 * come back unchanged.
 *
 * The result is rebuilt through `toFixed` rather than returned as
 * `n * tick`, because that multiply reintroduces exactly the float dust this
 * exists to remove — `76641 * 0.01` is not `766.41`, and `String()`-ing it
 * back onto the wire would be refused for the same reason as the original.
 */
export function snapToTick(value: number, direction: 'up' | 'down'): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`snapToTick: price must be a positive finite number, got ${value}`);
  }
  const tick = tickFor(value);
  const decimals = decimalsFor(tick);
  const scaled = value / tick;
  const nearest = Math.round(scaled);

  // Tolerance, not equality: the division above is itself lossy, so an on-tick
  // price arrives a few ULPs to one side of the integer rather than on it
  //
  // The tolerance is RELATIVE, not a flat 1e-9, because that dust scales with
  // the magnitude of `scaled`. Measured over every penny price up to $200k, it
  // first exceeds 1e-9 at $111,848.18 (1.86e-9) — so a flat bound would bump an
  // already-valid price a full tick above that, the exact defect this guard
  // exists to prevent. Unreachable on today's universe; BRK.A is not.
  const steps =
    Math.abs(scaled - nearest) <= Math.abs(scaled) * Number.EPSILON * 4
      ? nearest
      : direction === 'up'
        ? Math.ceil(scaled)
        : Math.floor(scaled);

  // A price below one tick floors to zero. Nothing on today's path can reach
  // here — both callers' ordering guards refuse a collapsed bracket first — but
  // the contract above promises a positive price, so it is enforced here rather
  // than left resting on a caller that may not exist yet
  if (steps <= 0) {
    throw new Error(
      `snapToTick: ${value} rounded ${direction} onto the ${tick} grid collapses to a non-positive price`,
    );
  }

  return Number((steps * tick).toFixed(decimals));
}

/** The wire form: fixed to the leg's own tick, never `String(float)` */
export function formatTickPrice(value: number): string {
  return value.toFixed(decimalsFor(tickFor(value)));
}

type Leg = 'entry' | 'stop' | 'target';

/**
 * The direction each leg rounds, per entry side. ONE table, consulted by both
 * exported functions — the rule is a value here, so it is greppable and
 * assertable rather than restated in two branches that can drift apart.
 */
const TOWARD_ENTRY: Record<'buy' | 'sell', Record<Leg, 'up' | 'down'>> = {
  buy: { entry: 'down', stop: 'up', target: 'down' },
  sell: { entry: 'up', stop: 'down', target: 'up' },
};

export interface TickRoundedBracket {
  entry: number;
  stop: number;
  target: number;
}

/**
 * Shared by both entry points: rounding can only ever pull a leg toward the
 * entry, so the ONLY way it can go wrong is by pulling two legs onto the same
 * tick and inverting their order. That is checked once, here, rather than
 * duplicated per branch. It needs a bracket under about two ticks wide to
 * fire — unreachable on the current universe, where ADR-0018's neutral bracket
 * on a $762 name is dollars wide — but it is guarded because the alternative
 * is submitting an inverted bracket, and a stop on the wrong side of the entry
 * is an order that fires instantly for the maximum loss.
 */
function refuseIfCollapsed(ordered: boolean, detail: string): void {
  if (!ordered) {
    throw new Error(
      `rounding onto the venue price grid collapsed the bracket's ordering (${detail}). The ` +
        'bracket is narrower than the venue can express; it is refused rather than submitted ' +
        'inverted.',
    );
  }
}

/**
 * Round a whole entry bracket onto the venue's grid.
 *
 * `side` is the ENTRY side, matching `NativeBracketRequest.side`.
 */
export function roundBracketToTick(
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  target: number,
): TickRoundedBracket {
  const toward = TOWARD_ENTRY[side];
  const rounded: TickRoundedBracket = {
    entry: snapToTick(entry, toward.entry),
    stop: snapToTick(stop, toward.stop),
    target: snapToTick(target, toward.target),
  };

  refuseIfCollapsed(
    side === 'buy'
      ? rounded.stop < rounded.entry && rounded.entry < rounded.target
      : rounded.target < rounded.entry && rounded.entry < rounded.stop,
    `${side} entry ${entry}, stop ${stop}, target ${target} became entry ${rounded.entry}, ` +
      `stop ${rounded.stop}, target ${rounded.target}`,
  );

  return rounded;
}

/**
 * The protective-leg half, for re-arming a lot that already filled (there is
 * no entry left to place). `heldSide` is the side of the POSITION, so it
 * selects the same row of `TOWARD_ENTRY` the entry used.
 *
 * Ordering is checked on the pair alone: without an entry the invariant that
 * survives is that a long's stop stays below its target, and a short's above.
 */
export function roundProtectiveLegsToTick(
  heldSide: 'buy' | 'sell',
  stop: number,
  target: number,
): { stop: number; target: number } {
  const toward = TOWARD_ENTRY[heldSide];
  const rounded = {
    stop: snapToTick(stop, toward.stop),
    target: snapToTick(target, toward.target),
  };

  refuseIfCollapsed(
    heldSide === 'buy' ? rounded.stop < rounded.target : rounded.target < rounded.stop,
    `${heldSide} lot stop ${stop}, target ${target} became stop ${rounded.stop}, target ` +
      `${rounded.target}`,
  );

  return rounded;
}
