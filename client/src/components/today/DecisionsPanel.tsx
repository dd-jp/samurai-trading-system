import type { DecisionsWire, PanelWire } from '@contracts';
import { percent } from '../../lib/format.ts';
import { outcomeOf } from '../../lib/journal.ts';
import { Panel, TableHead } from '../Panel.tsx';

function Decisions({ decisions }: { decisions: DecisionsWire }) {
  return (
    <table className="grid">
      <caption>Cycle {decisions.trading_date}, primary books</caption>
      <TableHead columns={['Instrument', 'Book', 'Outcome', 'Confidence', 'Reason']} />
      <tbody>
        {decisions.decisions.map((decision) => (
          <tr key={`${decision.book_id}/${decision.instrument}`} data-outcome={outcomeOf(decision)}>
            <th scope="row">
              {decision.instrument} <small>{decision.direction}</small>
            </th>
            <td>{decision.book_id}</td>
            <td>{outcomeOf(decision)}</td>
            <td>{percent(decision.confidence, 0)}</td>
            <td>{decision.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DecisionsPanel({ panel }: { panel: PanelWire<DecisionsWire> }) {
  return (
    <Panel title="Today's decisions" panel={panel} empty="No decisions recorded yet.">
      {(decisions) => <Decisions decisions={decisions} />}
    </Panel>
  );
}
