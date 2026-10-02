import type {
  ControlWire,
  LlmSpendWire,
  LossBudgetWire,
  PanelWire,
  PositionsWire,
  PositionWire,
  V2OverviewWire,
} from '../../../../contracts/index.js';

const MAX_LISTED_POSITIONS = 10;

const STATE_LABELS: Readonly<Record<ControlWire['state'], string>> = {
  running: 'RUNNING',
  paused: 'PAUSED (entries blocked)',
  'halted-manual':
    'HALTED (manual, exits go out within about a minute, or at the next cycle if the signals process is down)',
  'halted-loss-budget': 'HALTED (loss budget)',
};

const UNAVAILABLE = 'n/a';

function gbp(amount: number): string {
  const digits = Math.abs(amount).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount < 0 ? '-' : ''}£${digits}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function stateLine(control: ControlWire): string {
  const label = STATE_LABELS[control.state];
  const { in_force: inForce } = control;
  const manual = inForce === null ? '' : ` since ${inForce.set_at}: ${inForce.reason}`;
  const budget =
    control.loss_budget_halted_books.length === 0
      ? ''
      : `; loss-budget halt on ${control.loss_budget_halted_books.join(', ')}`;
  return `State: ${label}${manual}${budget}`;
}

function equityLine(positions: PanelWire<PositionsWire>): string {
  if (positions.status !== 'fed') return `Equity: ${UNAVAILABLE}`;
  const cash = positions.cash.reduce((sum, book) => sum + book.cash_gbp, 0);
  if (positions.total_gbp === null)
    return `Equity: ${UNAVAILABLE} (cash ${gbp(cash)}, marks stale)`;
  const total = cash + positions.total_gbp;
  return `Equity: ${gbp(total)} (cash ${gbp(cash)}, positions ${gbp(positions.total_gbp)})`;
}

function unrealisedOf(position: PositionWire): string {
  return position.mark.status === 'fresh' ? gbp(position.mark.unrealised_gbp) : 'mark stale';
}

function positionLines(positions: PanelWire<PositionsWire>): string[] {
  if (positions.status !== 'fed') return [`Open positions: ${UNAVAILABLE}`];
  const held = positions.positions;
  if (held.length === 0) return ['Open positions: none'];
  const listed = held
    .slice(0, MAX_LISTED_POSITIONS)
    .map((p) => `  ${p.instrument} x${p.qty} [${p.book_id}] ${unrealisedOf(p)}`);
  const more = held.length - listed.length;
  return [`Open positions: ${held.length}`, ...listed, ...(more > 0 ? [`  and ${more} more`] : [])];
}

function lossBudgetLine(budget: PanelWire<LossBudgetWire>): string {
  if (budget.status !== 'fed') return `Loss budget: ${UNAVAILABLE}`;
  return (
    `Loss budget ${budget.year}: year-to-date loss ${gbp(budget.ytd_loss_gbp)} of ` +
    `${gbp(budget.loss_cap_gbp)} cap; today ${gbp(budget.day_loss_gbp)} of ${gbp(budget.daily_cap_gbp)} daily cap`
  );
}

function llmSpendLine(spend: PanelWire<LlmSpendWire>): string {
  if (spend.status !== 'fed') return `LLM spend: ${UNAVAILABLE}`;
  const spent = spend.spent_usd === null ? UNAVAILABLE : usd(spend.spent_usd);
  const stopped = spend.calls_stopped ? ' (calls stopped)' : '';
  return `LLM spend this month: ${spent} of ${usd(spend.budget_usd)}${stopped}`;
}

function lastCycleLine(overview: V2OverviewWire): string {
  const last = overview.heartbeat.last_cycle;
  return `Last cycle: ${last.status === 'fed' ? last.trading_date : UNAVAILABLE}`;
}

export function formatStatus(overview: V2OverviewWire): string {
  return [
    `Samurai v2 status (${overview.mode})`,
    stateLine(overview.control),
    equityLine(overview.positions),
    ...positionLines(overview.positions),
    lossBudgetLine(overview.loss_budget),
    llmSpendLine(overview.llm_spend),
    lastCycleLine(overview),
  ].join('\n');
}
