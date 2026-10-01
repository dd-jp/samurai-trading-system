import { readFileSync } from 'node:fs';
import type {
  BrokerMode,
  FillLeg,
  MarketData,
  OrderLeg,
  OrderSide,
  Venue,
} from '../../../contracts/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openReadOnlyStore } from '../../shared/store/index.js';
import { isMainModule } from '../../tools/cli-entrypoint.js';
import {
  type BrokerFillPart,
  type BrokerOrder,
  costFidelityReport,
  formatCostFidelityReport,
  type QuoteFill,
} from './cost-fidelity.js';
import { BarsMarketData, ParquetBarsSource, parseBoeGbpUsdCsv } from './data/index.js';
import {
  impactLookup,
  quoteSimulatedFill,
  venueFee,
  venueHalfSpreadBps,
} from './execution/index.js';
import {
  FX_PATH,
  halfSpreadLookup,
  SAXO_SPREADS_PATH,
  SPREADS_PATH,
  V2_STORE_PATH,
} from './index.js';

const OPEN_WINDOW = { from: '0000-01-01', to: '9999-12-31' };

interface OrderRow {
  readonly client_order_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: string;
  readonly leg: string;
  readonly side: string;
  readonly payload: string;
  readonly entry_payload: string | null;
}

interface FillRow {
  readonly client_order_id: string;
  readonly leg: string;
  readonly side: string;
  readonly trading_date: string;
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
}

// Only a primary book's Alpaca order outside a dry run reaches the broker (V2OrderExecutor
// .simulates); an exit takes the entry offset of the latest filled entry it closes (#1815)
const BROKER_ORDERS_SQL = `
  SELECT o.client_order_id, o.trading_date, o.instrument, o.venue, o.leg, o.side, o.payload,
         CASE WHEN o.leg = 'entry' THEN o.payload ELSE (
           SELECT e.payload FROM v2_orders e
            WHERE e.book_id = o.book_id AND e.instrument = o.instrument AND e.leg = 'entry'
              AND e.trading_date <= o.trading_date
              AND EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = e.client_order_id)
            ORDER BY e.trading_date DESC, e.client_order_id DESC LIMIT 1) END AS entry_payload
    FROM v2_orders o JOIN v2_books b ON b.book_id = o.book_id
   WHERE b.variant = 'primary' AND o.venue = 'alpaca' AND o.dry_run = 0
     AND o.outcome IN ('submitted', 'cancelled') AND o.trading_date BETWEEN ? AND ?
   ORDER BY o.trading_date, o.client_order_id`;

const FILLS_SQL = `
  SELECT client_order_id, leg, side, trading_date, qty, price_gbp, fee_gbp FROM v2_fills
   ORDER BY trading_date, fill_id`;

function brokerModeOf(arg: string): BrokerMode {
  if (arg === 'paper' || arg === 'live') return arg;
  throw new Error(`broker mode must be paper or live, got ${arg}`);
}

function numberIn(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

// An entry journalled before #1815 carries no limit and went out at 0 bps; one with a limit
// and no offset had its limit set by its sleeve
export function entryOffsetBps(entryPayload: string | null): number | null | undefined {
  if (entryPayload === null) return undefined;
  const payload = JSON.parse(entryPayload) as Record<string, unknown>;
  const offset = numberIn(payload, 'entry_offset_bps');
  if (offset !== undefined) return offset;
  return numberIn(payload, 'limit') === undefined ? 0 : null;
}

function partOf(row: FillRow): BrokerFillPart {
  return {
    leg: row.leg as FillLeg,
    side: row.side as OrderSide,
    tradingDate: row.trading_date,
    qty: row.qty,
    priceGbp: row.price_gbp,
    feeGbp: row.fee_gbp,
  };
}

function orderOf(row: OrderRow, fills: readonly BrokerFillPart[]): BrokerOrder {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const cancelled = payload.cancelled;
  return {
    clientOrderId: row.client_order_id,
    tradingDate: row.trading_date,
    instrument: row.instrument,
    venue: row.venue as Venue,
    leg: row.leg as OrderLeg,
    side: row.side as OrderSide,
    limit: numberIn(payload, 'limit') ?? numberIn(payload, 'price'),
    trigger: numberIn(payload, 'trigger'),
    stop: numberIn(payload, 'stop'),
    target: numberIn(payload, 'target'),
    cancelledOn: typeof cancelled === 'string' ? cancelled : undefined,
    offsetBps: entryOffsetBps(row.entry_payload),
    fills,
  };
}

export function readBrokerOrders(
  db: StoreHandle,
  window: { readonly from: string; readonly to: string } = OPEN_WINDOW,
): readonly BrokerOrder[] {
  const orders = db.prepare(BROKER_ORDERS_SQL).all(window.from, window.to) as OrderRow[];
  const fillsByOrder = new Map<string, BrokerFillPart[]>();
  for (const row of db.prepare(FILLS_SQL).all() as FillRow[]) {
    fillsByOrder.set(row.client_order_id, [
      ...(fillsByOrder.get(row.client_order_id) ?? []),
      partOf(row),
    ]);
  }
  return orders.map((row) => orderOf(row, fillsByOrder.get(row.client_order_id) ?? []));
}

export function fillQuoter(
  market: MarketData,
  halfSpreadBps: (instrument: string) => number,
): QuoteFill {
  return (tradingDate, venue, request) =>
    quoteSimulatedFill(venue, request, {
      halfSpreadBps: venueHalfSpreadBps(halfSpreadBps, undefined),
      impactBps: impactLookup(market, () => tradingDate),
      fee: (feeVenue, side, qty, price) => venueFee(feeVenue, side, qty, price),
    });
}

export interface CostFidelityInputs {
  readonly storePath: string;
  readonly barRoot: string;
  readonly from: string;
  readonly to: string;
  readonly mode: BrokerMode;
}

export async function reportCostFidelity(
  inputs: CostFidelityInputs,
  openStore: (path: string) => StoreHandle = openReadOnlyStore,
): Promise<string> {
  const db = openStore(inputs.storePath);
  try {
    const bars = new ParquetBarsSource(inputs.barRoot, 'alpaca');
    await bars.prime();
    const market = new BarsMarketData(bars, parseBoeGbpUsdCsv(readFileSync(FX_PATH, 'utf8')));
    const report = costFidelityReport(
      readBrokerOrders(db, inputs),
      market,
      fillQuoter(market, halfSpreadLookup(SPREADS_PATH, SAXO_SPREADS_PATH)),
      inputs.mode,
    );
    return formatCostFidelityReport(report);
  } finally {
    db.close();
  }
}

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  report = reportCostFidelity,
): Promise<number> {
  const [
    storePath = V2_STORE_PATH,
    barRoot = DEFAULT_BAR_STORE_ROOT,
    from = OPEN_WINDOW.from,
    to = OPEN_WINDOW.to,
    mode = 'paper',
  ] = argv;
  try {
    write(await report({ storePath, barRoot, from, to, mode: brokerModeOf(mode) }));
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), (line) => console.log(line));
}
