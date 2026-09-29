import type { CfdCostModel, MarketData, Sleeve } from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore } from '../../shared/store/index.js';
import type { CycleDeps } from './cycle.js';
import { isCfdVenue } from './data/index.js';
import {
  type AlpacaBrokerClient,
  createOrderExecutor,
  impactLookup,
  venueFee,
} from './execution/index.js';
import { Journal } from './journal/index.js';
import {
  assertCapitalShareRanges,
  CapitalConfigStore,
  ControlStore,
  PaperBooks,
  V2RiskGate,
} from './risk/index.js';
import { cfdEntryRefusal, SleeveRegistry } from './signal/index.js';

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
  readonly cfdCostModel?: CfdCostModel | undefined;
  readonly cfdEntryRefusal?: (() => string | undefined) | undefined;
  // Default true: paper/live pools real concurrent primary books against one account-wide loss
  // cap (#1799). The backtest passes false so each trial and the benchmark it composes into the
  // same PaperBooks keeps an independent budget (ruled 2026-09-28, doc 66)
  readonly pooledLossBudget?: boolean | undefined;
}

export interface CycleComposition extends CycleDeps {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly capital: CapitalConfigStore;
  readonly journal: Journal;
}

export function composeCycle(options: CycleCompositionOptions): CycleComposition {
  const { db, clock, logger, market, tradingDate } = options;
  assertCapitalShareRanges(options.sleeves);
  const cfdGate = options.cfdEntryRefusal ?? cfdEntryRefusal;
  const v2Store = guardedStore(db, 'v2');
  const capital = new CapitalConfigStore(v2Store, clock);
  const journal = new Journal(v2Store, clock);
  const registry = new SleeveRegistry();
  for (const sleeve of options.sleeves) registry.register(sleeve);
  const books = new PaperBooks(
    v2Store,
    clock,
    capital,
    options.openingDate,
    registry.list(),
    options.pooledLossBudget ?? true,
  );
  const risk = new V2RiskGate({
    books,
    capital,
    market,
    spec: (sleeveId) => registry.spec(sleeveId),
    venueRefusal: (venue) => (isCfdVenue(venue) ? cfdGate() : undefined),
  });
  const multiple = options.costMultiple ?? 1;
  const impactBps = impactLookup(market, tradingDate, logger);
  const executor = createOrderExecutor({
    dryRun: options.dryRun,
    client: options.alpacaClient,
    db,
    clock,
    logger,
    pricing: {
      halfSpreadBps: (instrument) => options.halfSpreadBps(instrument) * multiple,
      impactBps: (instrument, qty, price) => impactBps(instrument, qty, price) * multiple,
      fee: (venue, side, qty, price) =>
        venueFee(venue, side, qty, price, options.cfdCostModel) * multiple,
    },
  });
  return {
    registry,
    books,
    capital,
    journal,
    risk,
    executor,
    controls: new ControlStore(v2Store),
    market,
    clock,
    dryRun: options.dryRun,
    logger,
  };
}
