import type { TaxDisposalWire, TaxHeldOutWire, TaxLogWire, TaxWire } from '@contracts';
import { useState } from 'react';
import { type PollOptions, usePoll } from '../../hooks/usePoll.ts';
import { authHeaders, errorOf } from '../../lib/api.ts';
import { fixed, gbp } from '../../lib/format.ts';
import { FeedNote, Panel, TableHead } from '../Panel.tsx';

const TITLE = 'Tax export';
const TAX_URL = '/api/v2/tax';
const RULES: Readonly<Record<TaxDisposalWire['rule'], string>> = {
  'same-day': 'same day',
  '30-day': '30 day',
  'section-104': 'section 104',
};

export function taxYearLabel(year: number): string {
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

function taxUrl(year: number | null, csv = false): string {
  const params = new URLSearchParams();
  if (year !== null) params.set('year', String(year));
  if (csv) params.set('format', 'csv');
  const query = params.toString();
  return query === '' ? TAX_URL : `${TAX_URL}?${query}`;
}

function notes(row: TaxDisposalWire): string {
  return [
    row.acquisition_date === null ? null : `acquired ${row.acquisition_date}`,
    row.provisional ? 'provisional: 30-day window open' : null,
    row.cash_in_lieu ? "cash in lieu at the latest close; the broker's amount is not read" : null,
  ]
    .filter((note) => note !== null)
    .join('; ');
}

function rate(row: TaxDisposalWire): string {
  return row.currency === 'GBP'
    ? 'GBP'
    : `${row.fx_quote_per_gbp} ${row.currency}/GBP (${row.fx_source})`;
}

function Disposals({ log }: { log: TaxLogWire }) {
  return (
    <table className="grid">
      <caption>Disposals, gain only and not tax owed</caption>
      <TableHead
        columns={[
          'Date',
          'Instrument',
          'Qty',
          'Proceeds',
          'Cost',
          'Gain',
          'Rule',
          'FX rate',
          'Note',
        ]}
      />
      <tbody>
        {log.rows.map((row, index) => (
          <tr key={`${row.disposal_date}-${row.instrument}-${row.rule}-${index}`}>
            <th scope="row">{row.disposal_date}</th>
            <td>
              {row.instrument} {row.venue}
            </td>
            <td>{fixed(row.qty, 4)}</td>
            <td>{gbp(row.proceeds_gbp)}</td>
            <td>{gbp(row.cost_gbp)}</td>
            <td className={row.gain_gbp < 0 ? 'warn' : undefined}>{gbp(row.gain_gbp)}</td>
            <td>{RULES[row.rule]}</td>
            <td>{rate(row)}</td>
            <td>{notes(row)}</td>
          </tr>
        ))}
        <tr className="total">
          <th scope="row">Total</th>
          <td />
          <td />
          <td>{gbp(log.proceeds_gbp)}</td>
          <td>{gbp(log.cost_gbp)}</td>
          <td>{gbp(log.gain_gbp)}</td>
          <td />
          <td />
          <td />
        </tr>
      </tbody>
    </table>
  );
}

function HeldOut({ heldOut }: { heldOut: readonly TaxHeldOutWire[] }) {
  if (heldOut.length === 0) return null;
  return (
    <ul aria-label="Held out" className="warn">
      {heldOut.map((held) => (
        <li key={`${held.instrument}-${held.venue}`}>
          {held.instrument} {held.venue}: {held.fills} fills held out, {held.reason}
        </li>
      ))}
    </ul>
  );
}

function saveFile(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function filenameOf(response: Response, year: number): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return match?.[1] ?? `samurai-tax-${taxYearLabel(year)}.csv`;
}

function Download({
  year,
  token,
  fetchImpl,
}: {
  year: number;
  token: string | null;
  fetchImpl: typeof fetch;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const download = async () => {
    try {
      const response = await fetchImpl(taxUrl(year, true), { headers: authHeaders(token) });
      if (!response.ok) {
        setProblem(await errorOf(response));
        return;
      }
      setProblem(null);
      saveFile(await response.blob(), filenameOf(response, year));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <button type="button" onClick={() => void download()}>
        Download CSV
      </button>
      {problem !== null && (
        <p className="panel-note" role="alert">
          The CSV download failed: {problem}.
        </p>
      )}
    </>
  );
}

function YearPicker({ served, onPick }: { served: TaxWire; onPick: (year: number) => void }) {
  const years = [...new Set([...served.years, served.year])].sort((a, b) => b - a);
  return (
    <label>
      Tax year
      <select value={served.year} onChange={(e) => onPick(Number(e.target.value))}>
        {years.map((year) => (
          <option key={year} value={year}>
            {taxYearLabel(year)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaxPanel({ token, options }: { token: string | null; options: PollOptions }) {
  const [year, setYear] = useState<number | null>(null);
  const tax = usePoll<TaxWire>(taxUrl(year), token, options);
  const served = tax.data;
  if (served === null) {
    return (
      <section className="panel" aria-label={TITLE} data-status={tax.status}>
        <h2>{TITLE}</h2>
        <FeedNote state={tax} />
      </section>
    );
  }
  return (
    <Panel
      title={TITLE}
      panel={served.disposals}
      empty={`No disposals in ${taxYearLabel(served.year)}.`}
      after={
        <>
          <div className="search">
            <YearPicker served={served} onPick={setYear} />
            <Download year={served.year} token={token} fetchImpl={options.fetchImpl ?? fetch} />
          </div>
          <p className="panel-note">
            Broker fills only, matched same day, then 30 day, then the section 104 pool; US trades
            at the BoE day rate. Paper disposals are not taxable. Check every figure against the
            broker&apos;s contract notes.
          </p>
          <FeedNote state={tax} />
        </>
      }
    >
      {(log) => (
        <>
          <Disposals log={log} />
          <HeldOut heldOut={log.held_out} />
        </>
      )}
    </Panel>
  );
}
