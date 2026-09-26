import type { MarkWire, PanelWire, PositionsWire, PositionWire } from '@contracts';
import { fixed, gbp, quote, UNKNOWN } from '../../lib/format.ts';
import { Panel, TableHead } from '../Panel.tsx';

function markCells(mark: MarkWire, currency: PositionWire['currency']) {
  if (mark.status === 'fresh') {
    return (
      <>
        <td>
          {quote(mark.price_quote, currency)} <small>({mark.bar_date})</small>
        </td>
        <td>{gbp(mark.unrealised_gbp)}</td>
      </>
    );
  }
  const note =
    mark.status === 'stale' ? `stale (last bar ${mark.bar_date ?? 'none'})` : 'unavailable';
  return (
    <>
      <td className="warn">{note}</td>
      <td>{UNKNOWN}</td>
    </>
  );
}

function PositionRows({ positions }: { positions: readonly PositionWire[] }) {
  if (positions.length === 0) return <p className="panel-note">No open positions.</p>;
  return (
    <table className="grid">
      <TableHead
        columns={['Instrument', 'Book', 'Qty', 'Entry', 'Stop', 'Held', 'Mark', 'Unrealised']}
      />
      <tbody>
        {positions.map((position) => (
          <tr
            key={`${position.book_id}/${position.instrument}`}
            className={position.variant === 'primary' ? 'primary' : 'shadow'}
          >
            <th scope="row">
              {position.instrument} <small>{position.venue}</small>
            </th>
            <td>
              {position.variant === 'primary' ? position.book_id : `${position.variant} (shadow)`}
            </td>
            <td>{position.qty}</td>
            <td>{gbp(position.entry_gbp)}</td>
            <td>{position.stop_gbp === null ? 'none' : gbp(position.stop_gbp)}</td>
            <td>
              since {position.opened_date}, {position.marks_held} marks
            </td>
            {markCells(position.mark, position.currency)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Positions({ positions }: { positions: PositionsWire }) {
  return (
    <>
      <PositionRows positions={positions.positions} />
      <table className="grid">
        <caption>Primary books, by venue</caption>
        <tbody>
          {positions.venues.map((venue) => (
            <tr key={venue.venue}>
              <th scope="row">{venue.venue}</th>
              <td>
                {venue.positions_value_quote === null
                  ? UNKNOWN
                  : quote(venue.positions_value_quote, venue.currency)}
              </td>
              <td>{gbp(venue.positions_value_gbp)}</td>
            </tr>
          ))}
          {positions.cash.map((cash) => (
            <tr key={cash.book_id}>
              <th scope="row">
                Cash, {cash.variant === 'primary' ? cash.book_id : `${cash.variant} (shadow)`}
              </th>
              <td />
              <td>{gbp(cash.cash_gbp)}</td>
            </tr>
          ))}
          <tr className="total">
            <th scope="row">Total</th>
            <td />
            <td>
              {positions.total_gbp === null
                ? 'unavailable (a mark is missing)'
                : gbp(positions.total_gbp)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="panel-note">
        As of {positions.as_of}.{' '}
        {positions.fx === null
          ? 'No GBP/USD rate: USD figures are not converted.'
          : `USD at ${fixed(positions.fx.gbp_usd, 4)} per £ (${positions.fx.year}, ${positions.fx.source}).`}
      </p>
    </>
  );
}

export function PositionsPanel({ panel }: { panel: PanelWire<PositionsWire> }) {
  return (
    <Panel title="Positions and cash" panel={panel} empty="No books yet.">
      {(positions) => <Positions positions={positions} />}
    </Panel>
  );
}
