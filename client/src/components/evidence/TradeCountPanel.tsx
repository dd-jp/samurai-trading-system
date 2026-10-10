import type {
  EntryOffsetTradesWire,
  EvidenceWire,
  ModelPinsTradesWire,
  TradeCountWire,
} from '@contracts';
import { bookLabel } from '../../lib/books.ts';
import { NotYetFed, Panel, TableHead } from '../Panel.tsx';

function offsetSplit(rows: readonly EntryOffsetTradesWire[]): string {
  return rows
    .map(
      (row) =>
        `${row.entry_offset_bps === null ? 'no offset' : `${row.entry_offset_bps} bps`}: ${row.closed_trades}`,
    )
    .join(', ');
}

function pinSplit(rows: readonly ModelPinsTradesWire[]): string {
  return rows.map((row) => `${row.pin_digest ?? 'no digest'}: ${row.closed_trades}`).join(', ');
}

function Counts({ count }: { count: TradeCountWire }) {
  return (
    <table className="grid">
      <caption>Closed paper trades toward {count.target}</caption>
      <TableHead
        columns={['Book', 'Closed trades', 'Progress', 'By entry offset', 'By model pins']}
      />
      <tbody>
        {count.books.map((book) => (
          <tr key={book.book_id}>
            <th scope="row">{bookLabel(book)}</th>
            <td>
              {book.closed_trades} of {count.target}
            </td>
            <td>
              <progress
                max={count.target}
                value={Math.min(book.closed_trades, count.target)}
                aria-label={`${book.book_id}: ${book.closed_trades} of ${count.target} closed trades`}
              />
            </td>
            <td>{offsetSplit(book.by_entry_offset)}</td>
            <td>{pinSplit(book.by_model_pins)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TradeCountPanel({ evidence }: { evidence: EvidenceWire }) {
  return (
    <Panel
      title="Debate G1 progress"
      panel={evidence.trade_count}
      empty="No closed paper trades yet."
      after={<NotYetFed label="One-sided 95% test vs arm 2" panel={evidence.arm2_test} />}
    >
      {(count) => <Counts count={count} />}
    </Panel>
  );
}
