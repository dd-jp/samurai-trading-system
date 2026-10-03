import type {
  BrokerCashActivity,
  BrokerMode,
  MarketData,
  ReconcileDiff,
  Venue,
} from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import { type QuoteCurrency, quoteCurrencyOf } from './data/index.js';

export interface CashAnchor {
  readonly currency: QuoteCurrency;
  readonly cashQuote: number;
  readonly fillSeq: number;
  readonly brokerMode: BrokerMode;
  readonly tradingDate: string;
}

export type StoreFlow =
  | { readonly ok: true; readonly quote: number }
  | { readonly ok: false; readonly reason: string };

export interface CashAnchorLedger {
  anchor(venue: Venue): CashAnchor | undefined;
  recordAnchor(
    venue: Venue,
    brokerMode: BrokerMode,
    cashQuote: number,
    tradingDate: string,
  ): CashAnchor;
  storeFlowSince(anchor: Pick<CashAnchor, 'brokerMode' | 'fillSeq'>, venue: Venue): StoreFlow;
  recordActivity(
    venue: Venue,
    brokerMode: BrokerMode,
    activity: BrokerCashActivity,
    tradingDate: string,
  ): boolean;
}

export type CashMoveKind = 'deposit' | 'withdrawal';

export interface CashMove {
  readonly venue: Venue;
  readonly kind: CashMoveKind;
  readonly amountQuote: number;
  readonly reference: string;
  readonly tradingDate: string;
}

const MOVE_SIGN: Readonly<Record<CashMoveKind, 1 | -1>> = { deposit: 1, withdrawal: -1 };

const GO_LIVE_REFERENCE = 'go-live';

// Shadow and control books never trade at a broker, so only fills of broker-routed orders move the
// venue's cash (the tax log's BROKER_FILLS rule); a paper account's fills never move a live one's
const STORE_FLOW = `
  SELECT SUM(f.price_native IS NULL OR f.fee_native IS NULL) AS unpriced,
    COALESCE(SUM(CASE f.side WHEN 'sell' THEN 1 ELSE -1 END * f.qty * f.price_native
      - f.fee_native), 0) AS flow
  FROM v2_fills f JOIN v2_orders o ON o.client_order_id = f.client_order_id
  WHERE f.venue = ? AND f.broker_mode = ? AND f.fill_seq > ?
    AND o.outcome NOT IN ('simulated', 'refused_dry_run')`;

// Each status the broker reports brings the activity's sum to that status's amount, and a canceled
// activity stays at zero whatever is read after it; a status already journalled is not re-read
const RECORD_ACTIVITY = `
  INSERT INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_seq, reference,
    trading_date, recorded_at, broker_mode, activity_id, activity_type, activity_date, status)
  SELECT @venue, 'activity', @currency,
    CASE WHEN @status = 'canceled' OR COALESCE(SUM(status = 'canceled'), 0) > 0 THEN 0
         ELSE @amount END - COALESCE(SUM(amount_quote), 0),
    NULL, @reference, @tradingDate, @recordedAt, @brokerMode, @activityId, @activityType,
    @activityDate, @status
  FROM v2_cash_anchors WHERE venue = @venue AND kind = 'activity' AND activity_id = @activityId
  HAVING NOT EXISTS (SELECT 1 FROM v2_cash_anchors WHERE venue = @venue AND reference = @reference)`;

export class SqliteCashAnchors implements CashAnchorLedger {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  anchor(venue: Venue): CashAnchor | undefined {
    const row = this.db
      .prepare(
        `SELECT a.currency, a.fill_seq, a.broker_mode, a.trading_date,
           (SELECT SUM(m.amount_quote) FROM v2_cash_anchors m WHERE m.venue = a.venue
              AND (m.kind <> 'activity' OR m.broker_mode = a.broker_mode)) AS cash_quote
         FROM v2_cash_anchors a WHERE a.venue = ? AND a.kind = 'anchor'`,
      )
      .get(venue) as
      | {
          currency: QuoteCurrency;
          fill_seq: number;
          broker_mode: BrokerMode;
          trading_date: string;
          cash_quote: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      currency: row.currency,
      cashQuote: row.cash_quote,
      fillSeq: row.fill_seq,
      brokerMode: row.broker_mode,
      tradingDate: row.trading_date,
    };
  }

