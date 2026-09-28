import type { Sleeve, SleeveContext, SleeveDecision, Venue } from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import type { BarsSource } from '../data/index.js';
import { inputsHash } from '../journal/index.js';
import {
  actionFor,
  createTechnicalSleeve,
  directionFrom,
  resolveTechnical,
  SMA_LONG_WINDOW,
  skipped,
  stopFor,
} from './debate-sleeve.js';
import {
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  ARM2_SLEEVE_SPEC,
  requireSet,
} from './parameters.js';

const HASHED_HISTORY_DAYS = SMA_LONG_WINDOW;

// No `panel` and no `news`: arm 2 is technical-only by construction (#1773), so it
// cannot make an LLM call or read a headline even if a future edit tried to add one
export interface Arm2SleeveDeps {
  readonly bars: BarsSource;
  readonly constituents: (tradingDate: string) => readonly string[];
  readonly venueFor: (symbol: string) => Venue;
  readonly clock: Clock;
}

async function decideOne(
  deps: Arm2SleeveDeps,
  symbol: string,
  context: SleeveContext,
): Promise<SleeveDecision> {
  const outcome = resolveTechnical(
    deps.bars,
    deps.venueFor,
    symbol,
    context.tradingDate,
    deps.clock.now(),
  );
  if (!outcome.ok) {
    return skipped(ARM2_SLEEVE_ID, symbol, outcome.venue, outcome.read, '', outcome.reason);
  }
  const { venue, read, history } = outcome;
  const hash = inputsHash(
    history.slice(-HASHED_HISTORY_DAYS),
    [read.view],
    ['arm2:technical-only'],
  );
  const thresholds = requireSet(ARM2_ENTRY_THRESHOLDS);
  const direction = directionFrom(read.close, read.sma, read.r63, thresholds);
  const { action, reason } = actionFor(direction, 'technical');
  const stop = stopFor(action, read);
  return {
    sleeve_id: ARM2_SLEEVE_ID,
    instrument: symbol,
    venue,
    direction,
    confidence: direction === 'neutral' ? 0.5 : 0.6,
    action,
    reason,
    price: read.price,
    atr: read.atr,
    stop_price: stop,
    inputs_hash: hash,
    debate_id: undefined,
    payload: { technical: read.view.key_points },
  };
}

export function createArm2Sleeve(deps: Arm2SleeveDeps): Sleeve {
  return createTechnicalSleeve(ARM2_SLEEVE_ID, ARM2_SLEEVE_SPEC, deps, decideOne);
}
