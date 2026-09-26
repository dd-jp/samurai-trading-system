import type { NotYetFedWire, PanelWire } from '@contracts';
import type { ReactNode } from 'react';

export function NotYetFed({ panel }: { panel: NotYetFedWire }) {
  return (
    <p className="panel-note" data-status="not-yet-fed">
      Not yet fed: {panel.owner} ({panel.ticket}).
    </p>
  );
}

interface PanelProps<T> {
  readonly title: string;
  readonly panel: PanelWire<T>;
  readonly empty: string;
  readonly children: (fed: T) => ReactNode;
}

export function Panel<T>({ title, panel, empty, children }: PanelProps<T>) {
  return (
    <section className="panel" aria-label={title} data-status={panel.status}>
      <h2>{title}</h2>
      {panel.status === 'fed' && children(panel)}
      {panel.status === 'empty' && <p className="panel-note">{empty}</p>}
      {panel.status === 'not-yet-fed' && <NotYetFed panel={panel} />}
    </section>
  );
}
