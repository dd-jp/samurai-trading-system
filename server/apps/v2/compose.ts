import type {
  BrokerCashInLieuReader,
  BrokerMode,
  CfdCosts,
  MarketData,
  Sleeve,
} from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore } from '../../shared/store/index.js';
import { SqliteCashAnchors } from './cash-anchor.js';
import type { CycleDeps } from './cycle.js';
import { isCfdVenue, type VenueSessionGate } from './data/index.js';
import {
  type AlpacaBrokerClient,
  type BrokerAccess,
  createBrokerAccess,
  type FillPricing,
  impactLookup,
  venueFee,
  venueHalfSpreadBps,
} from './execution/index.js';
import { FaultLedger, FaultRecordingLogger, Journal } from './journal/index.js';
import {
  assertCapitalShareRanges,
  CapitalConfigStore,
  type CfdCarryRates,
  ControlStore,
  PaperBooks,
  V2RiskGate,
  type VolTargetSizing,
} from './risk/index.js';
import {
  cfdEntryRefusal,
  declaredVolTarget,
  isSet,
  RECONCILE_CASH_TOLERANCE_GBP,
  SleeveRegistry,
} from './signal/index.js';

export interface CycleCompositionOptions {
  readonly db: StoreHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly market: MarketData;
  readonly sleeves: readonly Sleeve[];
  readonly openingDate: string;
  readonly tradingDate: () => string;
  readonly dryRun: boolean;
  readonly halfSpreadBps: (instrument: string) => number;
  // Scales all three modelled-cost legs (spread, impact, fee) together, so a cost-sensitivity
  // run (doc 67 "2x modelled cost") stresses the whole cost model, not just the quoted spread
  readonly costMultiple?: number | undefined;
  readonly alpacaClient?: AlpacaBrokerClient | undefined;
  readonly cfdCosts?: CfdCosts | undefined;
  readonly quotedCfdBorrowPerDay?: ((instrument: string) => number | undefined) | undefined;
  readonly cfdEntryRefusal?: (() => string | undefined) | undefined;
  readonly brokerMode: BrokerMode;
  readonly reconcileCashToleranceGbp?: number | undefined;
  readonly venueSessions?: VenueSessionGate | undefined;
  readonly volTarget?: VolTargetSizing | undefined;
  readonly runStartedAt?: Date | undefined;
  // Replay only: answers every broker call from the journal, so no venue adapter is built
  readonly brokerAccess?: ((pricing: FillPricing) => BrokerAccess) | undefined;
}

export interface CycleComposition extends CycleDeps {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly capital: CapitalConfigStore;
  readonly journal: Journal;
  readonly faults: FaultLedger;
  readonly cashInLieu?: BrokerCashInLieuReader | undefined;
}

function assertCfdFillsPriced(
  cfdGate: () => string | undefined,
  cfdCosts: CfdCosts | undefined,
): void {
  if (cfdGate() !== undefined || cfdCosts !== undefined) return;
  throw new Error(
    'CFD entries can open but no CFD cost models price their fills and carry: a CFD stop or exit would be stranded (#1850)',
  );
}

function cfdCarryRatesFor(options: CycleCompositionOptions): CfdCarryRates | undefined {
  const costs = options.cfdCosts;
  if (costs === undefined) return undefined;
  return {
    financing: costs.financing,
    borrow: costs.borrow,
    quotedBorrowPerDay: options.quotedCfdBorrowPerDay ?? (() => undefined),
  };
}

function declaredCashToleranceGbp(): number | undefined {
  return isSet(RECONCILE_CASH_TOLERANCE_GBP) ? RECONCILE_CASH_TOLERANCE_GBP.value : undefined;
}

function volTargetFor(options: CycleCompositionOptions): VolTargetSizing | undefined {
  return options.volTarget ?? declaredVolTarget();
}

function fillPricingFor(options: CycleCompositionOptions): FillPricing {
  const multiple = options.costMultiple ?? 1;
  const impactBps = impactLookup(options.market, options.tradingDate, options.logger);
  const halfSpreadBps = venueHalfSpreadBps(options.halfSpreadBps, options.cfdCosts?.spread);
  const cfdFee = options.cfdCosts?.fee;
  return {
    halfSpreadBps: (venue, instrument) => halfSpreadBps(venue, instrument) * multiple,
    impactBps: (instrument, qty, price) => impactBps(instrument, qty, price) * multiple,
    fee: (venue, side, qty, price) => venueFee(venue, side, qty, price, cfdFee) * multiple,
  };
}

export function composeCycle(options: CycleCompositionOptions): CycleComposition {
  const { db, clock, market } = options;
  assertCapitalShareRanges(options.sleeves);
  const cfdGate = options.cfdEntryRefusal ?? cfdEntryRefusal;
  assertCfdFillsPriced(cfdGate, options.cfdCosts);
  const v2Store = guardedStore(db, 'v2');
  const faults = new FaultLedger(v2Store, clock, options.logger);
  const logger = new FaultRecordingLogger(options.logger, faults, options.tradingDate);
  const capital = new CapitalConfigStore(v2Store, clock);
  const journal = new Journal(v2Store, clock, faults);
  const registry = new SleeveRegistry();
  for (const sleeve of options.sleeves) registry.register(sleeve);
  const books = new PaperBooks(
    v2Store,
    clock,
    capital,
    options.openingDate,
    registry.list(),
    cfdCarryRatesFor(options),
  );
  const risk = new V2RiskGate({
    books,
    capital,
    market,
    spec: (sleeveId) => registry.spec(sleeveId),
    venueRefusal: (venue) => (isCfdVenue(venue) ? cfdGate() : undefined),
    volTarget: volTargetFor(options),
  });
  const pricing = fillPricingFor(options);
  const { executor, brokerBooks, cashInLieu, cashActivities } =
    options.brokerAccess?.(pricing) ??
    createBrokerAccess({
      dryRun: options.dryRun,
      client: options.alpacaClient,
      brokerMode: options.brokerMode,
      db,
      clock,
      logger,
      pricing,
    });
  return {
    registry,
    books,
    capital,
    journal,
    faults,
    risk,
    executor,
    brokerBooks,
    cashInLieu,
    cashActivities,
    brokerMode: options.brokerMode,
    reconcileCashToleranceGbp: options.reconcileCashToleranceGbp ?? declaredCashToleranceGbp(),
    cashAnchors: new SqliteCashAnchors(v2Store, clock),
    controls: new ControlStore(v2Store),
    market,
    clock,
    dryRun: options.dryRun,
    logger,
    venueSessions: options.venueSessions,
    runStartedAt: options.runStartedAt,
    atomically: (work) => v2Store.transaction(work)(),
  };
}
