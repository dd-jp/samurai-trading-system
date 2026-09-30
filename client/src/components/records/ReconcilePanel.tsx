import type { PanelWire, ReconcileDiffWire, ReconcileRunsWire, ReconcileRunWire } from '@contracts';
import type { ReactNode } from 'react';
import { Panel, TableHead } from '../Panel.tsx';

const BLOCKS_ENTRIES = 'entries blocked';

function side(value: number | null): string {
  return value === null ? '-' : String(value);
}

function describeDiff(diff: ReconcileDiffWire): string {
  const subject = [diff.instrument ?? 'cash', diff.order_id].filter(Boolean).join(' ');
  return `${diff.kind} ${subject}: store ${side(diff.store)}, broker ${side(diff.broker)}`;
}

function Outcome({ run }: { run: ReconcileRunWire }) {
  if (run.status === 'clean') return <>clean</>;
  return (
    <>
      {run.status}, {BLOCKS_ENTRIES}
      {run.diffs.length > 0 ? (
        <ul>
          {run.diffs.map((diff) => (
            <li key={describeDiff(diff)}>{describeDiff(diff)}</li>
          ))}
        </ul>
      ) : (
        <div>{run.detail}</div>
      )}
    </>
  );
}

function Runs({ runs }: { runs: readonly ReconcileRunWire[] }) {
  return (
    <table className="grid">
      <caption>Newest first</caption>
      <TableHead columns={['Day', 'Venue', 'Books', 'Outcome']} />
      <tbody>
        {runs.map((run) => (
          <tr key={`${run.recorded_at}-${run.venue}-${run.source}`}>
            <th scope="row">{run.trading_date}</th>
            <td>
              {run.venue} {run.source}
            </td>
            <td>{run.book_ids.join(', ')}</td>
            <td className={run.status === 'clean' ? undefined : 'warn'}>
              <Outcome run={run} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReconcilePanel({
  panel,
  note,
}: {
  panel: PanelWire<ReconcileRunsWire>;
  note?: ReactNode;
}) {
  return (
    <Panel title="Reconcile diffs" panel={panel} empty="No reconcile has run yet." after={note}>
      {(served) => <Runs runs={served.runs} />}
    </Panel>
  );
}
