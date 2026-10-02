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
import { setExitCodeWhenInvoked, writeOrFail } from '../../tools/cli-entrypoint.js';
import {
  type BrokerFillPart,
  type BrokerOrder,
  costFidelityReport,
  formatCostFidelityReport,
  type QuoteFill,
} from './cost-fidelity.js';
import { BarsMarketData, ParquetBarsSource, parseBoeGbpUsdCsv } from './data/index.js';
import { CLOSE_LEGS_SQL, entryOffsetOfPayload, entryPayloadOfClose } from './entry-offset.js';
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
  readonly entry_journalled: number;
  readonly entry_offset_bps: number | null;
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

const NO_CLOSE_YET = '9223372036854775807';

// Only a primary book's Alpaca order outside a dry run reaches the broker (V2OrderExecutor
// .simulates); an exit takes the entry offset of the entry it closes (#1815)
const BROKER_ORDERS_SQL = `
  SELECT t.client_order_id, t.trading_date, t.instrument, t.venue, t.leg, t.side, t.payload,
         t.entry_payload IS NOT NULL AS entry_journalled,
         ${entryOffsetOfPayload('t.entry_payload')} AS entry_offset_bps
    FROM (
      SELECT o.client_order_id, o.trading_date, o.instrument, o.venue, o.leg, o.side, o.payload,
             CASE WHEN o.leg = 'entry' THEN o.payload ELSE ${entryPayloadOfClose({
               bookId: 'o.book_id',
               instrument: 'o.instrument',
               orderId: 'o.client_order_id',
               at: `COALESCE((SELECT MIN(f.rowid) FROM v2_fills f
                               WHERE f.client_order_id = o.client_order_id AND f.${CLOSE_LEGS_SQL}),
                             ${NO_CLOSE_YET})`,
             })} END AS entry_payload
        FROM v2_orders o JOIN v2_books b ON b.book_id = o.book_id
       WHERE b.variant = 'primary' AND o.venue = 'alpaca' AND o.dry_run = 0
         AND o.outcome IN ('submitted', 'cancelled') AND o.trading_date BETWEEN ? AND ?
    ) t
   ORDER BY t.trading_date, t.client_order_id`;

const FILLS_SQL = `
  SELECT client_order_id, leg, side, trading_date, qty, price_gbp, fee_gbp FROM v2_fills
   WHERE leg <> 'cash_in_lieu' ORDER BY trading_date, fill_id`;

function brokerModeOf(arg: string): BrokerMode {
  if (arg === 'paper' || arg === 'live') return arg;
  throw new Error(`broker mode must be paper or live, got ${arg}`);
}

function numberIn(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
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
    modelledSlippageBps: numberIn(payload, 'modelled_slippage_bps'),
    offsetBps: row.entry_journalled === 1 ? row.entry_offset_bps : undefined,
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
  return writeOrFail(write, () =>
    report({ storePath, barRoot, from, to, mode: brokerModeOf(mode) }),
  );
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
