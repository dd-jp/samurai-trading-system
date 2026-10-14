import {
  type ChartPage,
  gbpPerQuotedUnit,
  type SaxoChartAssetType,
  samplesToBars,
} from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import type { BarRefresh } from './bar-refresh-core.js';
import { logRefresh } from './bar-refresh-core.js';
import {
  CFD_CATALOGUE_PATH,
  type CfdCatalogue,
  type CfdInstrument,
  inUkStockBarPool,
  loadCfdCatalogue,
} from './data/index.js';
import {
  type BarLine,
  liveSaxoConnect,
  type SaxoBarLegPlan,
  type SaxoBarRefreshDeps,
  saxoBarLegFor,
} from './saxo-bar-refresh.js';
import { requireSet, UK_STOCK_SCREENS } from './signal/index.js';

export interface UkStockBarsApi {
  dailyPage(uic: number, assetType: SaxoChartAssetType): Promise<ChartPage>;
}

const UK_STOCK_BAR_REFRESH_TIME_LIMIT_MS = 5 * 60_000;
const UK_STOCK_STOP_AFTER_FAILURES_IN_A_ROW = 5;

function quotedUnitOf(instrument: CfdInstrument): 'GBX' | 'GBP' {
  if (instrument.currency === 'GBP' && instrument.priceToContractFactor === 0.01) return 'GBX';
  if (instrument.currency === 'GBP' && instrument.priceToContractFactor === 1) return 'GBP';
  throw new Error(
    `${instrument.symbol}: ${instrument.currency} at PriceToContractFactor ${instrument.priceToContractFactor} is not a GBX or GBP quote`,
  );
}

function ukStockBarLine(instrument: CfdInstrument, api: UkStockBarsApi): BarLine {
  return {
    tidm: instrument.symbol,
    windowed: true,
    pull: async () => {
      const unit = quotedUnitOf(instrument);
      const page = await api.dailyPage(instrument.uic, 'CfdOnStock');
      return samplesToBars(page.samples, gbpPerQuotedUnit(unit));
    },
  };
}

export function ukStockBarLines(
  catalogue: CfdCatalogue | undefined,
  tradingDate: string,
  api: UkStockBarsApi,
  logger: Logger,
): BarLine[] {
  if (catalogue === undefined || !catalogue.freshOn(tradingDate)) {
    throw new Error(`no CFD catalogue fresh on ${tradingDate}`);
  }
  const screens = requireSet(UK_STOCK_SCREENS);
  const pool = catalogue.instruments.filter((instrument) => inUkStockBarPool(instrument, screens));
  logRefresh(
    logger,
    'info',
    'v2_uk_stock_bar_pool',
    `${pool.length} UK stock CFDs pass the price and ADV screens in the ${catalogue.asOf} catalogue; pulling their bars`,
  );
  return pool.map((instrument) => ukStockBarLine(instrument, api));
}

export interface UkStockBarRefreshDeps extends SaxoBarRefreshDeps<UkStockBarsApi> {
  readonly catalogue?: () => CfdCatalogue | undefined;
}

// Its own session and cap, so a slow or failing UK pull never cuts the LSE lines' refresh
export function ukStockBarRefreshFor(
  env: NodeJS.ProcessEnv,
  tradingDate: string,
  logger: Logger,
  deps: UkStockBarRefreshDeps = {},
): BarRefresh {
  const catalogue = deps.catalogue ?? (() => loadCfdCatalogue(CFD_CATALOGUE_PATH));
  const plan: SaxoBarLegPlan<UkStockBarsApi> = {
    linesFor: (api, log) => ukStockBarLines(catalogue(), tradingDate, api, log),
    labels: {
      noun: 'UK stock CFD bars',
      summaryEvent: 'v2_uk_stock_bar_refresh_summary',
      stopAfterFailuresInARow: UK_STOCK_STOP_AFTER_FAILURES_IN_A_ROW,
    },
    unavailableEvent: 'v2_uk_stock_bar_refresh_unavailable',
    whenUnavailable: 'UK stock reads keep the last stored bars and fail closed once they go stale',
    timeLimitMs: UK_STOCK_BAR_REFRESH_TIME_LIMIT_MS,
  };
  const connect = deps.connect ?? liveSaxoConnect(deps.tokenPath);
  return saxoBarLegFor(env, tradingDate, logger, plan, { ...deps, connect });
}
