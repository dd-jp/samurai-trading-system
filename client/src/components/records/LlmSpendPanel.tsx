import type { LlmSpendWire, PanelWire } from '@contracts';
import { usd } from '../../lib/format.ts';
import { Panel, TableHead } from '../Panel.tsx';

interface CostTableProps {
  readonly caption: string;
  readonly head: string;
  readonly rows: readonly (readonly [string, number])[];
}

function CostTable({ caption, head, rows }: CostTableProps) {
  return (
    <table className="grid">
      <caption>{caption}</caption>
      <TableHead columns={[head, 'Cost']} />
      <tbody>
        {rows.map(([label, cost]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{usd(cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Spend({ spend }: { spend: LlmSpendWire }) {
  return (
    <>
      <p className="panel-lead">
        {usd(spend.spent_usd)} of {usd(spend.budget_usd)} since {spend.month_start.slice(0, 10)}
      </p>
      {spend.spent_usd === null && (
        <p className="warn" role="note">
          The spend could not be read, so LLM calls are refused. Exits are unaffected.
        </p>
      )}
      {spend.spent_usd !== null && spend.calls_stopped && (
        <p className="warn" role="note">
          The cap has stopped LLM calls. Exits are unaffected.
        </p>
      )}
      <CostTable
        caption="By model"
        head="Model"
        rows={spend.by_model.map((model) => [model.model, model.cost_usd] as const)}
      />
      <CostTable
        caption="By day"
        head="Day"
        rows={spend.by_day.map((day) => [day.day, day.cost_usd] as const)}
      />
    </>
  );
}

export function LlmSpendPanel({ panel }: { panel: PanelWire<LlmSpendWire> }) {
  return (
    <Panel title="LLM spend" panel={panel} empty="No LLM calls this month.">
      {(spend) => <Spend spend={spend} />}
    </Panel>
  );
}
