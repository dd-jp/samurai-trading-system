import type { Direction, OrderState } from './primitives.js';

export type Venue = 'alpaca' | 'saxo' | 'saxo_cfd_gbp' | 'saxo_cfd_usd';
export type OrderSide = 'buy' | 'sell';
export type OrderLeg = 'entry' | 'exit';
export type FillLeg = 'entry' | 'stop' | 'target' | 'exit' | 'cash_in_lieu';
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

export interface GbpUsdFix {
  readonly gbpUsd: number;
  readonly fixDate: string;
}

export interface MarketData {
  lastBarBefore(instrument: string, tradingDate: string): V2Bar | undefined;
  barsBefore(instrument: string, tradingDate: string, count: number): readonly V2Bar[];
  gbpUsdAtYearStart(year: number): number;
  gbpUsdYearStartFixDate?(year: number): string | undefined;
  gbpUsdOnDay?(date: string): GbpUsdFix;
}

export type SleeveAction = 'enter_long' | 'enter_short' | 'exit' | 'skip' | 'none';

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
  readonly target_price?: number | undefined;
  readonly entry_trigger?: number | undefined;
  readonly entry_limit?: number | undefined;
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
  readonly capitalShare: number;
  readonly minimumCapitalGbp: number;
  readonly capacityGbp: number;
  readonly validation: SleeveValidation;
  readonly macroGate: boolean;
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
  | 'no-veto'
  | 'technical-only';

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
  readonly cfdFinancingAccrualGbp: number;
  readonly cfdBorrowAccrualGbp: number;
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
  readonly stray: boolean;
  readonly splitFactor: number;
  readonly splitAnchorDate: string | undefined;
}

