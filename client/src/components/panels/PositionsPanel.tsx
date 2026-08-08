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
 *
 * **Label collisions are prevented geometrically, not measured away** (#540).
 * The three below-rail labels sit on their own row each, assigned in
 * left-to-right order, so two of them cannot overlap however tightly the
 * prices cluster — a tight stop is exactly when the rail matters most and
 * exactly when centred labels at `translateX(-50%)` printed over each other.
 * The row count is fixed rather than derived from how far apart this
 * snapshot's prices happen to be, because a poll must never change the page's
 * geometry (spec, "WorldMonitor Deferred-Shell Contract"). Labels within a
 * label-width of either end anchor to their marker instead of centring on it,
 * so the outermost price cannot overflow the card.
 */

import type { PositionRow } from '@contracts';
import type { CSSProperties } from 'react';
import { formatClockUtc, formatFixed, formatPrice, formatSignedUsd } from '../../lib/format.ts';
import { sideWord } from '../../lib/vocabulary.ts';

export interface PositionsPanelProps {
  positions: readonly PositionRow[];
}

/**
 * Percent of the rail's width within which a label anchors to its marker
 * rather than centring on it. Roughly half a "target 3,640.00" at the panel's
 * narrowest — an estimate on purpose: the alternative is measuring text in the
 * DOM, and the fallback if it is a little wide is a label that hugs its marker
 * instead of straddling it, which is legible either way.
 */
const EDGE_ANCHOR_PCT = 12;

/** One marker on the rail: where it sits, and how its label is placed. */
interface RailMarker {
  key: 'stop' | 'entry' | 'mark' | 'target';
  /** Left offset as a CSS percentage. */
  left: string;
  /** The label's text — the word plus the price it marks. */
  label: string;
  /**
   * Which label row this marker's label occupies, counted away from the rail.
   * `mark` is the sole occupant of its own row above; stop, entry and target
   * take one row each below, in left-to-right order.
   */
  row: number;
  /** `start` and `end` keep an outermost label inside the card. */
  anchor: 'start' | 'middle' | 'end';
}

/** `null` when the four prices cannot be laid out on a finite, non-degenerate axis. */
function railMarkers(position: PositionRow): readonly RailMarker[] | null {
  const prices = [position.stop, position.avg_entry_price, position.mark_price, position.target];
  if (!prices.every((price) => Number.isFinite(price))) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (high === low) return null;
  // 3%…97% rather than 0%…100%: a marker at either extreme would be half
  // outside the rail.
  const at = (price: number) => ((price - low) / (high - low)) * 94 + 3;
  const anchorFor = (pct: number): RailMarker['anchor'] =>
    pct < EDGE_ANCHOR_PCT ? 'start' : pct > 100 - EDGE_ANCHOR_PCT ? 'end' : 'middle';

  const below: { key: RailMarker['key']; pct: number; label: string }[] = [
    { key: 'stop', pct: at(position.stop), label: `stop ${formatPrice(position.stop)}` },
    {
      key: 'entry',
      pct: at(position.avg_entry_price),
      label: `entry ${formatPrice(position.avg_entry_price)}`,
    },
    { key: 'target', pct: at(position.target), label: `target ${formatPrice(position.target)}` },
  ];
  // One row each, in left-to-right order. Sorting by position rather than by
  // name is what makes the staircase read as a rail: the labels descend in the
  // same direction the prices ascend, and no two ever share a row to collide on.
  const ordered = [...below].sort((a, b) => a.pct - b.pct);

  const markPct = at(position.mark_price);
  return [
    ...ordered.map((marker, row) => ({
      key: marker.key,
      left: `${marker.pct.toFixed(1)}%`,
      label: marker.label,
      row,
      anchor: anchorFor(marker.pct),
    })),
    {
      key: 'mark' as const,
      left: `${markPct.toFixed(1)}%`,
      label: `mark ${formatPrice(position.mark_price)}`,
      // Above the rail, alone, so the live price never queues behind the three
      // static ones.
      row: 0,
      anchor: anchorFor(markPct),
    },
  ];
}

function PriceRail({ position }: { position: PositionRow }) {
  const markers = railMarkers(position);
  if (markers === null) {
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
      {markers.map((marker) => (
        <span
          key={marker.key}
          className={`rail-tick rail-${marker.key}`}
          style={{ left: marker.left, '--rail-row': marker.row } as CSSProperties}
        >
          <span className={`rail-label rail-label-${marker.anchor}`}>{marker.label}</span>
        </span>
      ))}
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
