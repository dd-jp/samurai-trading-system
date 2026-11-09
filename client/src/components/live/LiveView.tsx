import type { V2OverviewWire } from '@contracts';
import { DecisionsPanel } from '../today/DecisionsPanel.tsx';

export function LiveView({ overview }: { overview: V2OverviewWire }) {
  return (
    <div className="view" id="view-live">
      <DecisionsPanel panel={overview.decisions} />
    </div>
  );
}
