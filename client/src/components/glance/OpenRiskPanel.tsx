import type { PanelWire, PositionsWire, PositionWire } from '@contracts';
import { gbp, percent } from '../../lib/format.ts';
import { Panel } from '../Panel.tsx';

function riskUsed(entry: number, stop: number, price: number): number {
  if (entry === stop) return 0;
  return Math.min(Math.max((entry - price) / (entry - stop), 0), 1);
}

function RiskLine({ position }: { position: PositionWire }) {
  const { mark, stop_gbp: stop } = position;
  const fresh = mark.status === 'fresh';
  let detail = 'no fresh mark';
  if (stop === null) detail = 'no stop';
  else if (fresh) {
    detail = `${percent(Math.abs(mark.price_gbp - stop) / mark.price_gbp)} to stop`;
  }
  return (
    <li className="risk-line" data-warn={stop === null || !fresh}>
      <span>{position.instrument}</span>
      <span>{fresh ? gbp(mark.unrealised_gbp) : ''}</span>
      <span>{detail}</span>
      {fresh && stop !== null && (
        <div className="rail-track" aria-hidden="true">
          <div style={{ width: `${riskUsed(position.entry_gbp, stop, mark.price_gbp) * 100}%` }} />
        </div>
      )}
    </li>
  );
}

function OpenRisk({ positions }: { positions: PositionsWire }) {
  const primary = positions.positions.filter((position) => position.variant === 'primary');
  if (primary.length === 0) return <p className="panel-note">No open positions.</p>;
  return (
    <ul className="risk">
      {primary.map((position) => (
        <RiskLine key={`${position.book_id}/${position.instrument}`} position={position} />
      ))}
    </ul>
  );
}

export function OpenRiskPanel({ panel }: { panel: PanelWire<PositionsWire> }) {
  return (
    <Panel title="Open risk" panel={panel} empty="No books yet.">
      {(positions) => <OpenRisk positions={positions} />}
    </Panel>
  );
}
