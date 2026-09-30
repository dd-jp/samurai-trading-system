import { type SaxoSimGateway, SimOnlyRefusal } from './saxo-sim-gateway.js';

export type DrillAssetType = 'CfdOnStock' | 'CfdOnEtf';

export interface SimAccount {
  readonly accountKey: string;
  readonly clientKey: string;
  readonly currency: string;
}

export interface DrillInstrument {
  readonly uic: number;
  readonly assetType: DrillAssetType;
}

export interface InstrumentRules {
  readonly isTradable: boolean;
  readonly minimumAmount: number;
  readonly supportedOrderTypes: readonly string[];
  readonly tickSize: (price: number) => number;
  readonly orderDistances: unknown;
}

export interface SimQuote {
  readonly bid: number;
  readonly ask: number;
  readonly isMarketOpen: boolean;
  readonly shortTradeDisabled: boolean;
  readonly delayedByMinutes: number | undefined;
}

export interface NetPosition {
  readonly uic: number;
  readonly assetType: string;
  readonly amount: number;
  readonly averageOpenPrice: number | undefined;
}

export interface OpenOrder {
  readonly orderId: string;
  readonly uic: number;
  readonly assetType: string;
  readonly openOrderType: string;
  readonly status: string;
  readonly buySell: string;
  readonly amount: number;
  readonly price: number | undefined;
  readonly orderRelation: string | undefined;
}

export interface OrderActivity {
  readonly orderId: string;
  readonly status: string;
  readonly activityTime: string;
  readonly averagePrice: number | undefined;
  readonly fillAmount: number | undefined;
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsOf(body: unknown): Row[] {
  return isRow(body) && Array.isArray(body.Data) ? body.Data.filter(isRow) : [];
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sub(row: Row, field: string): Row {
  const value = row[field];
  return isRow(value) ? value : {};
}

export async function trialAccount(gateway: SaxoSimGateway): Promise<SimAccount> {
  const rows = rowsOf(await gateway.get('/port/v1/accounts/me'));
  const [first] = rows;
  if (first === undefined || rows.some((row) => row.IsTrialAccount !== true)) {
    throw new SimOnlyRefusal(
      'sim_only_refusal: an account on this token is not a Saxo trial account',
    );
  }
  return {
    accountKey: str(first.AccountKey),
    clientKey: str(first.ClientKey),
    currency: str(first.Currency),
  };
}

export async function findInstrument(
  gateway: SaxoSimGateway,
  symbol: string,
  assetType: DrillAssetType,
): Promise<DrillInstrument | undefined> {
  const query = new URLSearchParams({
    Keywords: symbol.split(':')[0] ?? symbol,
    AssetTypes: assetType,
    IncludeNonTradable: 'false',
    $top: '100',
  });
  const match = rowsOf(await gateway.get(`/ref/v1/instruments?${query}`)).find(
    (row) => str(row.Symbol).toLowerCase() === symbol.toLowerCase() && row.AssetType === assetType,
  );
  const uic = num(match?.Identifier);
  return uic === undefined ? undefined : { uic, assetType };
}

function tickSizer(details: Row): (price: number) => number {
  const scheme = sub(details, 'TickSizeScheme');
  const fallback = num(scheme.DefaultTickSize) ?? num(details.TickSize) ?? 0.01;
  const elements = (Array.isArray(scheme.Elements) ? scheme.Elements : [])
    .filter(isRow)
    .map((element) => ({ high: num(element.HighPrice), tick: num(element.TickSize) }))
    .sort((a, b) => (a.high ?? 0) - (b.high ?? 0));
  return (price) =>
    elements.find((element) => element.high !== undefined && price <= element.high)?.tick ??
    fallback;
}

export async function instrumentRules(
  gateway: SaxoSimGateway,
  instrument: DrillInstrument,
): Promise<InstrumentRules> {
  const details = await gateway.get(
    `/ref/v1/instruments/details/${instrument.uic}/${instrument.assetType}`,
  );
  const row = isRow(details) ? details : {};
  const supported = Array.isArray(row.SupportedOrderTypes) ? row.SupportedOrderTypes : [];
  return {
    isTradable: row.IsTradable === true,
    minimumAmount: num(row.MinimumTradeSize) ?? 1,
    supportedOrderTypes: supported.map(String),
    tickSize: tickSizer(row),
    orderDistances: row.OrderDistances,
  };
}

export async function quoteOf(
  gateway: SaxoSimGateway,
  instrument: DrillInstrument,
): Promise<SimQuote> {
  const query = new URLSearchParams({
    Uic: String(instrument.uic),
    AssetType: instrument.assetType,
    FieldGroups: 'Quote,InstrumentPriceDetails',
  });
  const body = await gateway.get(`/trade/v1/infoprices?${query}`);
  const row = isRow(body) ? body : {};
  const quote = sub(row, 'Quote');
  const details = sub(row, 'InstrumentPriceDetails');
  return {
    bid: num(quote.Bid) ?? Number.NaN,
    ask: num(quote.Ask) ?? Number.NaN,
    isMarketOpen: details.IsMarketOpen === true,
    shortTradeDisabled: details.ShortTradeDisabled === true,
    delayedByMinutes: num(quote.DelayedByMinutes),
  };
}

export async function netPositions(gateway: SaxoSimGateway): Promise<NetPosition[]> {
  const body = await gateway.get(
    '/port/v1/netpositions/me?FieldGroups=NetPositionBase,NetPositionView&$top=500',
  );
  return rowsOf(body).map((row) => {
    const base = sub(row, 'NetPositionBase');
    return {
      uic: num(base.Uic) ?? 0,
      assetType: str(base.AssetType),
      amount: num(base.Amount) ?? 0,
      averageOpenPrice: num(sub(row, 'NetPositionView').AverageOpenPrice),
    };
  });
}

export async function openOrders(gateway: SaxoSimGateway): Promise<OpenOrder[]> {
  const body = await gateway.get('/port/v1/orders/me?$top=500');
  return rowsOf(body).map((row) => ({
    orderId: str(row.OrderId),
    uic: num(row.Uic) ?? 0,
    assetType: str(row.AssetType),
    openOrderType: str(row.OpenOrderType),
    status: str(row.Status),
    buySell: str(row.BuySell),
    amount: num(row.Amount) ?? 0,
    price: num(row.Price),
    orderRelation: typeof row.OrderRelation === 'string' ? row.OrderRelation : undefined,
  }));
}

export async function orderActivities(
  gateway: SaxoSimGateway,
  account: SimAccount,
  from: Date,
): Promise<OrderActivity[]> {
  const query = new URLSearchParams({
    AccountKey: account.accountKey,
    ClientKey: account.clientKey,
    FromDateTime: from.toISOString(),
    $top: '500',
  });
  return rowsOf(await gateway.get(`/cs/v1/audit/orderactivities?${query}`)).map((row) => ({
    orderId: str(row.OrderId),
    status: str(row.Status),
    activityTime: str(row.ActivityTime),
    averagePrice: num(row.AveragePrice) ?? num(row.Price),
    fillAmount: num(row.FillAmount),
  }));
}

export function isOn(
  instrument: DrillInstrument,
): (row: { uic: number; assetType: string }) => boolean {
  return (row) => row.uic === instrument.uic && row.assetType === instrument.assetType;
}
