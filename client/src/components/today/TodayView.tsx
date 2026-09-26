import type { V2OverviewWire } from '@contracts';
import { DecisionsPanel } from './DecisionsPanel.tsx';
import { LossBudgetPanel } from './LossBudgetPanel.tsx';
import { PositionsPanel } from './PositionsPanel.tsx';

export function TodayView({ overview }: { overview: V2OverviewWire }) {
  return (
    <div className="view" id="view-today">
      <LossBudgetPanel panel={overview.loss_budget} />
      <PositionsPanel panel={overview.positions} />
      <DecisionsPanel panel={overview.decisions} />
    </div>
  );
}
