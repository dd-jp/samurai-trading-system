/**
 * Closed trades (#940). Before this panel, `PositionsPanel` — this dashboard's
 * only view of a position — showed OPEN lots only: a trade that entered,
 * filled and flattened left no trace anywhere on the page. `closed_trades`
 * carries the round trip; this renders it, paired with the venue fills that
 * closed it.
 *
 * `exit_price` on the wire is a derived figure, not a stored column — see
 * `server/apps/service-api/snapshot.ts`'s `exitPriceFor`. It is rendered here
 * exactly like every other price; the derivation is a server-side concern,
 * not something this panel needs to distinguish, because either path lands on
 * the same honest number.
 */

import type { ClosedTradeRow, FillRow } from '@contracts';
import { formatClockUtc, formatFixed, formatPrice, formatSignedUsd } from '../../lib/format.ts';
import { CLOSE_REASON_WORD, sideWord } from '../../lib/vocabulary.ts';

export interface ClosedTradesPanelProps {
  trades: readonly ClosedTradeRow[];
  /** Every fill belonging to `trades` — matched to a card by `idempotency_key`. */
  fills: readonly FillRow[];
}

function FillsList({ tradeFills }: { tradeFills: readonly FillRow[] }) {
  if (tradeFills.length === 0) return null;
  return (
    <ul className="trade-fills">
      {tradeFills.map((fill) => (
        <li key={fill.broker_fill_id} className="trade-fill-row">
          <span className="trade-fill-leg">{fill.leg}</span>
          <span>{formatPrice(fill.price)}</span>
          <span>×{formatFixed(fill.qty, 4)}</span>
          <span>fee {formatPrice(fill.fee)}</span>
          <span>{formatClockUtc(fill.timestamp)}</span>
          <span className="trade-fill-id">{fill.broker_fill_id}</span>
        </li>
      ))}
    </ul>
  );
}

export function ClosedTradesPanel({ trades, fills }: ClosedTradesPanelProps) {
  return (
    <section className="panel panel-closed-trades" aria-label="Closed trades">
      <div className="panel-head">
        <h2>Closed trades</h2>
        <span className="panel-sub">realized round trips · fills traced per trade</span>
      </div>
      {trades.length === 0 ? (
        <p className="empty-state">
          No closed trade in the recent-history window. A round trip appears here once it
          flattens — this is a reading, not a missing panel.
        </p>
      ) : (
        <ul className="position-list">
          {trades.map((trade) => {
            const profitable = trade.realized_pnl_net >= 0;
            const tradeFills = fills.filter(
              (fill) => fill.idempotency_key === trade.idempotency_key,
            );
            return (
              <li key={trade.idempotency_key} className="trade-card">
                <div className="trade-top">
                  <span className="trade-symbol">{trade.instrument}</span>
                  <span className={`side side-${trade.side}`}>{sideWord(trade.side)}</span>
                  <span className="trade-size numeric">
                    ×{formatFixed(trade.filled_size, 4)} · {trade.asset_class}
                  </span>
                  <span className="close-reason">{CLOSE_REASON_WORD[trade.close_reason]}</span>
                  <span className={profitable ? 'trade-pnl gain' : 'trade-pnl loss'}>
                    {formatSignedUsd(trade.realized_pnl_net)}
                  </span>
                </div>
                <div className="trade-meta">
                  <span>entry {formatPrice(trade.entry_price)}</span>
                  <span>exit {formatPrice(trade.exit_price)}</span>
                  <span>fees {formatPrice(trade.fees_total)}</span>
                  <span>opened {formatClockUtc(trade.opened_at)}</span>
                  <span>closed {formatClockUtc(trade.closed_at)}</span>
                </div>
                <FillsList tradeFills={tradeFills} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
