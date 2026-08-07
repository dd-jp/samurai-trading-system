/**
 * Open positions (dashboard-spec.md stories 1, 2, 2a). One row per position
 * with the stop / entry / mark / target **price rail**, so "how close is this
 * to its stop" is a spatial fact rather than four numbers to compare in your
 * head.
 *
 * The PnL sign is carried by an explicit `+`/`−` from `formatSignedUsd` as
 * well as by colour, and the rail degrades rather than lying: if the four
 * prices do not span a finite range — a non-finite value on the wire, or all
 * four equal — the rail is replaced by a named state and the numbers below it
 * still render. A rail computed from `NaN` would emit `NaN%` into a style
 * attribute and silently collapse every marker onto the left edge, which reads
 * as "everything is at its stop".
 */

import type { PositionRow } from '../../../../dashboard/types.ts';
import { formatClockUtc, formatFixed, formatPrice, formatSignedUsd } from '../../lib/format.ts';
import { sideWord } from '../../lib/vocabulary.ts';

export interface PositionsPanelProps {
  positions: readonly PositionRow[];
}

interface RailGeometry {
  /** Left offset as a CSS percentage, per price. */
  stop: string;
  entry: string;
  mark: string;
  target: string;
}

/** `null` when the four prices cannot be laid out on a finite, non-degenerate axis. */
function railGeometry(position: PositionRow): RailGeometry | null {
  const prices = [position.stop, position.avg_entry_price, position.mark_price, position.target];
  if (!prices.every((price) => Number.isFinite(price))) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (high === low) return null;
  // 3%…97% rather than 0%…100%: a marker at either extreme would be half
  // outside the rail.
  const at = (price: number) => `${(((price - low) / (high - low)) * 94 + 3).toFixed(1)}%`;
  return {
    stop: at(position.stop),
    entry: at(position.avg_entry_price),
    mark: at(position.mark_price),
    target: at(position.target),
  };
}

function PriceRail({ position }: { position: PositionRow }) {
  const geometry = railGeometry(position);
  if (geometry === null) {
    return (
      <p className="empty-state">
        Price rail not drawable — stop, entry, mark and target do not span a finite range on this
        snapshot. The prices themselves are listed below.
      </p>
    );
  }
  const label = `stop ${formatPrice(position.stop)}, entry ${formatPrice(
    position.avg_entry_price,
  )}, mark ${formatPrice(position.mark_price)}, target ${formatPrice(position.target)}`;
  return (
    <div className="rail-wrap" role="img" aria-label={label}>
      <div className="rail" />
      <span className="rail-tick rail-stop" style={{ left: geometry.stop }}>
        <span className="rail-label">stop {formatPrice(position.stop)}</span>
      </span>
      <span className="rail-tick rail-entry" style={{ left: geometry.entry }}>
        <span className="rail-label">entry</span>
      </span>
      <span className="rail-tick rail-mark" style={{ left: geometry.mark }}>
        <span className="rail-label">mark {formatPrice(position.mark_price)}</span>
      </span>
      <span className="rail-tick rail-target" style={{ left: geometry.target }}>
        <span className="rail-label">target {formatPrice(position.target)}</span>
      </span>
    </div>
  );
}

export function PositionsPanel({ positions }: PositionsPanelProps) {
  return (
    <section className="panel panel-positions" aria-label="Open positions">
      <div className="panel-head">
        <h2>Open positions</h2>
        <span className="panel-sub">marks live · unrealized PnL from the current mark</span>
      </div>
      {positions.length === 0 ? (
        <p className="empty-state">
          No open position — the store reports nothing held. This is a reading, not a missing panel.
        </p>
      ) : (
        <ul className="position-list">
          {positions.map((position) => {
            const profitable = position.unrealized_pnl >= 0;
            return (
              <li key={position.idempotency_key} className="position-card">
                <div className="position-top">
                  <span className="position-symbol">{position.instrument}</span>
                  <span className={`side side-${position.side}`}>{sideWord(position.side)}</span>
                  <span className="position-size numeric">
                    ×{formatFixed(position.filled_size, 4)} filled · {position.asset_class}
                  </span>
                  <span className={profitable ? 'position-pnl gain' : 'position-pnl loss'}>
                    {formatSignedUsd(position.unrealized_pnl)}
                  </span>
                </div>
                <PriceRail position={position} />
                <div className="position-meta">
                  <span>avg entry {formatPrice(position.avg_entry_price)}</span>
                  <span>stop {formatPrice(position.stop)}</span>
                  <span>target {formatPrice(position.target)}</span>
                  <span>mark {formatPrice(position.mark_price)}</span>
                  <span>state: {position.order_state}</span>
                  <span>opened {formatClockUtc(position.opened_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
