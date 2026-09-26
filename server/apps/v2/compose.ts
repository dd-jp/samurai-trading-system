import type { MarketData, Sleeve } from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore } from '../../shared/store/index.js';
import type { CycleDeps } from './cycle.js';
import {
  type AlpacaBrokerClient,
  createOrderExecutor,
  impactLookup,
  venueFee,
} from './execution/index.js';
import { Journal } from './journal/index.js';
import { CapitalConfigStore, PaperBooks, V2RiskGate } from './risk/index.js';
import { SleeveRegistry } from './signal/index.js';

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
  readonly alpacaClient?: AlpacaBrokerClient | undefined;
}

export interface CycleComposition extends CycleDeps {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly capital: CapitalConfigStore;
  readonly journal: Journal;
}

export function composeCycle(options: CycleCompositionOptions): CycleComposition {
  const { db, clock, logger, market, tradingDate } = options;
  const v2Store = guardedStore(db, 'v2');
  const capital = new CapitalConfigStore(v2Store, clock);
  const journal = new Journal(v2Store, clock);
  const registry = new SleeveRegistry();
  for (const sleeve of options.sleeves) registry.register(sleeve);
  const books = new PaperBooks(v2Store, clock, capital, options.openingDate, registry.list());
  const risk = new V2RiskGate({
    books,
    capital,
    market,
    spec: (sleeveId) => registry.spec(sleeveId),
  });
  const executor = createOrderExecutor({
    dryRun: options.dryRun,
    client: options.alpacaClient,
    db,
    clock,
    logger,
    pricing: {
      halfSpreadBps: options.halfSpreadBps,
      impactBps: impactLookup(market, tradingDate, logger),
      fee: venueFee,
    },
    markPrice: (instrument) => market.lastBarBefore(instrument, tradingDate())?.rawClose,
  });
  return {
    registry,
    books,
    capital,
    journal,
    risk,
    executor,
    market,
    clock,
    dryRun: options.dryRun,
    logger,
  };
}
