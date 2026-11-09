import type { ClosedTradeLedgerWire, PanelWire } from '@contracts';
import { fixed, gbp, percent } from '../../lib/format.ts';
import { Panel, TableHead } from '../Panel.tsx';

function Stats({ ledger }: { ledger: ClosedTradeLedgerWire }) {
  return (
    <table className="grid">
      <caption>Primary books, all settled trades</caption>
      <TableHead columns={['Book', 'Trades', 'Win rate', 'Expectancy', 'Profit factor', 'Net']} />
      <tbody>
        {ledger.stats.map((book) => (
          <tr key={book.book_id}>
            <th scope="row">{book.book_id}</th>
            <td>{book.trades}</td>
            <td>{percent(book.win_rate, 0)}</td>
            <td>{gbp(book.expectancy_gbp)}</td>
            <td>{book.profit_factor === null ? 'no losses' : fixed(book.profit_factor)}</td>
            <td>{gbp(book.net_gbp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Trades({ ledger }: { ledger: ClosedTradeLedgerWire }) {
  return (
    <table className="grid">
      <caption>Newest {ledger.newest.length} trades</caption>
      <TableHead
        columns={['Instrument', 'Book', 'Held', 'Exit', 'P&L', 'Return', 'R', 'vs benchmark']}
      />
      <tbody>
        {ledger.newest.map((trade) => (
          <tr key={trade.decision_id}>
            <th scope="row">
              {trade.instrument} <small>{trade.direction}</small>
            </th>
            <td>{trade.book_id}</td>
            <td>
              {trade.entry_date} to {trade.exit_date}, {trade.holding_days} d
            </td>
            <td>{trade.exit_reason}</td>
            <td>{gbp(trade.realised_pnl_gbp)}</td>
            <td>{percent(trade.trade_return)}</td>
            <td>{fixed(trade.r_multiple)}</td>
            <td>
              {percent(trade.excess_return)} <small>{trade.benchmark_symbol}</small>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ClosedTradesPanel({ panel }: { panel: PanelWire<ClosedTradeLedgerWire> }) {
  return (
    <Panel title="Closed trades" panel={panel} empty="No closed trades settled yet." wide>
      {(ledger) => (
        <>
          <Stats ledger={ledger} />
          <Trades ledger={ledger} />
        </>
      )}
    </Panel>
  );
}
