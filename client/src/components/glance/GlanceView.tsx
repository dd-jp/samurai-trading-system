import type { V2OverviewWire } from '@contracts';
import { LossBudgetPanel } from '../today/LossBudgetPanel.tsx';
import { PositionsPanel } from '../today/PositionsPanel.tsx';
import { OpenRiskPanel } from './OpenRiskPanel.tsx';
import { PnlPanel } from './PnlPanel.tsx';
import { VerdictsPanel } from './VerdictsPanel.tsx';

export function GlanceView({ overview }: { overview: V2OverviewWire }) {
  return (
    <div className="view" id="view-glance">
      <PnlPanel budget={overview.loss_budget} positions={overview.positions} />
      <OpenRiskPanel panel={overview.positions} />
      <VerdictsPanel panel={overview.decisions} />
      <LossBudgetPanel panel={overview.loss_budget} />
      <PositionsPanel panel={overview.positions} />
    </div>
  );
}
