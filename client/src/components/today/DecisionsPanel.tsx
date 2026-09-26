import type { DecisionsWire, DecisionWire, PanelWire, SleeveAction } from '@contracts';
import { percent } from '../../lib/format.ts';
import { Panel } from '../Panel.tsx';

const OUTCOMES: Readonly<Record<SleeveAction, string>> = {
  enter_long: 'entered long',
  enter_short: 'entered short',
  skip: 'skipped',
  none: 'none',
};

function outcome(decision: DecisionWire): string {
  return decision.vetoed ? 'vetoed' : OUTCOMES[decision.action];
}

function Decisions({ decisions }: { decisions: DecisionsWire }) {
  return (
    <table className="grid">
      <caption>Cycle {decisions.trading_date}, primary books</caption>
      <thead>
        <tr>
          <th scope="col">Instrument</th>
          <th scope="col">Book</th>
          <th scope="col">Outcome</th>
          <th scope="col">Confidence</th>
          <th scope="col">Reason</th>
        </tr>
      </thead>
      <tbody>
        {decisions.decisions.map((decision) => (
          <tr key={`${decision.book_id}/${decision.instrument}`} data-outcome={outcome(decision)}>
            <th scope="row">
              {decision.instrument} <small>{decision.direction}</small>
            </th>
            <td>{decision.book_id}</td>
            <td>{outcome(decision)}</td>
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
