import type { BookCorrelationWire, CrossSleeveExposureWire, PanelWire } from '@contracts';
import { fixed, gbp } from '../../lib/format.ts';
import { Panel, TableHead } from '../Panel.tsx';

function Books({ report }: { report: CrossSleeveExposureWire }) {
  return (
    <table className="grid">
      <caption>Exposure by book, {report.trading_date}</caption>
      <TableHead columns={['Book', 'Long', 'Short', 'Gross', 'Net']} />
      <tbody>
        {report.books.map((book) => (
          <tr key={book.book_id}>
            <th scope="row">{book.book_id}</th>
            <td>{gbp(book.long_gbp)}</td>
            <td>{gbp(book.short_gbp)}</td>
            <td>{gbp(book.gross_gbp)}</td>
            <td>{gbp(book.net_gbp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Overlaps({ report }: { report: CrossSleeveExposureWire }) {
  if (report.overlaps.length === 0) return <p>No instrument held by more than one sleeve.</p>;
  return (
    <table className="grid">
      <caption>Instruments held by more than one sleeve</caption>
      <TableHead columns={['Instrument', 'Sleeves', 'Direction', 'Holders']} />
      <tbody>
        {report.overlaps.map((overlap) => (
          <tr key={overlap.instrument}>
            <th scope="row">{overlap.instrument}</th>
            <td>{overlap.sleeves.join(', ')}</td>
            <td>{overlap.opposed ? 'opposed' : 'same'}</td>
            <td>
              {overlap.holders
                .map((holder) => `${holder.book_id} ${gbp(holder.signed_gbp)}`)
                .join('; ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function correlationText(pair: BookCorrelationWire, report: CrossSleeveExposureWire): string {
  if (pair.gap === 'warm_up') return `warming up ${pair.observations}/${report.min_observations}`;
  if (pair.gap === 'zero_variance') return 'a book did not move';
  return fixed(pair.correlation);
}

function Correlations({ report }: { report: CrossSleeveExposureWire }) {
  return (
    <table className="grid">
      <caption>
        Daily return correlation, last {report.window_returns} returns, warn at{' '}
        {fixed(report.correlation_warn)} across sleeves
      </caption>
      <TableHead columns={['Books', 'Across sleeves', 'Correlation']} />
      <tbody>
        {report.correlations.map((pair) => (
          <tr key={`${pair.book_a}|${pair.book_b}`}>
            <th scope="row">
              {pair.book_a} / {pair.book_b}
            </th>
            <td>{pair.cross_sleeve ? 'yes' : 'no'}</td>
            <td>{correlationText(pair, report)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ExposurePanel({ panel }: { panel: PanelWire<CrossSleeveExposureWire> }) {
  return (
    <Panel title="Cross-sleeve exposure" panel={panel} empty="No exposure report yet." wide>
      {(report) => (
        <>
          {report.warnings.length > 0 && <p>Warnings: {report.warnings.join(', ')}</p>}
          <Books report={report} />
          <Overlaps report={report} />
          <Correlations report={report} />
        </>
      )}
    </Panel>
  );
}
