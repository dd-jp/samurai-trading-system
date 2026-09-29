import type {
  BookLedger,
  CapitalYear,
  EntryApproval,
  EntryRoom,
  EntryRequest,
  ExitRequest,
  MarketData,
  RearmRequest,
  RiskApprovedOrder,
  RiskGate,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
  Venue,
} from '../../../../contracts/index.js';
import { isCfdVenue, quotePerGbp } from '../data/index.js';
import { sleeveAllocationGbp, sleeveCapitalYear } from './allocation.js';
import { mintApproval } from './approval.js';
import type { CapitalConfigStore } from './capital-config.js';
import { entryRoomRefusal, grossRoomGbp } from './gross-cap.js';
import { sizeMultiplierFor } from './loss-budget.js';
import {
  CFD_SHORT_GAP_BUDGET_FRACTION_OF_SLEEVE_LOSS_CAP,
  positionSizeShares,
} from './position-size.js';
import { averageDailyNotional, volumeCapShares } from './volume-cap.js';

interface Sizing {
  readonly size: number;
  readonly refusal?: 'no_allocation' | 'no_adv';
}

function bracketRefusal(
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  target: number,
): string | undefined {
  const stopProtects = side === 'buy' ? stop < entry : stop > entry;
  if (!stopProtects) return 'stop_wrong_side';
  return target > 0 ? undefined : 'target_not_positive';
}

function venueRefusalFor(
  decision: SleeveDecision,
  extra: RiskGateDeps['venueRefusal'],
): string | undefined {
  if (decision.action === 'enter_short' && !isCfdVenue(decision.venue)) return 'short_requires_cfd';
  return extra?.(decision.venue);
}

function gapBudgetGbp(decision: SleeveDecision, capital: CapitalYear): number | undefined {
  if (decision.action !== 'enter_short' || !isCfdVenue(decision.venue)) return undefined;
  return capital.lossCapGbp * CFD_SHORT_GAP_BUDGET_FRACTION_OF_SLEEVE_LOSS_CAP;
}

export interface RiskGateDeps {
  readonly books: Pick<BookLedger, 'lastDay'>;
  readonly capital: Pick<CapitalConfigStore, 'inForce'>;
  readonly market: MarketData;
  readonly spec: (sleeveId: string) => SleeveSpec;
  readonly venueRefusal?: ((venue: Venue) => string | undefined) | undefined;
}

export class V2RiskGate implements RiskGate {
  constructor(private readonly deps: RiskGateDeps) {}

  capitalRefusal(tradingDate: string): string | undefined {
    if (this.deps.capital.inForce(tradingDate) !== undefined) return undefined;
    return `no capital config in force on ${tradingDate}: entries refused until David sets the year (doc 66 D8)`;
  }

  entryRoom(equityGbp: number, cashGbp: number, grossNotionalGbp: number): EntryRoom {
    return { cashGbp, grossGbp: grossRoomGbp(equityGbp, grossNotionalGbp) };
  }

  entryRoomRefusal(notionalGbp: number, room: EntryRoom): 'insufficient_cash' | 'gross_cap' | undefined {
    return entryRoomRefusal(notionalGbp, room);
  }

  allocationRefusal(sleeve: Pick<Sleeve, 'id' | 'spec'>, tradingDate: string): string | undefined {
    const capital = this.deps.capital.inForce(tradingDate);
    if (capital === undefined || sleeveAllocationGbp(sleeve.spec, capital) > 0) return undefined;
    const share = sleeveCapitalYear(sleeve.spec, capital).startCapitalGbp;
    const allocation = `sleeve ${sleeve.id} gets £0 of its £${share} share of ${capital.year}'s £${capital.startCapitalGbp}`;
    return `${allocation} (minimum £${sleeve.spec.minimumCapitalGbp}, capacity £${sleeve.spec.capacityGbp}): no allocation (doc 66 D8)`;
  }

