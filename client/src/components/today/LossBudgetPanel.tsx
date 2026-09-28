import type { LossBudgetBookWire, LossBudgetWire, PanelWire } from '@contracts';
import { gbp, sizeStep } from '../../lib/format.ts';
import { Panel, TableHead } from '../Panel.tsx';

function share(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(Math.max(value / cap, 0), 1) * 100;
}

type StepMarks = LossBudgetWire['step_marks_gbp'];

const STEP_LABELS = ['½ size', '¼ size', 'halt'] as const;

interface MeterProps {
  readonly label: string;
  readonly loss: number;
  readonly cap: number;
  readonly marks: StepMarks | null;
}

function Meter({ label, loss, cap, marks }: MeterProps) {
  const over = cap > 0 && loss >= cap;
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
        {marks?.map((mark, index) => (
          <line
            key={STEP_LABELS[index]}
            className="meter-mark"
            x1={share(mark, cap)}
            x2={share(mark, cap)}
            y1="0"
            y2="10"
          />
        ))}
      </svg>
      {marks !== null && (
        <ul className="meter-marks" aria-label="Size steps">
          {marks.map((mark, index) => (
            <li key={STEP_LABELS[index]}>
              {gbp(-mark)}: {STEP_LABELS[index]}
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

function negOrNull(value: number | null): number | null {
  return value === null ? null : -value;
}

function sleeveCap(book: LossBudgetBookWire): string {
  const cap = gbp(negOrNull(book.loss_cap_gbp));
  if (book.step_marks_gbp === null) return cap;
  const [half, quarter, halt] = book.step_marks_gbp;
  return `${cap} (½ ${gbp(-half)}, ¼ ${gbp(-quarter)}, halt ${gbp(-halt)})`;
}

function BookRows({ books }: { books: readonly LossBudgetBookWire[] }) {
  return (
    <table className="grid">
      <TableHead
        columns={['Book', 'YTD loss', 'Sleeve cap', 'Today', 'Daily cap', 'Size', 'Entries']}
      />
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
                <td>{sleeveCap(book)}</td>
                <td>{gbp(-book.day_loss_gbp)}</td>
                <td>{gbp(negOrNull(book.daily_cap_gbp))}</td>
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
        marks={null}
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
