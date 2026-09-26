import type { ResearchLedgerWire, ResearchWire } from '@contracts';
import type { ReactNode } from 'react';
import { utcMinute } from '../../lib/format.ts';
import { NotYetFed, Panel, TableHead } from '../Panel.tsx';

function Ledger({ ledger }: { ledger: ResearchLedgerWire }) {
  return (
    <>
      <p className="panel-lead">
        {ledger.total_trials} {ledger.total_trials === 1 ? 'trial' : 'trials'} in total (the DSR
        deflator)
      </p>
      <table className="grid">
        <caption>Trials per candidate</caption>
        <TableHead columns={['Candidate', 'Trials']} />
        <tbody>
          {ledger.by_candidate.map((candidate) => (
            <tr key={candidate.candidate}>
              <th scope="row">{candidate.candidate}</th>
              <td>{candidate.trials}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="grid">
        <caption>Ledger</caption>
        <TableHead columns={['Trial', 'Candidate', 'Config hash', 'Source', 'Recorded']} />
        <tbody>
          {ledger.trials.map((trial) => (
            <tr key={trial.trial}>
              <th scope="row">{trial.trial}</th>
              <td>{trial.candidate}</td>
              <td>
                <code>{trial.config_hash}</code>
              </td>
              <td>{trial.source}</td>
              <td>{utcMinute(trial.recorded_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function ResearchPanel({ research, note }: { research: ResearchWire; note?: ReactNode }) {
  return (
    <Panel
      title="Research loop"
      panel={research.ledger}
      empty="No trials recorded yet."
      after={
        <>
          <NotYetFed label="Proposals" panel={research.proposals} />
          <NotYetFed label="Promotions" panel={research.promotions} />
          <NotYetFed label="Demotions" panel={research.demotions} />
          {note}
        </>
      }
    >
      {(ledger) => <Ledger ledger={ledger} />}
    </Panel>
  );
}
