import type { Direction } from './primitives.js';

export type Venue = 'alpaca' | 'saxo';
export type OrderSide = 'buy' | 'sell';
export type OrderLeg = 'entry' | 'exit';
export type FillLeg = 'entry' | 'stop' | 'target' | 'exit';
export type OrderOutcome = 'submitted' | 'refused_dry_run' | 'simulated' | 'rejected' | 'cancelled';

export interface V2Bar {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly rawClose: number;
}

export interface MarketData {
  lastBarBefore(instrument: string, tradingDate: string): V2Bar | undefined;
  barsBefore(instrument: string, tradingDate: string, count: number): readonly V2Bar[];
  gbpUsdAtYearStart(year: number): number;
}

export type SleeveAction = 'enter_long' | 'enter_short' | 'skip' | 'none';

export interface SleeveDecision {
  readonly sleeve_id: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly direction: Direction;
  readonly confidence: number;
  readonly action: SleeveAction;
  readonly reason: string;
  readonly price: number;
  readonly atr: number | undefined;
  readonly stop_price: number | undefined;
  readonly inputs_hash: string;
  readonly debate_id: string | undefined;
  readonly veto?: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface SleeveContext {
  readonly tradingDate: string;
  readonly macroDay: boolean;
  readonly dryRun: boolean;
}

export interface SleeveRefusal {
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
}

export interface SleeveOutput {
  readonly decisions: readonly SleeveDecision[];
  readonly refusals: readonly SleeveRefusal[];
}

export interface SleeveUniverse {
  readonly instruments: readonly string[];
  readonly refusals: readonly SleeveRefusal[];
}

export interface SleeveSizing {
  readonly riskFraction: number;
  readonly stopAtrMultiple: number;
  readonly targetAtrMultiple: number;
  readonly timeStopTradingDays: number;
  readonly advShare: number;
  readonly advWindowBars: number;
}

export interface SleeveBook {
  readonly variant: BookVariant;
  readonly instantiated: boolean;
}

export type SleeveValidation = 'backtest' | 'forward-paper';

export interface SleeveSpec {
  readonly minimumCapitalGbp: number;
  readonly capacityGbp: number;
  readonly validation: SleeveValidation;
  readonly sizing: SleeveSizing;
  readonly books: readonly SleeveBook[];
}

export interface Sleeve {
  readonly id: string;
  readonly spec: SleeveSpec;
  universe(context: SleeveContext): SleeveUniverse;
  decide(context: SleeveContext, instruments: readonly string[]): Promise<SleeveOutput>;
}

export interface SleeveSource {
  list(): readonly Sleeve[];
  ids(): readonly string[];
  spec(id: string): SleeveSpec;
}

export interface CapitalYear {
  readonly year: number;
  readonly effectiveFrom: string;
  readonly startCapitalGbp: number;
  readonly lossCapGbp: number;
}

export type BookVariant =
  | 'primary'
  | 'no-macro-gate'
  | 'no-sentiment'
  | 'no-social'
  | 'large-cap-only'
  | 'no-veto';

export interface BookSpec {
  readonly id: string;
  readonly sleeve: string;
  readonly variant: BookVariant;
  readonly instantiated: boolean;
}

export type SizeMultiplier = 0 | 0.25 | 0.5 | 1;

export interface LossBudgetState {
  readonly referenceEquityGbp: number;
  readonly ytdLossGbp: number;
  readonly sizeMultiplier: SizeMultiplier;
  readonly halted: boolean;
  readonly entriesBlockedAtNextFill: boolean;
}

export interface BookDay {
  readonly bookId: string;
  readonly tradingDate: string;
  readonly equityGbp: number;
  readonly cashGbp: number;
  readonly investedGbp: number;
  readonly state: LossBudgetState;
  readonly custodyAccrualGbp: number;
  readonly recordedAt: string;
}

export interface Position {
  readonly instrument: string;
  readonly venue: Venue;
  readonly qty: number;
  readonly avgPriceGbp: number;
  readonly stopGbp: number | undefined;
  readonly targetGbp: number | undefined;
  readonly clientOrderId: string;
  readonly exitClientOrderId: string | undefined;
  readonly openedDate: string;
  readonly marksHeld: number;
}

export interface BookFill {
  readonly instrument: string;
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly qty: number;
  readonly priceGbp: number;
  readonly feeGbp: number;
  readonly clientOrderId: string;
  readonly tradingDate: string;
  readonly stopGbp?: number | undefined;
  readonly targetGbp?: number | undefined;
}

export interface Valuation {
  readonly equityGbp: number;
  readonly investedGbp: number;
  readonly investedSaxoGbp: number;
}

export type MarkPriceGbp = (instrument: string, venue: Venue) => number | undefined;

export interface BookLedger {
  isMarked(tradingDate: string): boolean;
  ids(): readonly string[];
  forSleeve(sleeveId: string): readonly BookSpec[];
  cash(bookId: string): number;
  positions(bookId: string): readonly Position[];
  position(bookId: string, instrument: string): Position | undefined;
  applyFill(bookId: string, fill: BookFill): Position | undefined;
  setExitPending(bookId: string, instrument: string, exitClientOrderId: string): void;
  valuation(bookId: string, markGbp: MarkPriceGbp): Valuation;
  lastDay(bookId: string): BookDay | undefined;
  markDay(
    bookId: string,
    tradingDate: string,
    markGbp: MarkPriceGbp,
    calendarDaysSinceLastMark: number,
  ): BookDay;
}

declare const riskApproved: unique symbol;

interface ApprovedOrderFields {
  readonly approvalId: string;
  readonly clientOrderId: string;
  readonly bookId: string;
  readonly bookVariant: BookVariant;
  readonly venue: Venue;
  readonly instrument: string;
  readonly side: OrderSide;
  readonly size: number;
}

export interface ApprovedBracketEntry extends ApprovedOrderFields {
  readonly kind: 'bracket_entry';
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
}

export interface ApprovedFlatten extends ApprovedOrderFields {
  readonly kind: 'flatten';
}

export type RiskApprovedOrder = (ApprovedBracketEntry | ApprovedFlatten) & {
  readonly [riskApproved]: true;
};

export interface EntryRequest {
  readonly book: BookSpec;
  readonly decision: SleeveDecision;
  readonly clientOrderId: string;
  readonly tradingDate: string;
  readonly equityGbp: number;
  readonly macroDay: boolean;
}

export type EntryApproval =
  | { readonly size: number; readonly order: RiskApprovedOrder }
  | { readonly size: number; readonly order: undefined; readonly refusal: string };

export interface ExitRequest {
  readonly book: BookSpec;
  readonly held: Position;
  readonly clientOrderId: string;
}

export interface RiskGate {
  approveEntry(request: EntryRequest): EntryApproval;
  approveExit(request: ExitRequest): RiskApprovedOrder;
  capitalRefusal(tradingDate: string): string | undefined;
  allocationRefusal(sleeve: Pick<Sleeve, 'id' | 'spec'>, tradingDate: string): string | undefined;
}

export interface ExecutionRoute {
  readonly bookVariant: BookVariant;
  readonly venue: Venue;
}

export interface V2Fill {
  readonly client_order_id: string;
  readonly broker_fill_id: string;
  readonly leg: FillLeg;
  readonly price: number;
  readonly qty: number;
  readonly fee: number;
}

export interface Submission {
  readonly outcome: OrderOutcome;
  readonly detail: string;
  readonly approvalId: string;
}

export interface FillSweep {
  readonly fills: readonly V2Fill[];
  readonly failures: readonly string[];
}

export interface SimulatedFillRequest {
  readonly instrument: string;
  readonly side: OrderSide;
  readonly qty: number;
  readonly price: number;
  readonly crossesSpread: boolean;
}

export interface SimulatedFillQuote {
  readonly price: number;
  readonly fee: number;
}

export interface OrderExecutor {
  simulates(route: ExecutionRoute): boolean;
  quoteSimulatedFill(venue: Venue, request: SimulatedFillRequest): SimulatedFillQuote;
  canRoute(route: ExecutionRoute): boolean;
  submit(order: RiskApprovedOrder): Promise<Submission>;
  cancel(route: ExecutionRoute, clientOrderId: string, instrument: string): Promise<void>;
  resumeFlatten(route: ExecutionRoute, clientOrderId: string, instrument: string): Promise<void>;
  fetchNewFills(sinceIso: string): Promise<FillSweep>;
}

export interface JournalledOrder {
  readonly client_order_id: string;
  readonly decision_id: string | null;
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: string;
  readonly leg: OrderLeg;
  readonly side: OrderSide;
  readonly dry_run: boolean;
  readonly outcome: OrderOutcome;
  readonly payload: Record<string, unknown>;
}

export interface JournalledFill {
  readonly fill_id: string;
  readonly client_order_id: string;
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: string;
  readonly leg: string;
  readonly side: OrderSide;
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
}

export interface JournalledRefusal {
  readonly trading_date: string;
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
}

export interface DecisionJournal {
  recordDecision(
    bookId: string,
    tradingDate: string,
    decision: SleeveDecision,
    sizeShares: number,
  ): string;
  recordOrder(order: JournalledOrder): void;
  orderFor(clientOrderId: string): JournalledOrder | undefined;
  unfilledEntriesBefore(bookId: string, tradingDate: string): readonly JournalledOrder[];
  markCancelled(clientOrderId: string, detail: string): void;
  recordFill(fill: JournalledFill): boolean;
  recordRefusal(refusal: JournalledRefusal): void;
}
