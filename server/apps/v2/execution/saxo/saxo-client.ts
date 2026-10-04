export type SaxoCfdAssetType = 'CfdOnStock' | 'CfdOnIndex' | 'CfdOnEtf';

export type SaxoAssetType = 'Etn' | 'Etf' | 'Etc' | SaxoCfdAssetType;

const CFD_ASSET_TYPES: readonly string[] = ['CfdOnStock', 'CfdOnIndex', 'CfdOnEtf'];

export function isSaxoCfdAssetType(assetType: string): assetType is SaxoCfdAssetType {
  return CFD_ASSET_TYPES.includes(assetType);
}

export type SaxoBuySell = 'Buy' | 'Sell';

export interface SaxoInstrumentDetails {
  readonly Uic: number;
  readonly AssetType: string;
  readonly CurrencyCode: string;
  readonly PriceCurrency?: string | undefined;
  readonly PriceToContractFactor: number;
}

export interface SaxoCfdPriceDetails {
  readonly ShortTradeDisabled: boolean;
  readonly CfdBorrowingCost?: number | undefined;
}

export interface SaxoInfoPrice {
  readonly Uic: number;
  readonly AssetType: SaxoAssetType;
  readonly Bid?: number | undefined;
  readonly Ask?: number | undefined;
  readonly IsMarketOpen: boolean;
  readonly Cfd?: SaxoCfdPriceDetails | undefined;
}

type SaxoOrderType = 'Market' | 'Limit' | 'StopIfTraded';

type SaxoDurationType = 'DayOrder' | 'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill';

interface SaxoOrderDuration {
  readonly DurationType: SaxoDurationType;
}

interface SaxoRelatedOrderRequest {
  readonly OrderType: SaxoOrderType;
  readonly OrderPrice: number;
  readonly BuySell: SaxoBuySell;
  readonly Amount: number;
  readonly AssetType: SaxoAssetType;
  readonly Uic: number;
  readonly OrderDuration: SaxoOrderDuration;
  readonly ManualOrder: false;
  readonly ExternalReference: string;
}

export interface SaxoOrderRequest {
  readonly Uic: number;
  readonly AssetType: SaxoAssetType;
  readonly BuySell: SaxoBuySell;
  readonly Amount: number;
  readonly OrderType: SaxoOrderType;
  readonly OrderPrice?: number | undefined;
  readonly OrderDuration: SaxoOrderDuration;
  readonly ManualOrder: false;
  readonly ExternalReference: string;
  readonly Orders?: readonly SaxoRelatedOrderRequest[];
}

export interface SaxoOrderPlacement {
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Orders?:
    | readonly { readonly OrderId: string; readonly ExternalReference?: string | undefined }[]
    | undefined;
}

type SaxoOpenOrderStatus = 'Working' | 'NotWorking' | (string & {});

export interface SaxoOpenOrder {
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Status: SaxoOpenOrderStatus;
  readonly OpenOrderType: string;
  readonly OrderRelation?: string | undefined;
  readonly Price?: number | undefined;
  readonly Amount: number;
  readonly FilledAmount?: number | undefined;
  readonly BuySell: SaxoBuySell;
  readonly Uic: number;
  readonly AssetType: string;
  readonly RelatedOpenOrders?:
    | readonly {
        readonly OrderId: string;
        readonly OpenOrderType: string;
        readonly OrderPrice?: number | undefined;
        readonly Amount: number;
        readonly Status: string;
      }[]
    | undefined;
}

export interface SaxoOrderActivity {
  readonly ActivityTime: string;
  readonly LogId: string;
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Status: string;
  readonly SubStatus?: string | undefined;
  readonly Amount: number;
  readonly Price?: number | undefined;
  readonly FillAmount?: number | undefined;
  readonly AveragePrice?: number | undefined;
  readonly BuySell: SaxoBuySell;
  readonly Uic: number;
  readonly AssetType: string;
}

export interface SaxoNetPosition {
  readonly NetPositionId: string;
  readonly NetPositionBase: {
    readonly Amount: number;
    readonly Uic: number;
    readonly AssetType: string;
  };
  readonly NetPositionView: {
    readonly AverageOpenPrice?: number | undefined;
  };
  readonly DisplayAndFormat?: {
    readonly Symbol?: string | undefined;
  };
}

export interface SaxoAccountBalance {
  readonly Currency: string;
  readonly CashBalance: number;
  readonly TotalValue: number;
}

export interface SaxoAccountBalanceReader {
  getBalances(): Promise<SaxoAccountBalance>;
}

export interface SaxoOpenApiClient {
  getInstrumentDetails(uic: number, assetType: SaxoAssetType): Promise<SaxoInstrumentDetails>;
  getInfoPrice(uic: number, assetType: SaxoAssetType): Promise<SaxoInfoPrice>;
  placeOrder(request: SaxoOrderRequest, requestId: string): Promise<SaxoOrderPlacement>;
  cancelOrder(orderId: string): Promise<void>;
  listOpenOrders(): Promise<SaxoOpenOrder[]>;
  listOrderActivities(from: Date): Promise<SaxoOrderActivity[]>;
  listNetPositions(): Promise<SaxoNetPosition[]>;
}
