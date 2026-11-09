import type { DecisionsWire, DecisionWire, PanelWire, SleeveAction } from '@contracts';
import { percent } from '../../lib/format.ts';
import { outcomeOf } from '../../lib/journal.ts';
import { Panel } from '../Panel.tsx';

const SEALS: Readonly<Record<SleeveAction, readonly [string, string]>> = {
  enter_long: ['可', 'go'],
  enter_short: ['可', 'go'],
  exit: ['止', 'stop'],
  skip: ['略', 'skip'],
  none: ['略', 'skip'],
};

function Seal({ decision }: { decision: DecisionWire }) {
  const [kanji, kind] = decision.vetoed ? ['否', 'nogo'] : SEALS[decision.action];
  return (
    <span className="seal" data-seal={kind} lang="ja" aria-hidden="true">
      {kanji}
    </span>
  );
}

function Verdicts({ decisions }: { decisions: DecisionsWire }) {
  return (
    <>
      <p className="panel-note">Cycle {decisions.trading_date}, primary books</p>
      <ul className="verdicts">
        {decisions.decisions.map((decision) => (
          <li key={`${decision.book_id}/${decision.instrument}`} data-outcome={outcomeOf(decision)}>
            <Seal decision={decision} />
            <strong className="verdict-name">{decision.instrument}</strong>
            <span>{percent(decision.confidence, 0)}</span>
            <span>
              {outcomeOf(decision)}: {decision.reason} <small>{decision.book_id}</small>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function VerdictsPanel({ panel }: { panel: PanelWire<DecisionsWire> }) {
  return (
    <Panel title="Verdicts" panel={panel} empty="No decisions recorded yet." wide>
      {(decisions) => <Verdicts decisions={decisions} />}
    </Panel>
  );
}
