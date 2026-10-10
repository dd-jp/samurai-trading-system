import type {
  BookLedger,
  CapitalYear,
  EntryApproval,
  EntryRequest,
  EntryRoom,
  ExitRequest,
  MarketData,
  Position,
  RearmRequest,
  RiskApprovedOrder,
  RiskGate,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
  Venue,
} from '../../../../contracts/index.js';
import { isCfdVenue, quotePerGbp, yearStartCoverageRefusal } from '../data/index.js';
import { sleeveAllocationGbp, sleeveCapitalYear } from './allocation.js';
import { mintApproval } from './approval.js';
import type { CapitalConfigStore } from './capital-config.js';
import { entryLimitFor, entryOffsetBps, offsetRefusal } from './entry-limit.js';
import { entryRoomRefusal, grossRoomGbp } from './gross-cap.js';
import { sizeMultiplierFor } from './loss-budget.js';
import { CFD_SHORT_GAP_BUDGET_FRACTION, positionSizeShares } from './position-size.js';
import {
  assertVolTargetSizing,
  type VolTargetSizing,
  volTargetBarsWanted,
  volTargetRiskScale,
} from './vol-target.js';
import { averageDailyNotional, volumeCapShares } from './volume-cap.js';

interface Sizing {
  readonly size: number;
  readonly refusal?: 'no_allocation' | 'no_adv' | 'no_realised_vol';
}

function bracketRefusal(
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  target: number,
): string | undefined {
  const stopProtects = side === 'buy' ? stop < entry : stop > entry;
  if (!stopProtects) return 'stop_wrong_side';
  if (!(target > 0)) return 'target_not_positive';
  const targetBeyondEntry = side === 'buy' ? target > entry : target < entry;
  return targetBeyondEntry ? undefined : 'target_wrong_side';
}

function triggerRefusal(
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  trigger: number | undefined,
): string | undefined {
  if (trigger === undefined) return undefined;
  const withinLimit = side === 'buy' ? trigger <= entry : trigger >= entry;
  if (!withinLimit) return 'trigger_beyond_limit';
  const clearOfStop = side === 'buy' ? trigger > stop : trigger < stop;
  return clearOfStop ? undefined : 'trigger_at_or_past_stop';
}

function sideOf(decision: SleeveDecision): 'buy' | 'sell' {
  return decision.action === 'enter_short' ? 'sell' : 'buy';
}

function isEntryDecision(decision: SleeveDecision): boolean {
  return decision.action === 'enter_long' || decision.action === 'enter_short';
}

function entryToStop(limit: number, stop: number | undefined): number {
  return stop === undefined ? 0 : Math.abs(limit - stop);
}

function closingLeg(
  held: Position,
  purpose: 'exit' | 'rearm' | 'stop replace',
): { readonly size: number; readonly side: 'buy' | 'sell' } {
  const size = Math.abs(held.qty);
  if (!(size > 0)) {
    throw new Error(`risk gate: no ${purpose} for ${held.instrument} at qty ${held.qty}`);
  }
  return { size, side: held.qty > 0 ? 'sell' : 'buy' };
}

function sideRefusal(decision: SleeveDecision): string | undefined {
  const cfd = isCfdVenue(decision.venue);
  if (decision.action === 'enter_short' && !cfd) return 'short_requires_cfd';
  return decision.action === 'enter_long' && cfd ? 'long_on_cfd' : undefined;
}

function venueRefusalFor(
  decision: SleeveDecision,
  sleeveId: string,
  deps: Pick<RiskGateDeps, 'cfdSleeveIds' | 'venueRefusal'>,
): string | undefined {
  const refusal = sideRefusal(decision);
  if (refusal !== undefined || !isCfdVenue(decision.venue)) return refusal;
  if (!deps.cfdSleeveIds.includes(sleeveId)) return 'cfd_sleeve_not_allowed';
  return (deps.venueRefusal ?? closedCfdVenue)(decision.venue);
}

function closedCfdVenue(): string {
  return 'cfd_not_backtested';
}

function gapBudgetGbp(decision: SleeveDecision, capital: CapitalYear): number | undefined {
  if (decision.action !== 'enter_short') return undefined;
  return capital.lossCapGbp * CFD_SHORT_GAP_BUDGET_FRACTION;
}

export interface RiskGateDeps {
  readonly books: Pick<BookLedger, 'lastDay'>;
  readonly capital: Pick<CapitalConfigStore, 'inForce'>;
  readonly cfdSleeveIds: readonly string[];
  readonly market: MarketData;
  readonly spec: (sleeveId: string) => SleeveSpec;
  readonly venueRefusal?: ((venue: Venue) => string | undefined) | undefined;
  readonly volTarget?: VolTargetSizing | undefined;
}

