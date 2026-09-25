import type {
  BookLedger,
  EntryApproval,
  EntryRequest,
  ExitRequest,
  MarketData,
  RiskApprovedOrder,
  RiskGate,
} from '../../../../contracts/index.js';
import { quotePerGbp } from '../data/index.js';
import { mintApproval } from './approval.js';
import type { CapitalConfigStore } from './capital-config.js';
import { positionSizeShares } from './position-size.js';

export interface RiskGateDeps {
  readonly books: BookLedger;
  readonly capital: Pick<CapitalConfigStore, 'inForce'>;
  readonly market: MarketData;
  readonly riskFraction: number;
  readonly targetAtrMultiple: number;
}

export class V2RiskGate implements RiskGate {
  constructor(private readonly deps: RiskGateDeps) {}

  capitalRefusal(tradingDate: string): string | undefined {
    if (this.deps.capital.inForce(tradingDate) !== undefined) return undefined;
    return `no capital config in force on ${tradingDate}: entries refused until David sets the year (doc 66 D8)`;
  }

  approveEntry(request: EntryRequest): EntryApproval {
    const size = this.#size(request);
    const { decision } = request;
    if (size <= 0) return { size, order: undefined, refusal: 'zero_size' };
    if (decision.stop_price === undefined || decision.atr === undefined) {
      return { size, order: undefined, refusal: 'no_stop_price' };
    }
    const side = decision.action === 'enter_short' ? 'sell' : 'buy';
    const distance = this.deps.targetAtrMultiple * decision.atr;
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
        target: side === 'sell' ? decision.price - distance : decision.price + distance,
      }),
    };
  }

  approveExit(request: ExitRequest): RiskApprovedOrder {
    const size = Math.abs(request.held.qty);
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
    });
  }

  #size(request: EntryRequest): number {
    const { book, decision, tradingDate } = request;
    if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return 0;
    if (this.capitalRefusal(tradingDate) !== undefined) return 0;
    const previous = this.deps.books.lastDay(book.id)?.state;
    const multiplier = previous?.entriesBlockedAtNextFill === true ? 0 : (previous?.sizeMultiplier ?? 1);
    const fx = quotePerGbp(this.deps.market, decision.venue, tradingDate);
    return positionSizeShares({
      equityGbp: request.equityGbp,
      riskFraction: this.deps.riskFraction,
      priceGbp: decision.price / fx,
      atrGbp: (decision.atr ?? 0) / fx,
      sizeMultiplier: multiplier,
      macroDay: book.variant === 'no-macro-gate' ? false : request.macroDay,
    });
  }
}