  recordAnchor(
    venue: Venue,
    brokerMode: BrokerMode,
    cashQuote: number,
    tradingDate: string,
  ): CashAnchor {
    this.db
      .prepare(
        `INSERT INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_seq, reference,
           trading_date, broker_mode, recorded_at)
         SELECT ?, 'anchor', ?, ?, COALESCE(MAX(fill_seq), 0), ?, ?, ?, ? FROM v2_fills`,
      )
      .run(
        venue,
        quoteCurrencyOf(venue),
        cashQuote,
        GO_LIVE_REFERENCE,
        tradingDate,
        brokerMode,
        toStoredTimestamp(this.clock.now()),
      );
    return this.anchor(venue) as CashAnchor;
  }

  recordMove(move: CashMove): CashAnchor {
    if (!(move.amountQuote > 0 && Number.isFinite(move.amountQuote))) {
      throw new Error(`a ${move.kind} must be a positive amount, not ${move.amountQuote}`);
    }
    if (this.anchor(move.venue) === undefined) {
      throw new Error(
        `no cash anchor for ${move.venue} yet: the first clean live reconcile records the broker cash, deposits before it included`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_seq, reference,
           trading_date, recorded_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        move.venue,
        move.kind,
        quoteCurrencyOf(move.venue),
        MOVE_SIGN[move.kind] * move.amountQuote,
        move.reference,
        move.tradingDate,
        toStoredTimestamp(this.clock.now()),
      );
    return this.anchor(move.venue) as CashAnchor;
  }

  recordActivity(
    venue: Venue,
    brokerMode: BrokerMode,
    activity: BrokerCashActivity,
    tradingDate: string,
  ): boolean {
    const inserted = this.db.prepare(RECORD_ACTIVITY).run({
      venue,
      currency: quoteCurrencyOf(venue),
      amount: activity.amount,
      reference: `activity:${activity.activity_id}:${activity.status}`,
      tradingDate,
      recordedAt: toStoredTimestamp(this.clock.now()),
      brokerMode,
      activityId: activity.activity_id,
      activityType: activity.activity_type,
      activityDate: activity.activity_date,
      status: activity.status,
    });
    return inserted.changes > 0;
  }

  storeFlowSince(anchor: Pick<CashAnchor, 'brokerMode' | 'fillSeq'>, venue: Venue): StoreFlow {
    const row = this.db.prepare(STORE_FLOW).get(venue, anchor.brokerMode, anchor.fillSeq) as {
      unpriced: number | null;
      flow: number;
    };
    if ((row.unpriced ?? 0) > 0) {
      return {
        ok: false,
        reason: `${row.unpriced} ${venue} fill(s) since the anchor carry no native price (migration 0085)`,
      };
    }
    return { ok: true, quote: row.flow };
  }
}

type DayRate =
  | { readonly ok: true; readonly quotePerGbp: number; readonly source: string }
  | { readonly ok: false; readonly reason: string };

export function dayRateFor(
  market: Pick<MarketData, 'gbpUsdOnDay'>,
  venue: Venue,
  tradingDate: string,
): DayRate {
  if (quoteCurrencyOf(venue) === 'GBP') return { ok: true, quotePerGbp: 1, source: 'gbp' };
  if (market.gbpUsdOnDay === undefined) {
    return { ok: false, reason: 'no day GBP/USD rate source' };
  }
  try {
    const fix = market.gbpUsdOnDay(tradingDate);
    return { ok: true, quotePerGbp: fix.gbpUsd, source: `boe-xudluss:${fix.fixDate}` };
  } catch (error) {
    return { ok: false, reason: describeThrownSafely(error) };
  }
}

export interface CashCheck {
  readonly diffs: readonly ReconcileDiff[];
  readonly note: string;
}

function cashDiff(
  kind: 'cash' | 'cash_unverified',
  store: number | null,
  broker: number,
): ReconcileDiff {
  return { kind, instrument: null, order_id: null, store, broker };
}

function unverified(brokerCashQuote: number, reason: string): CashCheck {
  return { diffs: [cashDiff('cash_unverified', null, brokerCashQuote)], note: reason };
}

export interface AnchorCompare {
  readonly brokerCashQuote: number;
  readonly anchor: CashAnchor;
  readonly storeFlow: StoreFlow;
  readonly rate: DayRate;
  readonly toleranceGbp: number;
}

const money = (amount: number): string => amount.toFixed(2);

// David 2026-10-02 (#1927 item 5): broker cash minus the anchor must equal the store's change since
// it; the gap is taken in the venue's currency and only then converted, so FX never enters it
export function anchorCashCheck(compare: AnchorCompare): CashCheck {
  const { anchor, storeFlow, rate } = compare;
  if (!storeFlow.ok) return unverified(compare.brokerCashQuote, storeFlow.reason);
  if (!rate.ok) return unverified(compare.brokerCashQuote, rate.reason);
  const brokerChange = compare.brokerCashQuote - anchor.cashQuote;
  const gapGbp = (brokerChange - storeFlow.quote) / rate.quotePerGbp;
  const note = `cash since anchor ${anchor.currency}: broker ${money(brokerChange)} store ${money(storeFlow.quote)}, gap GBP ${money(gapGbp)} at ${rate.quotePerGbp} (${rate.source})`;
  if (Math.abs(gapGbp) <= compare.toleranceGbp) return { diffs: [], note };
  return { diffs: [cashDiff('cash', storeFlow.quote, brokerChange)], note };
}

export interface LiveCashDeps {
  readonly brokerMode: BrokerMode;
  readonly cashAnchors?: CashAnchorLedger | undefined;
  readonly market: Pick<MarketData, 'gbpUsdOnDay'>;
  readonly reconcileCashToleranceGbp: number | undefined;
}

export interface BrokerCash {
  readonly venue: Venue;
  readonly cashQuote: number;
  readonly booksMatch: boolean;
}

// An anchor taken while positions or orders disagree would hold a fill the store has not booked,
// and every later run would carry that gap
function firstAnchor(
  ledger: CashAnchorLedger,
  brokerMode: BrokerMode,
  broker: BrokerCash,
  tradingDate: string,
): CashCheck {
  if (!broker.booksMatch) {
    return unverified(
      broker.cashQuote,
      'no cash anchor yet: it is recorded at the first live reconcile whose positions and orders match',
    );
  }
  const anchor = ledger.recordAnchor(broker.venue, brokerMode, broker.cashQuote, tradingDate);
  return {
    diffs: [],
    note: `cash anchor recorded: ${money(anchor.cashQuote)} ${anchor.currency} (#1927)`,
  };
}

export function liveCashCheck(
  deps: LiveCashDeps,
  broker: BrokerCash,
  tradingDate: string,
): CashCheck {
  const ledger = deps.cashAnchors;
  const toleranceGbp = deps.reconcileCashToleranceGbp;
  if (toleranceGbp === undefined) {
    return unverified(broker.cashQuote, 'RECONCILE_CASH_TOLERANCE_GBP is not set');
  }
  if (ledger === undefined) return unverified(broker.cashQuote, 'no cash anchor ledger');
  const anchor = ledger.anchor(broker.venue);
  if (anchor === undefined) return firstAnchor(ledger, deps.brokerMode, broker, tradingDate);
  if (anchor.brokerMode !== deps.brokerMode) {
    return unverified(
      broker.cashQuote,
      `the ${broker.venue} cash anchor is the ${anchor.brokerMode} account's, not ${deps.brokerMode}'s`,
    );
  }
  return anchorCashCheck({
    brokerCashQuote: broker.cashQuote,
    anchor,
    storeFlow: ledger.storeFlowSince(anchor, broker.venue),
    rate: dayRateFor(deps.market, broker.venue, tradingDate),
    toleranceGbp,
  });
}