export class V2RiskGate implements RiskGate {
  constructor(private readonly deps: RiskGateDeps) {
    if (deps.volTarget !== undefined) assertVolTargetSizing(deps.volTarget);
  }

  capitalRefusal(tradingDate: string): string | undefined {
    if (this.deps.capital.inForce(tradingDate) !== undefined) return undefined;
    return `no capital config in force on ${tradingDate}: entries refused until David sets the year (doc 66 D8)`;
  }

  entryRoom(equityGbp: number, cashGbp: number, grossNotionalGbp: number): EntryRoom {
    return { cashGbp, grossGbp: grossRoomGbp(equityGbp, grossNotionalGbp) };
  }

  entryRoomRefusal(
    notionalGbp: number,
    room: EntryRoom,
  ): 'insufficient_cash' | 'gross_cap' | undefined {
    return entryRoomRefusal(notionalGbp, room);
  }

  allocationRefusal(sleeve: Pick<Sleeve, 'id' | 'spec'>, tradingDate: string): string | undefined {
    const capital = this.deps.capital.inForce(tradingDate);
    if (capital === undefined || sleeveAllocationGbp(sleeve.spec, capital) > 0) return undefined;
    const share = sleeveCapitalYear(sleeve.spec, capital).startCapitalGbp;
    const allocation = `sleeve ${sleeve.id} gets £0 of its £${share} share of ${capital.year}'s £${capital.startCapitalGbp}`;
    return `${allocation} (minimum £${sleeve.spec.minimumCapitalGbp}, capacity £${sleeve.spec.capacityGbp}): no allocation (doc 66 D8)`;
  }

  fxRefusal(tradingDate: string): string | undefined {
    const reason = yearStartCoverageRefusal(this.deps.market, tradingDate);
    return reason === undefined ? undefined : `${reason}: entries refused (postmortem §2, #2009)`;
  }

  approveEntry(request: EntryRequest): EntryApproval {
    const { decision } = request;
    if (isEntryDecision(decision) && this.fxRefusal(request.tradingDate) !== undefined) {
      return { size: 0, order: undefined, refusal: 'fx_year_start_stale' };
    }
    const venueRefusal = venueRefusalFor(decision, request.book.sleeve, this.deps);
    if (venueRefusal !== undefined) return { size: 0, order: undefined, refusal: venueRefusal };
    const { size, refusal: sizingRefusal } = this.#size(request);
    if (sizingRefusal !== undefined) return { size, order: undefined, refusal: sizingRefusal };
    if (size <= 0) return { size, order: undefined, refusal: 'zero_size' };
    return this.#bracket(request, size);
  }

