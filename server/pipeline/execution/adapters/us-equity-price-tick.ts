
const TICK_AT_OR_ABOVE_ONE_DOLLAR = 0.01;
const TICK_BELOW_ONE_DOLLAR = 0.0001;

export function tickFor(price: number): number {
  return price < 1 ? TICK_BELOW_ONE_DOLLAR : TICK_AT_OR_ABOVE_ONE_DOLLAR;
}

const decimalsFor = (tick: number): number => (tick === TICK_BELOW_ONE_DOLLAR ? 4 : 2);

export function snapToTick(value: number, direction: 'up' | 'down'): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`snapToTick: price must be a positive finite number, got ${value}`);
  }
  const tick = tickFor(value);
  const decimals = decimalsFor(tick);
  const scaled = value / tick;
  const nearest = Math.round(scaled);

  const steps =
    Math.abs(scaled - nearest) <= Math.abs(scaled) * Number.EPSILON * 4
      ? nearest
      : direction === 'up'
        ? Math.ceil(scaled)
        : Math.floor(scaled);

  if (steps <= 0) {
    throw new Error(
      `snapToTick: ${value} rounded ${direction} onto the ${tick} grid collapses to a non-positive price`,
    );
  }

  return Number((steps * tick).toFixed(decimals));
}

export function formatTickPrice(value: number): string {
  return value.toFixed(decimalsFor(tickFor(value)));
}

type Leg = 'entry' | 'stop' | 'target';

const TOWARD_ENTRY: Record<'buy' | 'sell', Record<Leg, 'up' | 'down'>> = {
  buy: { entry: 'down', stop: 'up', target: 'down' },
  sell: { entry: 'up', stop: 'down', target: 'up' },
};

export interface TickRoundedBracket {
  entry: number;
  stop: number;
  target: number;
}

function refuseIfCollapsed(ordered: boolean, detail: string): void {
  if (!ordered) {
    throw new Error(
      `rounding onto the venue price grid collapsed the bracket's ordering (${detail}). The ` +
        'bracket is narrower than the venue can express; it is refused rather than submitted ' +
        'inverted.',
    );
  }
}

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
