import {
  applyBarHygiene,
  DEFAULT_BAR_STORE_ROOT,
  ParquetBarStore,
  repairBarShape,
} from '../../providers/bar-store/index.js';
import {
  type ChartPage,
  gbpPerQuotedUnit,
  openSaxoLiveSession,
  type SaxoChartAssetType,
  samplesToBars,
} from '../../providers/saxo-bars/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { flagPairs, setExitCodeWhenInvoked } from '../../tools/cli-entrypoint.js';
import { messageOf, roundPrices } from './bar-refresh-core.js';
import {
  CFD_CATALOGUE_PATH,
  type CfdCatalogue,
  type CfdInstrument,
  loadCfdCatalogue,
} from './data/index.js';
import { quotedUnitOf } from './uk-stock-bar-refresh.js';

const SAXO_VENUE = 'saxo';
const OHLC = ['open', 'high', 'low', 'close'] as const;

export interface UkBarHeadApi {
  dailyHistory(uic: number, assetType: SaxoChartAssetType): Promise<ChartPage>;
}

export type UkBarHeadOutcome =
  | { readonly symbol: string; readonly outcome: 'would_fill' | 'filled'; readonly added: string[] }
  | { readonly symbol: string; readonly outcome: 'nothing_older' }
  | { readonly symbol: string; readonly outcome: 'refused'; readonly reason: string };

export interface UkBarHeadRequest {
  readonly symbols: readonly string[];
  readonly from: string;
  readonly tradingDate: string;
  readonly write: boolean;
}

interface FillContext extends UkBarHeadRequest {
  readonly api: UkBarHeadApi;
  readonly store: ParquetBarStore;
  readonly catalogue: CfdCatalogue;
}

function overlapConflict(stored: BarSeries, pulled: readonly DailyBar[]): string | undefined {
  const byDate = new Map(pulled.map((bar) => [bar.date, bar]));
  for (const bar of stored.bars) {
    const twin = byDate.get(bar.date);
    if (twin === undefined) return `Saxo no longer serves the stored bar ${bar.date}`;
    const field = OHLC.find((name) => bar[name] !== twin[name]);
    if (field !== undefined) {
      return `${bar.date} ${field} is ${bar[field]} stored and ${twin[field]} from Saxo`;
    }
  }
  return undefined;
}

async function pulledBars(
  instrument: CfdInstrument,
  context: FillContext,
): Promise<readonly DailyBar[]> {
  const page = await context.api.dailyHistory(instrument.uic, 'CfdOnStock');
  const bars = samplesToBars(page.samples, gbpPerQuotedUnit(quotedUnitOf(instrument)));
  const hygiene = applyBarHygiene(instrument.symbol, bars, { fetchDate: context.tradingDate });
  return roundPrices(repairBarShape(hygiene.bars).bars);
}

// The prepended bars take the stored head's raw/adjusted ratio, so a split inside the stored
// series reads the same step as the bars already there
function withStoredRawScale(older: readonly DailyBar[], head: DailyBar): DailyBar[] {
  const scale = head.rawClose / head.close;
  return roundPrices(older.map((bar) => ({ ...bar, rawClose: bar.close * scale })));
}

async function fillResolved(
  instrument: CfdInstrument,
  stored: BarSeries,
  head: DailyBar,
  context: FillContext,
): Promise<UkBarHeadOutcome> {
  const symbol = instrument.symbol;
  const pulled = await pulledBars(instrument, context);
  const conflict = overlapConflict(stored, pulled);
  if (conflict !== undefined) return { symbol, outcome: 'refused', reason: conflict };
  const older = pulled.filter((bar) => bar.date >= context.from && bar.date < head.date);
  if (older.length === 0) return { symbol, outcome: 'nothing_older' };
  const added = older.map((bar) => bar.date);
  if (!context.write) return { symbol, outcome: 'would_fill', added };
  const bars = [...withStoredRawScale(older, head), ...stored.bars];
  await context.store.write(SAXO_VENUE, [{ symbol, bars }]);
  return { symbol, outcome: 'filled', added };
}

async function fillSymbol(symbol: string, context: FillContext): Promise<UkBarHeadOutcome> {
  const instrument = context.catalogue.instruments.find((one) => one.symbol === symbol);
  if (instrument === undefined) {
    return { symbol, outcome: 'refused', reason: 'not in the CFD catalogue' };
  }
  const stored = await context.store.readSeries(SAXO_VENUE, symbol);
  const head = stored?.bars[0];
  if (stored === undefined || head === undefined) {
    return { symbol, outcome: 'refused', reason: 'no stored bars to extend' };
  }
  return fillResolved(instrument, stored, head, context);
}

async function fillSymbolSafely(symbol: string, context: FillContext): Promise<UkBarHeadOutcome> {
  try {
    return await fillSymbol(symbol, context);
  } catch (error) {
    return { symbol, outcome: 'refused', reason: messageOf(error) };
  }
}

export async function fillUkBarHeads(
  api: UkBarHeadApi,
  store: ParquetBarStore,
  catalogue: CfdCatalogue,
  request: UkBarHeadRequest,
): Promise<UkBarHeadOutcome[]> {
  const context: FillContext = { ...request, api, store, catalogue };
  const outcomes: UkBarHeadOutcome[] = [];
  for (const symbol of request.symbols) outcomes.push(await fillSymbolSafely(symbol, context));
  return outcomes;
}

const USAGE =
  'usage: uk-stock-bar-head --symbols OCDO_XLON,PNN_XLON --from 2022-01-14 [--mode dry-run|write]';

export function parseUkBarHeadArgs(argv: readonly string[], tradingDate: string): UkBarHeadRequest {
  const flags = flagPairs(argv, ['--symbols', '--from', '--mode'], USAGE);
  const symbols = flags.get('symbols')?.split(',') ?? [];
  const from = flags.get('from') ?? '';
  const mode = flags.get('mode') ?? 'dry-run';
  if (symbols.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(USAGE);
  if (mode !== 'dry-run' && mode !== 'write') throw new Error(USAGE);
  return { symbols, from, tradingDate, write: mode === 'write' };
}

export interface UkBarHeadDeps {
  readonly connect: () => { api: UkBarHeadApi; stop: () => Promise<void> };
  readonly storeRoot: string;
  readonly catalogue: () => CfdCatalogue | undefined;
  readonly now: () => Date;
  readonly write: (line: string) => void;
}

export async function runUkBarHead(argv: readonly string[], deps: UkBarHeadDeps): Promise<number> {
  const request = parseUkBarHeadArgs(argv, deps.now().toISOString().slice(0, 10));
  const catalogue = deps.catalogue();
  if (catalogue === undefined) throw new Error('no CFD catalogue on disk');
  const session = deps.connect();
  const store = await ParquetBarStore.open(deps.storeRoot);
  try {
    const outcomes = await fillUkBarHeads(session.api, store, catalogue, request);
    for (const outcome of outcomes) deps.write(`${JSON.stringify(outcome)}\n`);
    return outcomes.some((outcome) => outcome.outcome === 'refused') ? 1 : 0;
  } finally {
    store.close();
    await session.stop();
  }
}

void setExitCodeWhenInvoked(import.meta.url, () =>
  runUkBarHead(process.argv.slice(2), {
    connect: () => openSaxoLiveSession(process.env),
    storeRoot: DEFAULT_BAR_STORE_ROOT,
    catalogue: () => loadCfdCatalogue(CFD_CATALOGUE_PATH),
    now: () => new Date(),
    write: (line) => process.stdout.write(line),
  }),
);
