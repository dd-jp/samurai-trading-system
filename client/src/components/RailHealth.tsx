import type { PanelWire, V2OverviewWire } from '@contracts';
import { gbp, usd } from '../lib/format.ts';

interface Reading {
  readonly text: string;
  readonly filled: number;
  readonly alarm: boolean;
}

function fraction(used: number | null, cap: number): number {
  if (used === null || cap <= 0) return 0;
  return Math.min(Math.max(used / cap, 0), 1);
}

function Gauge<T>({
  label,
  panel,
  read,
}: {
  label: string;
  panel: PanelWire<T>;
  read: (fed: T) => Reading;
}) {
  if (panel.status !== 'fed') {
    return (
      <div className="rail-gauge">
        <span className="rail-label">{label}</span>
        <span>{panel.status === 'empty' ? 'none yet' : `not yet fed (${panel.ticket})`}</span>
      </div>
    );
  }
  const reading = read(panel);
  return (
    <div className="rail-gauge" data-alarm={reading.alarm}>
      <span className="rail-label">{label}</span>
      <span>{reading.text}</span>
      <div className="rail-track" aria-hidden="true">
        <div style={{ width: `${reading.filled * 100}%` }} />
      </div>
    </div>
  );
}

export function RailHealth({ overview }: { overview: V2OverviewWire }) {
  return (
    <div className="rail-health">
      <Gauge
        label="Loss budget"
        panel={overview.loss_budget}
        read={(budget) => ({
          text: `${gbp(-budget.ytd_loss_gbp)} of ${gbp(-budget.loss_cap_gbp)}`,
          filled: fraction(budget.ytd_loss_gbp, budget.loss_cap_gbp),
          alarm: budget.loss_cap_gbp > 0 && budget.ytd_loss_gbp >= budget.loss_cap_gbp,
        })}
      />
      <Gauge
        label="LLM cap"
        panel={overview.llm_spend}
        read={(spend) => ({
          text: `${usd(spend.spent_usd)} of ${usd(spend.budget_usd)}`,
          filled: fraction(spend.spent_usd, spend.budget_usd),
          alarm: spend.spent_usd === null || spend.calls_stopped,
        })}
      />
    </div>
  );
}
