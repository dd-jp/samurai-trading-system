import type { DecisionsWire, DecisionWire, PanelWire } from '@contracts';
import { percent } from '../../lib/format.ts';
import { outcomeOf } from '../../lib/journal.ts';
import { Panel, TableHead } from '../Panel.tsx';

interface SelectionProps {
  readonly selected?: DecisionWire | null;
  readonly onSelect?: (decision: DecisionWire) => void;
}

function Instrument({ decision, selected, onSelect }: SelectionProps & { decision: DecisionWire }) {
  if (onSelect === undefined) return <>{decision.instrument}</>;
  const pressed =
    selected?.book_id === decision.book_id && selected.instrument === decision.instrument;
  return (
    <button
      type="button"
      className="pick"
      aria-pressed={pressed}
      onClick={() => onSelect(decision)}
    >
      {decision.instrument}
    </button>
  );
}

function Decisions({
  decisions,
  selected,
  onSelect,
}: SelectionProps & { decisions: DecisionsWire }) {
  return (
    <table className="grid">
      <caption>Cycle {decisions.trading_date}, primary books</caption>
      <TableHead columns={['Instrument', 'Book', 'Outcome', 'Confidence', 'Reason']} />
      <tbody>
        {decisions.decisions.map((decision) => (
          <tr key={`${decision.book_id}/${decision.instrument}`} data-outcome={outcomeOf(decision)}>
            <th scope="row">
              <Instrument decision={decision} selected={selected} onSelect={onSelect} />{' '}
              <small>{decision.direction}</small>
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

export function DecisionsPanel({
  panel,
  selected,
  onSelect,
}: SelectionProps & { panel: PanelWire<DecisionsWire> }) {
  return (
    <Panel title="Today's decisions" panel={panel} empty="No decisions recorded yet.">
      {(decisions) => <Decisions decisions={decisions} selected={selected} onSelect={onSelect} />}
    </Panel>
  );
}
