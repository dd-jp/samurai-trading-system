import type { LossBudgetBookWire, LossBudgetWire, PanelWire } from '@contracts';
import { gbp, sizeStep } from '../../lib/format.ts';
import { Panel } from '../Panel.tsx';

function share(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(Math.max(value / cap, 0), 1) * 100;
}

interface MeterProps {
  readonly label: string;
  readonly loss: number;
  readonly cap: number;
  readonly marks: readonly number[];
}

function Meter({ label, loss, cap, marks }: MeterProps) {
  const over = loss >= cap;
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className={over ? 'meter-value over' : 'meter-value'}>
          {gbp(-loss)} of {gbp(-cap)}
          {over ? ' (reached)' : ''}
        </span>
      </div>
      <svg
        className="meter-track"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${gbp(-loss)} against ${gbp(-cap)}`}
      >
        <rect className="meter-ground" x="0" y="2" width="100" height="6" />
        <rect className="meter-fill" x="0" y="2" width={share(loss, cap)} height="6" />
        {marks.map((mark) => (
          <line key={mark} className="meter-mark" x1={share(mark, cap)} x2={share(mark, cap)} y1="0" y2="10" />
        ))}
      </svg>
      {marks.length > 0 && (
        <ul className="meter-marks" aria-label="Size steps">
          {marks.map((mark, index) => (
            <li key={mark}>
              {gbp(-mark)}: {index === marks.length - 1 ? 'halt' : `${sizeStep(0.5 ** (index + 1))} size`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sleevesOf(books: readonly LossBudgetBookWire[]): string[] {
  return [...new Set(books.map((book) => book.sleeve_id))];
}

function BookRows({ books }: { books: readonly LossBudgetBookWire[] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th scope="col">Book</th>
          <th scope="col">YTD loss</th>
          <th scope="col">Today</th>
          <th scope="col">Size</th>
          <th scope="col">Entries</th>
        </tr>
      </thead>
      <tbody>
        {sleevesOf(books).flatMap((sleeve) =>
          books
            .filter((book) => book.sleeve_id === sleeve)
            .map((book) => (
              <tr key={book.book_id} className={book.variant === 'primary' ? 'primary' : 'shadow'}>
                <th scope="row">
                  {book.variant === 'primary' ? book.book_id : `↳ ${book.variant} (shadow)`}
                </th>
                <td>{gbp(-book.ytd_loss_gbp)}</td>
                <td>{gbp(-book.day_loss_gbp)}</td>
                <td>{sizeStep(book.size_multiplier)}</td>
                <td>{book.entries_blocked ? 'blocked at next fill' : 'open'}</td>
              </tr>
            )),
        )}
      </tbody>
    </table>
  );
}

function LossBudget({ budget }: { budget: LossBudgetWire }) {
  return (
    <>
      {budget.capital_stale && (
        <p className="warn" role="note">
          No capital config for this year yet: marks use {budget.year}'s. Set it with{' '}
          <code>npm run v2:capital</code>.
        </p>
      )}
      <Meter
        label={`Year-to-date loss (${budget.year}, primary books)`}
        loss={budget.ytd_loss_gbp}
        cap={budget.loss_cap_gbp}
        marks={budget.step_marks_gbp}
      />
      <Meter
        label={`Today's loss (${budget.trading_date})`}
        loss={budget.day_loss_gbp}
        cap={budget.daily_cap_gbp}
        marks={[]}
      />
      <p className="panel-note">
        Start capital {gbp(budget.start_capital_gbp)}; daily cap blocks entries.
      </p>
      <BookRows books={budget.books} />
    </>
  );
}

export function LossBudgetPanel({ panel }: { panel: PanelWire<LossBudgetWire> }) {
  return (
    <Panel title="Loss budget" panel={panel} empty="No cycle has run yet.">
      {(budget) => <LossBudget budget={budget} />}
    </Panel>
  );
}
