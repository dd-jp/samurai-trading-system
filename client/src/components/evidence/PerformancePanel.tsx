import type { BookPerformanceWire, EvidenceWire } from '@contracts';
import type { ReactNode } from 'react';
import { bookLabel } from '../../lib/books.ts';
import { fixed, gbp, percent, UNKNOWN } from '../../lib/format.ts';
import { NotYetFed, Panel, TableHead } from '../Panel.tsx';

function EquityCurve({ book }: { book: BookPerformanceWire }) {
  const first = book.equity[0];
  const last = book.equity.at(-1);
  if (first === undefined || last === undefined || book.equity.length < 2) return <>{UNKNOWN}</>;
  const values = book.equity.map((point) => point.equity_gbp);
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = span === 0 ? 10 : 18 - ((value - low) / span) * 16;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg
      className="curve"
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${book.book_id} equity, ${gbp(first.equity_gbp)} on ${first.trading_date} to ${gbp(last.equity_gbp)} on ${last.trading_date}`}
    >
      <polyline points={points} />
    </svg>
  );
}

function bySleevePrimaryFirst(books: readonly BookPerformanceWire[]): BookPerformanceWire[] {
  return [...books].sort(
    (a, b) =>
      a.sleeve_id.localeCompare(b.sleeve_id) ||
      Number(b.variant === 'primary') - Number(a.variant === 'primary') ||
      a.variant.localeCompare(b.variant),
  );
}

function Books({ books }: { books: readonly BookPerformanceWire[] }) {
  return (
    <table className="grid">
      <caption>
        Annualised Sharpe and max drawdown of daily equity returns, each book over its own cycle
        days
      </caption>
      <TableHead columns={['Book', 'Days', 'Sharpe', 'Max drawdown', 'Equity']} />
      <tbody>
        {bySleevePrimaryFirst(books).map((book) => (
          <tr key={book.book_id}>
            <th scope="row">{bookLabel(book)}</th>
            <td>{book.days}</td>
            <td>{fixed(book.sharpe)}</td>
            <td>{percent(-book.max_drawdown)}</td>
            <td>
              <EquityCurve book={book} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PerformancePanel({ evidence, note }: { evidence: EvidenceWire; note?: ReactNode }) {
  return (
    <Panel
      title="Sleeve vs benchmark"
      panel={evidence.performance}
      empty="No recorded cycle days yet."
      after={
        <>
          <NotYetFed label="vs arm 2" panel={evidence.vs_arm2} />
          <NotYetFed label="vs risk-matched buy-and-hold" panel={evidence.vs_benchmark} />
          {note}
        </>
      }
    >
      {(performance) => <Books books={performance.books} />}
    </Panel>
  );
}
