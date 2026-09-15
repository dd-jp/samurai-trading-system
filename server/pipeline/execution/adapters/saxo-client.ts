/**
 * Wire shapes for Saxo OpenAPI (Trading v2 orders, Portfolio v1 orders and
 * net positions, Client Services v1 order-activity audit) — the subset the
 * `SaxoBrokerAdapter` reads and writes (#1032 item 1), and the client
 * interface the adapter is built against so tests can inject a fake.
 *
 * Every field marked VERIFIED was observed on the SIM gateway on 2026-09-05
 * or 2026-09-10 (doc 43 has both probe logs). Fields marked UNVERIFIED come
 * from Saxo's reference documentation and have still not been observed;
 * `saxo-http-client.ts` validates those shapes at the boundary and throws
 * rather than guessing. Round 2 (2026-09-10, #1216) filled real orders and
 * closed the fill-row and position-row gaps the 2026-09-05 round could not
 * reach — but on `Etf`/NASDAQ, the LSE session being closed, so nothing
 * below is measured on a pool line.
 *
 * The LSE ETP universe (ADR-0016) resolves to AssetType `Etn`/`Etf`/`Etc` on
 * ExchangeId `LSE_ETF` — `LSE` returns nothing (`lse-etp-pool.ts`).
 */

/** VERIFIED: the three asset types the pool's lines resolve to */
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
  /** The unit prices are QUOTED in — `GBX` on a pence line whose `CurrencyCode` is `GBP` */
  readonly PriceCurrency?: string | undefined;
  /** Required at the boundary, never defaulted to 1: a defaulted factor is the 100x guess #1302 removes */
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

/** VERIFIED: a related (IfDone) order inside the master's `Orders` array */
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
 * never holds an account identifier
 */
export interface SaxoOrderRequest {
  readonly Uic: number;
  readonly AssetType: SaxoAssetType;
  readonly BuySell: SaxoBuySell;
  readonly Amount: number;
  readonly OrderType: SaxoOrderType;
  readonly OrderPrice?: number | undefined;
  readonly OrderDuration: SaxoOrderDuration;
  /** Always false: Saxo's algorithmic-trading disclosure flag, and this is an algorithm */
  readonly ManualOrder: false;
  /** <= 50 chars, NOT uniqueness-checked by the venue (doc 43) */
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
 * `Working` and `NotWorking` are both observed (doc 43 round 2), but only in
 * this arrangement: a resting IfDone master is one TOP-LEVEL `Working` row
 * whose legs are `NotWorking` sub-rows of `RelatedOpenOrders`; once it fills
 * the legs become top-level `Working` rows. A top-level `NotWorking` leg —
 * the shape `isNeverActivated` reads as "never activated" (#1215 round 1) —
 * has still never been returned. `(string & {})` keeps the type open to
 * whatever else the venue sends rather than asserting a closed contract.
 */
export type SaxoOpenOrderStatus = 'Working' | 'NotWorking' | (string & {});

/** VERIFIED: one row of `GET /port/v1/orders/me`. `FilledAmount` UNVERIFIED (never partially filled on SIM). */
export interface SaxoOpenOrder {
  readonly OrderId: string;
  readonly ExternalReference?: string | undefined;
  readonly Status: SaxoOpenOrderStatus;
  readonly OpenOrderType: string;
  /** VERIFIED values: `IfDoneMaster`, `StandAlone`; `Oco` documented for activated leg pairs */
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
 * One row of `GET /cs/v1/audit/orderactivities`. Every field here is
 * VERIFIED, `FillAmount`/`AveragePrice` included as of doc 43 round 2
 * (#1216). Measured `Status` values: `Placed`, `FinalFill`, `Cancelled`,
 * `Changed`; `SubStatus`: `Requested`, `Confirmed`, `Rejected`. A FULL FILL
 * reads `FinalFill`, NOT `Filled` — see `activityState`. A real row also
 * carries `FilledAmount`, `ExecutionPrice`, `PositionId`, `RelatedOrders`
 * and `OrderRelation`, undeclared here because nothing reads them.
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
 * VERIFIED on a real open position (doc 43 round 2, #1216):
 * `NetPositionBase.Amount`/`Uic` and `NetPositionView.AverageOpenPrice` all
 * observed. `DisplayAndFormat` is still UNVERIFIED: the probe omitted its
 * field group, which the HTTP client does request, so its absence there says
 * nothing. The HTTP client rejects a row without a numeric `NetPositionBase.Amount`
 * and `Uic`.
 */
export interface SaxoNetPosition {
  readonly NetPositionId: string;
  readonly NetPositionBase: {
    /** Signed: negative is short */
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
 * `GET /port/v1/balances/me` — the funding read (#1509).
 *
 * `Currency` is VERIFIED on SIM 2026-09-08 (doc 44 §6.3), and it is the only
 * field this repo has ever observed on this endpoint. It answered `"EUR"`
 * there, on an `IsTrialAccount: true` account whose `DefaultCurrency` is EUR
 * (doc 44 §1) — so the observation says the field exists and says NOTHING
 * about what the live UK GIA reports. Nothing may assume GBP from the venue
 * identity; `same_currency_verified` is set by comparing this field against
 * the declared book currency at runtime.
 *
 * `CashBalance` and `TotalValue` are UNVERIFIED — reference documentation
 * only, never observed here. `saxo-http-client.ts` requires both at the
 * boundary and throws rather than defaulting, because a defaulted funding
 * figure sizes real orders. `TotalValue` is the account value including open
 * positions, which is what maps to the `equity` half of `AccountStateProvider`
 * (`CashBalance` maps to `cash`); `NetEquityForMargin` is a third, different
 * number and is deliberately not read — this is a cash account.
 */
export interface SaxoAccountBalance {
  readonly Currency: string;
  readonly CashBalance: number;
  readonly TotalValue: number;
}

/**
 * The funding read, kept separate from `SaxoOpenApiClient` (#1509).
 *
 * Narrow rather than folded into the wide interface: the wide one is what
 * every broker-adapter test fake implements, and an account read is not part
 * of placing or reconciling an order. Declaring it optional on the wide
 * interface would be worse than either — the composition root could not then
 * rely on it being there.
 */
export interface SaxoAccountBalanceReader {
  getBalances(): Promise<SaxoAccountBalance>;
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
   * is the only endpoint that says what unit the line is quoted in (#1302)
   */
  getInstrumentDetails(uic: number, assetType: SaxoAssetType): Promise<SaxoInstrumentDetails>;
  placeOrder(request: SaxoOrderRequest, requestId: string): Promise<SaxoOrderPlacement>;
  /** Cancels the order and, for an IfDone master, its related orders (VERIFIED). Throws 404 `OrderNotFound` when already gone. */
  cancelOrder(orderId: string): Promise<void>;
  listOpenOrders(): Promise<SaxoOpenOrder[]>;
  listOrderActivities(from: Date): Promise<SaxoOrderActivity[]>;
  listNetPositions(): Promise<SaxoNetPosition[]>;
}
