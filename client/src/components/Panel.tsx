import type { NotYetFedWire, PanelWire } from '@contracts';
import type { ReactNode } from 'react';
import type { PollState } from '../hooks/usePoll.ts';

export function NotYetFed({ panel, label }: { panel: NotYetFedWire; label?: string }) {
  return (
    <p className="panel-note" data-status="not-yet-fed">
      {label === undefined ? '' : `${label}: `}Not yet fed: {panel.owner} ({panel.ticket}).
    </p>
  );
}

export function TableHead({ columns }: { columns: readonly string[] }) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th key={column} scope="col">
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

interface PanelProps<T> {
  readonly title: string;
  readonly panel: PanelWire<T>;
  readonly empty: string;
  readonly children: (fed: T) => ReactNode;
  readonly after?: ReactNode;
}

export function Panel<T>({ title, panel, empty, children, after }: PanelProps<T>) {
  return (
    <section className="panel" aria-label={title} data-status={panel.status}>
      <h2>{title}</h2>
      {panel.status === 'fed' && children(panel)}
      {panel.status === 'empty' && <p className="panel-note">{empty}</p>}
      {panel.status === 'not-yet-fed' && <NotYetFed panel={panel} />}
      {after}
    </section>
  );
}

export function OwnedPanel({
  title,
  panel,
  children,
}: {
  title: string;
  panel: NotYetFedWire;
  children?: ReactNode;
}) {
  return (
    <section className="panel" aria-label={title} data-status={panel.status}>
      <h2>{title}</h2>
      <NotYetFed panel={panel} />
      {children}
    </section>
  );
}

function feedProblem(state: PollState<unknown>): string | null {
  switch (state.status) {
    case 'ok':
      return null;
    case 'waiting':
      return 'Loading…';
    case 'unauthorized':
      return 'The dashboard token was rejected.';
    case 'contract-mismatch':
      return 'The server runs a different contract version; reload the page.';
    case 'failed':
      return `Could not read it: ${state.error ?? 'unknown error'}.`;
  }
}

export function FeedNote({ state }: { state: PollState<unknown> }) {
  const problem = feedProblem(state);
  if (problem === null) return null;
  const stale = state.data !== null && state.status !== 'waiting';
  return (
    <p className="panel-note" role="status">
      {problem}
      {stale ? ' Showing the last good read.' : ''}
    </p>
  );
}

export function FeedPanel<T>({
  title,
  state,
  children,
}: {
  title: string;
  state: PollState<T>;
  children: (data: T, note: ReactNode) => ReactNode;
}) {
  if (state.data !== null) return children(state.data, <FeedNote state={state} />);
  return (
    <section className="panel" aria-label={title} data-status={state.status}>
      <h2>{title}</h2>
      <FeedNote state={state} />
    </section>
  );
}