  approveEntry(request: EntryRequest): EntryApproval {
    const { decision } = request;
    const venueRefusal = venueRefusalFor(decision, this.deps.venueRefusal);
    if (venueRefusal !== undefined) return { size: 0, order: undefined, refusal: venueRefusal };
    const { size, refusal: sizingRefusal } = this.#size(request);
    if (sizingRefusal !== undefined) return { size, order: undefined, refusal: sizingRefusal };
    if (size <= 0) return { size, order: undefined, refusal: 'zero_size' };
    if (decision.stop_price === undefined || decision.atr === undefined) {
      return { size, order: undefined, refusal: 'no_stop_price' };
    }
    const side = decision.action === 'enter_short' ? 'sell' : 'buy';
    const distance = this.deps.spec(request.book.sleeve).sizing.targetAtrMultiple * decision.atr;
    const target = side === 'sell' ? decision.price - distance : decision.price + distance;
    const refusal = bracketRefusal(side, decision.price, decision.stop_price, target);
    if (refusal !== undefined) return { size, order: undefined, refusal };
    return {
      size,
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
        entry: decision.price,
        stop: decision.stop_price,
        target,
      }),
    };
  }

  approveExit(request: ExitRequest): RiskApprovedOrder {
    const size = Math.abs(request.held.qty);
    if (!(size > 0)) {
      throw new Error(
        `risk gate: no exit for ${request.held.instrument} at qty ${request.held.qty}`,
      );
    }
    return mintApproval({
      kind: 'flatten',
      approvalId: `exit:${request.clientOrderId}:${size}`,
      clientOrderId: request.clientOrderId,
      bookId: request.book.id,
      bookVariant: request.book.variant,
      venue: request.held.venue,
      instrument: request.held.instrument,
      side: request.held.qty > 0 ? 'sell' : 'buy',
      size,
      entryClientOrderId: request.held.clientOrderId,
      rearmStop: request.rearm?.stop,
      rearmTarget: request.rearm?.target,
    });
  }

  approveRearm(request: RearmRequest): RiskApprovedOrder {
    const size = Math.abs(request.held.qty);
    if (!(size > 0)) {
      throw new Error(
        `risk gate: no rearm for ${request.held.instrument} at qty ${request.held.qty}`,
      );
    }
    return mintApproval({
      kind: 'rearm',
      approvalId: `rearm:${request.clientOrderId}:${size}`,
      clientOrderId: request.clientOrderId,
      bookId: request.book.id,
      bookVariant: request.book.variant,
      venue: request.held.venue,
      instrument: request.held.instrument,
      side: request.held.qty > 0 ? 'sell' : 'buy',
      size,
      entryClientOrderId: request.held.clientOrderId,
      stop: request.stop,
      target: request.target,
    });
  }

  #size(request: EntryRequest): Sizing {
    const { book, decision, tradingDate } = request;
    if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return { size: 0 };
    const capital = this.deps.capital.inForce(tradingDate);
    if (capital === undefined) return { size: 0 };
    const spec = this.deps.spec(book.sleeve);
    if (sleeveAllocationGbp(spec, capital) <= 0) return { size: 0, refusal: 'no_allocation' };
    const volumeCap = this.#volumeCap(decision, spec, tradingDate);
    if (volumeCap === undefined) return { size: 0, refusal: 'no_adv' };
    const fx = quotePerGbp(this.deps.market, decision.venue, tradingDate);
    const size = positionSizeShares({
      equityGbp: request.equityGbp,
      riskFraction: spec.sizing.riskFraction,
      priceGbp: decision.price / fx,
      atrGbp: (decision.atr ?? 0) / fx,
      stopAtrMultiple: spec.sizing.stopAtrMultiple,
      sizeMultiplier: this.#multiplier(book.id, sleeveCapitalYear(spec, capital)),
      macroDay: spec.macroGate && book.variant !== 'no-macro-gate' && request.macroDay,
      volumeCapShares: volumeCap,
      gapBudgetGbp: gapBudgetGbp(decision, sleeveCapitalYear(spec, capital)),
    });
    return { size };
  }

  #volumeCap(decision: SleeveDecision, spec: SleeveSpec, tradingDate: string): number | undefined {
    const { advShare, advWindowBars } = spec.sizing;
    const bars = this.deps.market.barsBefore(decision.instrument, tradingDate, advWindowBars);
    const notional = averageDailyNotional(bars, advWindowBars, tradingDate);
    return notional === undefined ? undefined : volumeCapShares(notional, advShare, decision.price);
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