export interface BookFill {
  readonly instrument: string;
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly leg: FillLeg;
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
  applySplit(bookId: string, instrument: string, ratio: number, anchorDate: string): void;
  setExitPending(bookId: string, instrument: string, exitClientOrderId: string): void;
  clearExitPending(bookId: string, instrument: string): void;
  valuation(bookId: string, markGbp: MarkPriceGbp): Valuation;
  lastDay(bookId: string): BookDay | undefined;
  markDay(
    bookId: string,
    tradingDate: string,
    markGbp: MarkPriceGbp,
    calendarDaysSinceLastMark: number,
    timeStopPausedVenues?: readonly Venue[],
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
  readonly entryTrigger?: number | undefined;
  readonly stop: number;
  readonly target: number;
}

export interface ApprovedFlatten extends ApprovedOrderFields {
  readonly kind: 'flatten';
  readonly entryClientOrderId: string;
  readonly rearmStop: number | undefined;
  readonly rearmTarget: number | undefined;
}

export interface ApprovedRearm extends ApprovedOrderFields {
  readonly kind: 'rearm';
  readonly entryClientOrderId: string;
  readonly stop: number;
  readonly target: number;
}

export interface ApprovedStopReplace extends ApprovedOrderFields {
  readonly kind: 'replace_stop';
  readonly entryClientOrderId: string;
  readonly stop: number;
  readonly target: number;
}

export type RiskApprovedOrder = (
  | ApprovedBracketEntry
  | ApprovedFlatten
  | ApprovedRearm
  | ApprovedStopReplace
) & {
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
  | {
      readonly size: number;
      readonly order: RiskApprovedOrder;
      readonly entryOffsetBps?: number | undefined;
    }
  | {
      readonly size: number;
      readonly order: undefined;
      readonly refusal: string;
      readonly entryOffsetBps?: undefined;
    };

export interface RearmPrices {
  readonly stop: number;
  readonly target: number;
}

export interface ExitRequest {
  readonly book: BookSpec;
  readonly held: Position;
  readonly clientOrderId: string;
  readonly rearm?: RearmPrices | undefined;
}

export interface RearmRequest {
  readonly book: BookSpec;
  readonly held: Position;
  readonly clientOrderId: string;
  readonly stop: number;
  readonly target: number;
}

export type ControlAction = 'pause' | 'halt' | 'resume';

export type ControlState = 'running' | 'paused' | 'halted';

export type ManualControl =
  | { readonly state: 'running' }
  | {
      readonly state: Exclude<ControlState, 'running'>;
      readonly reason: string;
      readonly setAt: string;
    };

export interface ControlReader {
  current(): ManualControl;
}

export interface EntryRoom {
  cashGbp: number;
  grossGbp: number;
}

export interface RiskGate {
  approveEntry(request: EntryRequest): EntryApproval;
  entryRoom(equityGbp: number, cashGbp: number, grossNotionalGbp: number): EntryRoom;
  entryRoomRefusal(
    notionalGbp: number,
    room: EntryRoom,
  ): 'insufficient_cash' | 'gross_cap' | undefined;
  approveExit(request: ExitRequest): RiskApprovedOrder;
  approveRearm(request: RearmRequest): RiskApprovedOrder;
  approveStopReplace(request: RearmRequest): RiskApprovedOrder;
  capitalRefusal(tradingDate: string): string | undefined;
  fxRefusal(tradingDate: string): string | undefined;
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
  readonly qty_is_cumulative?: boolean | undefined;
  readonly filled_at?: string | undefined;
}

export type StopReplaceStep = 'cancel' | 'place';

export interface Submission {
  readonly outcome: OrderOutcome;
  readonly detail: string;
  readonly approvalId: string;
  readonly failedStep?: StopReplaceStep | undefined;
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

export interface CfdCostModel {
  fee(venue: Venue, side: OrderSide, qty: number, priceQuote: number): number;
}

export interface CfdSpreadModel {
  halfSpreadBps(venue: Venue): number;
}

export interface CfdFinancingModel {
  dailyRate(venue: Venue, side: 'long' | 'short'): number;
}

export interface CfdBorrowModel {
  dailyRate(venue: Venue, quotedPerDay: number | undefined): number;
}

export interface CfdCosts {
  readonly fee: CfdCostModel;
  readonly spread: CfdSpreadModel;
  readonly financing: CfdFinancingModel;
  readonly borrow: CfdBorrowModel;
}

export class CfdCostModelUnsetError extends Error {
  constructor() {
    super('a CFD fill was priced with no CFD cost model: needs #1850');
    this.name = 'CfdCostModelUnsetError';
  }
}

export interface SimulatedFillQuote {
  readonly price: number;
  readonly fee: number;
}

export interface ResumedExit {
  readonly orderState: OrderState;
  readonly filledQty: number;
}

export interface OrderExecutor {
  simulates(route: ExecutionRoute): boolean;
  quoteSimulatedFill(venue: Venue, request: SimulatedFillRequest): SimulatedFillQuote;
  canRoute(route: ExecutionRoute): boolean;
  submit(order: RiskApprovedOrder): Promise<Submission>;
  cancel(route: ExecutionRoute, clientOrderId: string, instrument: string): Promise<void>;
  filledQty(
    route: ExecutionRoute,
    clientOrderId: string,
    instrument: string,
  ): Promise<number | undefined>;
  resumeFlatten(
    route: ExecutionRoute,
    clientOrderId: string,
    instrument: string,
  ): Promise<ResumedExit | undefined>;
  fetchNewFills(sinceIso: string): Promise<FillSweep>;
}

export interface BrokerPosition {
  readonly instrument: string;
  readonly qty: number;
}

export interface BrokerOpenOrder {
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly protects: 'long' | 'short' | null;
  readonly qty: number | null;
  readonly stopPrice: number | null;
}

export interface BrokerBook {
  readonly positions: readonly BrokerPosition[];
  readonly openOrders: readonly BrokerOpenOrder[];
  readonly cashQuote: number;
}

export interface BrokerBookReader {
  read(venue: Venue): Promise<BrokerBook>;
}

export type BrokerActivityStatus = 'executed' | 'correct' | 'canceled';

// amount is signed in the venue's currency, positive for cash paid to the account
export interface BrokerCashInLieu {
  readonly activity_id: string;
  readonly instrument: string;
  readonly activity_date: string;
  readonly qty: number | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: BrokerActivityStatus;
}

export interface BrokerCashInLieuReader {
  readonly venue: Venue;
  read(sinceDate: string): Promise<readonly BrokerCashInLieu[]>;
}

export type BrokerMode = 'paper' | 'live';

export type ReconcileSource = 'broker' | 'simulated';

export type ReconcileStatus = 'clean' | 'mismatch' | 'unverified' | 'read_failed';

export type ReconcileDiffKind =
  | 'position_missing_in_store'
  | 'position_missing_at_broker'
  | 'position_qty'
  | 'position_unprotected'
  | 'protective_qty'
  | 'protective_price'
  | 'order_missing_at_broker'
  | 'order_unknown_to_store'
  | 'cash'
  | 'cash_unverified';

export interface ReconcileDiff {
  readonly kind: ReconcileDiffKind;
  readonly instrument: string | null;
  readonly order_id: string | null;
  readonly store: number | null;
  readonly broker: number | null;
}

export interface JournalledReconcile {
  readonly trading_date: string;
  readonly venue: Venue;
  readonly source: ReconcileSource;
  readonly status: ReconcileStatus;
  readonly book_ids: readonly string[];
  readonly diffs: readonly ReconcileDiff[];
  readonly detail: string;
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
  readonly currency: string;
  readonly price_native: number;
  readonly fee_native: number;
  readonly fx_quote_per_gbp: number;
  readonly fx_source: string;
  readonly fill_date: string | null;
  readonly filled_at?: string | undefined;
}

export interface JournalledSplit {
  readonly instrument: string;
  readonly venue: string;
  readonly split_date: string;
  readonly ratio: number;
  readonly trading_date: string;
}

export interface JournalledCashInLieu {
  readonly venue: Venue;
  readonly activity_id: string;
  readonly instrument: string;
  readonly activity_date: string;
  readonly qty: number | null;
  readonly amount_native: number;
  readonly currency: string;
  readonly status: BrokerActivityStatus;
  readonly fx_quote_per_gbp: number;
  readonly fx_source: string;
  readonly trading_date: string;
}

export type RescaleSource = 'detector' | 'broker' | 'entry' | 'anchor';

export interface PositionLevels {
  readonly qty: number;
  readonly avgPriceGbp: number;
  readonly stopGbp: number | undefined;
  readonly targetGbp: number | undefined;
}

export interface JournalledRescale {
  readonly trading_date: string;
  readonly book_id: string;
  readonly instrument: string;
  readonly source: RescaleSource;
  readonly ratio: number;
  readonly anchor_date: string;
  readonly before: PositionLevels;
  readonly after: PositionLevels;
}

export interface RecordedFillPart {
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
  readonly trading_date: string;
}

export interface JournalledRefusal {
  readonly trading_date: string;
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
  readonly book_id?: string | undefined;
  readonly instrument?: string | undefined;
}

export interface JournalledFillRead {
  readonly run_id: string;
  readonly trading_date: string;
  readonly client_order_id: string;
  readonly filled_qty: number | null;
  readonly error: string | null;
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
  unfilledSimulatedEntriesBefore(tradingDate: string): readonly JournalledOrder[];
  restingEntries(bookId: string): readonly JournalledOrder[];
  partFilledEntries(bookId: string, before?: string): readonly JournalledOrder[];
  markCancelled(clientOrderId: string, detail: string): void;
  recordFillRead(read: JournalledFillRead): void;
  lastFillRowid(): number;
  recordFillSweep(runId: string, tradingDate: string, firstFillRowid: number): void;
  recordFill(fill: JournalledFill): boolean;
  fillPartsOf(baseFillId: string): readonly RecordedFillPart[];
  recordSplit(split: JournalledSplit): void;
  recordRescale(rescale: JournalledRescale): void;
  recordRefusal(refusal: JournalledRefusal): void;
  recordReconcile(run: JournalledReconcile): void;
}
