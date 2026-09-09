/**
 * Wire shapes for Saxo OpenAPI (Trading v2 orders, Portfolio v1 orders and
 * net positions, Client Services v1 order-activity audit) — the subset the
 * `SaxoBrokerAdapter` reads and writes (#1032 item 1), and the client
 * interface the adapter is built against so tests can inject a fake.
 *
 * Every field marked VERIFIED was observed on the SIM gateway on 2026-09-05
 * (doc 43 has the probe log). Fields marked UNVERIFIED come from Saxo's
 * reference documentation and could not be observed because the SIM account
 * had no market-data entitlement (`/trade/v1/infoprices` -> `NoAccess`) and
 * therefore no fill ever happened: fill-carrying activity rows and non-empty
 * position rows were never returned. `saxo-http-client.ts` validates those
 * shapes at the boundary and throws rather than guessing.
 *
 * The LSE ETP universe (ADR-0016) resolves to AssetType `Etn`/`Etf`/`Etc` on
 * ExchangeId `LSE_ETF` — `LSE` returns nothing (`lse-etp-pool.ts`).
 */

/** VERIFIED: the three asset types the pool's lines resolve to. */
export type SaxoAssetType = 'Etn' | 'Etf' | 'Etc';

export type SaxoBuySell = 'Buy' | 'Sell';

/**
 * VERIFIED on SIM 2026-09-08 (doc 44 §2.1): the quote-unit slice of
 * `GET /ref/v1/instruments/details/{Uic}/{AssetType}`. LQQ3 (Uic 29391797,
 * `Etn`) returns `CurrencyCode` `GBP`, `PriceCurrency` `GBX`,
 * `PriceToContractFactor` `0.01`; 3USL (Uic 3347273, `Etn`) returns `USD`,
 * `USD`, `1.0`. The search endpoint and `infoprices` carry neither of the
 * last two, which is why #1302's collision is invisible from there.
 */
export interface SaxoInstrumentDetails {
  readonly Uic: number;
  readonly AssetType: string;
  /** The currency `price x PriceToContractFactor` is denominated in. Not the quote unit. */
  readonly CurrencyCode: string;
  /** The unit prices are QUOTED in — `GBX` on a pence line whose `CurrencyCode` is `GBP`. */
  readonly PriceCurrency?: string | undefined;
  /** Required at the boundary, never defaulted to 1: a defaulted factor is the 100x guess #1302 removes. */
  readonly PriceToContractFactor: number;
}

/**
 * VERIFIED: the subset of the `Etn` `SupportedOrderTypes` list this adapter
 * uses. Plain `Stop` is rejected with `OrderTypeNotSupported`; the
 * stop-market leg is `StopIfTraded`.
 */
export type SaxoOrderType = 'Market' | 'Limit' | 'StopIfTraded';

export type SaxoDurationType = 'DayOrder' | 'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill';

export interface SaxoOrderDuration {
  readonly DurationType: SaxoDurationType;
}

/** VERIFIED: a related (IfDone) order inside the master's `Orders` array. */
export interface SaxoRelatedOrderRequest {
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

/**
 * VERIFIED: `POST /trade/v2/orders` body minus `AccountKey`, which the HTTP
 * client adds from the account it resolved at construction so the adapter
 * never holds an account identifier.
 */
export interface SaxoOrderRequest {
  readonly Uic: number;
  readonly AssetType: SaxoAssetType;
  readonly BuySell: SaxoBuySell;
  readonly Amount: number;
  readonly OrderType: SaxoOrderType;
  readonly OrderPrice?: number | undefined;
  readonly OrderDuration: SaxoOrderDuration;
  /** Always false: Saxo's algorithmic-trading disclosure flag, and this is an algorithm. */
  readonly ManualOrder: false;
  /** <= 50 chars, NOT uniqueness-checked by the venue (doc 43). */
  readonly ExternalReference: string;
  readonly Orders?: readonly SaxoRelatedOrderRequest[];
}

/** VERIFIED: 200 body of an accepted placement. Related orders echo their own ExternalReference. */
export interface SaxoOrderPlacement {
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Orders?:
    | readonly { readonly OrderId: string; readonly ExternalReference?: string | undefined }[]
    | undefined;
}

/**
 * UNVERIFIED (#1215 round 1) — no probe in doc 43 ever listed a resting
 * IfDone leg row: every probe there was a standalone `DayOrder` `Limit`,
 * always `Working`. `NotWorking` as "never activated" is #1212's own
 * reading, uncited to any observed row. `(string & {})` keeps the type open
 * to whatever else the venue actually sends rather than asserting a closed
 * contract nothing has confirmed.
 */
export type SaxoOpenOrderStatus = 'Working' | 'NotWorking' | (string & {});

/** VERIFIED: one row of `GET /port/v1/orders/me`. `FilledAmount` UNVERIFIED (never partially filled on SIM). */
export interface SaxoOpenOrder {
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Status: SaxoOpenOrderStatus;
  readonly OpenOrderType: string;
  /** VERIFIED values: `IfDoneMaster`, `StandAlone`; `Oco` documented for activated leg pairs. */
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

/**
 * One row of `GET /cs/v1/audit/orderactivities`. `LogId`, `OrderId`,
 * `ExternalReference`, `Status` (`Placed`), `SubStatus` (`Rejected`),
 * `ActivityTime`, `Amount`, `Price`, `BuySell`, `Uic`, `AssetType` are
 * VERIFIED. `FillAmount` and `AveragePrice` are UNVERIFIED: they are the
 * documented fill fields, and the adapter books a fill only when both are
 * present and finite — a `Filled` row without them is thrown, not dropped.
 */
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

/**
 * One row of `GET /port/v1/netpositions/me?FieldGroups=NetPositionBase,NetPositionView`.
 * UNVERIFIED end to end — SIM returned `{"__count":0,"Data":[]}` with no
 * position ever opened. Shape from the reference documentation; the HTTP
 * client rejects a row that does not carry a numeric `NetPositionBase.Amount`
 * and `Uic`.
 */
export interface SaxoNetPosition {
  readonly NetPositionId: string;
  readonly NetPositionBase: {
    /** Signed: negative is short. */
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

/**
 * The venue seam the adapter is built against. `saxo-http-client.ts` is the
 * real one; tests inject a fake.
 *
 * `requestId` is sent as `x-request-id`: Saxo's duplicate guard keys on it
 * together with the body for a rolling window (doc 43), so the adapter passes
 * the client order id and a genuine retry within the window is refused with
 * 409 instead of placing twice.
 */
export interface SaxoOpenApiClient {
  /**
   * Reference data, read once per instrument when the resolver is built: it
   * is the only endpoint that says what unit the line is quoted in (#1302).
   */
  getInstrumentDetails(uic: number, assetType: SaxoAssetType): Promise<SaxoInstrumentDetails>;
  placeOrder(request: SaxoOrderRequest, requestId: string): Promise<SaxoOrderPlacement>;
  /** Cancels the order and, for an IfDone master, its related orders (VERIFIED). Throws 404 `OrderNotFound` when already gone. */
  cancelOrder(orderId: string): Promise<void>;
  listOpenOrders(): Promise<SaxoOpenOrder[]>;
  listOrderActivities(from: Date): Promise<SaxoOrderActivity[]>;
  listNetPositions(): Promise<SaxoNetPosition[]>;
}
