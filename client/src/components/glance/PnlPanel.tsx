import type { LossBudgetWire, PanelWire, PositionsWire } from '@contracts';
import { gbp, UNKNOWN } from '../../lib/format.ts';
import { Panel } from '../Panel.tsx';

function unrealisedText(positions: PanelWire<PositionsWire>): string {
  if (positions.status !== 'fed') return UNKNOWN;
  const primary = positions.positions.filter((position) => position.variant === 'primary');
  let total = 0;
  let unmarked = 0;
  for (const { mark } of primary) {
    if (mark.status === 'fresh') total += mark.unrealised_gbp;
    else unmarked += 1;
  }
  return unmarked === 0 ? gbp(total) : `${gbp(total)} (${unmarked} without a fresh mark)`;
}

function openCount(positions: PanelWire<PositionsWire>): string {
  if (positions.status !== 'fed') return UNKNOWN;
  return String(positions.positions.filter((position) => position.variant === 'primary').length);
}

function Pnl({
  budget,
  positions,
}: {
  budget: LossBudgetWire;
  positions: PanelWire<PositionsWire>;
}) {
  const pnl = -budget.day_loss_gbp;
  return (
    <>
      <p className="big" data-sign={pnl < 0 ? 'loss' : 'gain'}>
        {gbp(pnl)}
      </p>
      <p className="panel-note">Primary books, cycle {budget.trading_date}</p>
      <dl className="facts">
        <dt>Unrealised</dt>
        <dd>{unrealisedText(positions)}</dd>
        <dt>Open positions</dt>
        <dd>{openCount(positions)}</dd>
        <dt>Daily cap</dt>
        <dd>{gbp(-budget.daily_cap_gbp)}</dd>
      </dl>
    </>
  );
}

export function PnlPanel({
  budget,
  positions,
}: {
  budget: PanelWire<LossBudgetWire>;
  positions: PanelWire<PositionsWire>;
}) {
  return (
    <Panel title="P&L" panel={budget} empty="No cycle has run yet.">
      {(fed) => <Pnl budget={fed} positions={positions} />}
    </Panel>
  );
}