  #bracket(request: EntryRequest, size: number): EntryApproval {
    const { decision } = request;
    if (decision.stop_price === undefined || decision.atr === undefined) {
      return { size, order: undefined, refusal: 'no_stop_price' };
    }
    const side = sideOf(decision);
    const limit = entryLimitFor(side, decision);
    const target = decision.target_price ?? this.#atrTarget(request, side, decision.atr);
    const refusal =
      bracketRefusal(side, decision.price, decision.stop_price, target) ??
      offsetRefusal(side, limit, decision.stop_price, target) ??
      triggerRefusal(side, limit, decision.stop_price, decision.entry_trigger);
    if (refusal !== undefined) return { size, order: undefined, refusal };
    return {
      size,
      entryOffsetBps: entryOffsetBps(decision),
      order: mintApproval({
        kind: 'bracket_entry',
        approvalId: `entry:${request.clientOrderId}:${size}`,
        clientOrderId: request.clientOrderId,
        bookId: request.book.id,
        bookVariant: request.book.variant,
        venue: decision.venue,
        instrument: decision.instrument,
        side,
        size,
        entry: limit,
        entryTrigger: decision.entry_trigger,
        stop: decision.stop_price,
        target,
      }),
    };
  }

  #atrTarget(request: EntryRequest, side: 'buy' | 'sell', atr: number): number {
    const distance = this.deps.spec(request.book.sleeve).sizing.targetAtrMultiple * atr;
    return side === 'sell' ? request.decision.price - distance : request.decision.price + distance;
  }

  approveExit(request: ExitRequest): RiskApprovedOrder {
    const { size, side } = closingLeg(request.held, 'exit');
    return mintApproval({
      kind: 'flatten',
      approvalId: `exit:${request.clientOrderId}:${size}`,
      clientOrderId: request.clientOrderId,
      bookId: request.book.id,
      bookVariant: request.book.variant,
      venue: request.held.venue,
      instrument: request.held.instrument,
      side,
      size,
      entryClientOrderId: request.held.clientOrderId,
      rearmStop: request.rearm?.stop,
      rearmTarget: request.rearm?.target,
    });
  }

  approveRearm(request: RearmRequest): RiskApprovedOrder {
    const { size, side } = closingLeg(request.held, 'rearm');
    return mintApproval({
      kind: 'rearm',
      approvalId: `rearm:${request.clientOrderId}:${size}`,
      clientOrderId: request.clientOrderId,
      bookId: request.book.id,
      bookVariant: request.book.variant,
      venue: request.held.venue,
      instrument: request.held.instrument,
      side,
      size,
      entryClientOrderId: request.held.clientOrderId,
      stop: request.stop,
      target: request.target,
    });
  }

  approveStopReplace(request: RearmRequest): RiskApprovedOrder {
    const { size, side } = closingLeg(request.held, 'stop replace');
    return mintApproval({
      kind: 'replace_stop',
      approvalId: `replace_stop:${request.clientOrderId}:${size}`,
      clientOrderId: request.clientOrderId,
      bookId: request.book.id,
      bookVariant: request.book.variant,
      venue: request.held.venue,
      instrument: request.held.instrument,
      side,
      size,
      entryClientOrderId: request.held.clientOrderId,
      stop: request.stop,
      target: request.target,
    });
  }

  #size(request: EntryRequest): Sizing {
    const { book, decision, tradingDate } = request;
    if (!isEntryDecision(decision)) return { size: 0 };
    const capital = this.deps.capital.inForce(tradingDate);
    if (capital === undefined) return { size: 0 };
    const spec = this.deps.spec(book.sleeve);
    if (sleeveAllocationGbp(spec, capital) <= 0) return { size: 0, refusal: 'no_allocation' };
    const limit = entryLimitFor(sideOf(decision), decision);
    const volumeCap = this.#volumeCap(decision.instrument, limit, spec, tradingDate);
    if (volumeCap === undefined) return { size: 0, refusal: 'no_adv' };
    const volScale = this.#volScale(book.sleeve, decision.instrument, tradingDate);
    if (volScale === undefined) return { size: 0, refusal: 'no_realised_vol' };
    const fx = quotePerGbp(this.deps.market, decision.venue, tradingDate);
    const size = positionSizeShares({
      equityGbp: request.equityGbp,
      riskFraction: spec.sizing.riskFraction * volScale,
      priceGbp: limit / fx,
      atrGbp: (decision.atr ?? 0) / fx,
      stopAtrMultiple: spec.sizing.stopAtrMultiple,
      sizeMultiplier: this.#multiplier(book.id, sleeveCapitalYear(spec, capital)),
      macroDay: spec.macroGate && book.variant !== 'no-macro-gate' && request.macroDay,
      volumeCapShares: volumeCap,
      gapBudgetGbp: gapBudgetGbp(decision, sleeveCapitalYear(spec, capital)),
      entryToStopGbp: entryToStop(limit, decision.stop_price) / fx,
    });
    return { size };
  }

  #volScale(sleeveId: string, instrument: string, tradingDate: string): number | undefined {
    const sizing = this.deps.volTarget;
    if (sizing === undefined || !sizing.sleeveIds.includes(sleeveId)) return 1;
    const bars = this.deps.market.barsBefore(instrument, tradingDate, volTargetBarsWanted(sizing));
    return volTargetRiskScale(sizing, bars, tradingDate);
  }

  #volumeCap(
    instrument: string,
    limit: number,
    spec: SleeveSpec,
    tradingDate: string,
  ): number | undefined {
    const { advShare, advWindowBars } = spec.sizing;
    const bars = this.deps.market.barsBefore(instrument, tradingDate, advWindowBars);
    const notional = averageDailyNotional(bars, advWindowBars, tradingDate);
    return notional === undefined ? undefined : volumeCapShares(notional, advShare, limit);
  }

  #multiplier(bookId: string, capital: CapitalYear): number {
    const previous = this.deps.books.lastDay(bookId);
    if (previous === undefined) return 1;
    const { state } = previous;
    if (Number(previous.tradingDate.slice(0, 4)) !== capital.year) {
      return state.entriesBlockedAtNextFill && !state.halted ? 0 : 1;
    }
    if (state.entriesBlockedAtNextFill) return 0;
    return Math.min(state.sizeMultiplier, sizeMultiplierFor(state.ytdLossGbp, capital.lossCapGbp));
  }
}
