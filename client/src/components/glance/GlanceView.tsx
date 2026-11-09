import type { V2OverviewWire } from '@contracts';
import { LossBudgetPanel } from '../today/LossBudgetPanel.tsx';
import { PositionsPanel } from '../today/PositionsPanel.tsx';

export function GlanceView({ overview }: { overview: V2OverviewWire }) {
  return (
    <div className="view" id="view-glance">
      <LossBudgetPanel panel={overview.loss_budget} />
      <PositionsPanel panel={overview.positions} />
    </div>
  );
}
