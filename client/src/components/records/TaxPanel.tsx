import type {
  TaxCfdDisposalWire,
  TaxCfdLogWire,
  TaxDisposalWire,
  TaxHeldOutWire,
  TaxLogWire,
  TaxWire,
} from '@contracts';
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

type CsvFormat = 'csv' | 'cfd-csv';

function taxUrl(year: number | null, format: CsvFormat | null = null): string {
  const params = new URLSearchParams();
  if (year !== null) params.set('year', String(year));
  if (format !== null) params.set('format', format);
  const query = params.toString();
  return query === '' ? TAX_URL : `${TAX_URL}?${query}`;
}

function cashInLieuNote(row: TaxDisposalWire): string | null {
  if (!row.cash_in_lieu) return null;
  return row.cash_in_lieu_activity === null
    ? "cash in lieu at the latest close; the broker's amount is not read yet"
    : `cash in lieu at the broker's amount (${row.cash_in_lieu_activity})`;
}

function notes(row: TaxDisposalWire): string {
  return [
    row.acquisition_date === null ? null : `acquired ${row.acquisition_date}`,
    row.provisional ? 'provisional: 30-day window open' : null,
    cashInLieuNote(row),
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
        {log.rows.map((row) => (
          <tr
            key={`${row.disposal_date}-${row.instrument}-${row.rule}-${row.acquisition_date ?? 'pool'}`}
          >
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

function HeldOut({
  heldOut,
  label = 'Held out',
}: {
  heldOut: readonly TaxHeldOutWire[];
  label?: string;
}) {
  if (heldOut.length === 0) return null;
  return (
    <ul aria-label={label} className="warn">
      {heldOut.map((held) => (
        <li key={`${held.instrument}-${held.venue}`}>
          {held.instrument} {held.venue}: {held.fills} fills held out, {held.reason}
        </li>
      ))}
    </ul>
  );
}

function cfdRate(row: TaxCfdDisposalWire): string {
  return row.currency === 'GBP'
    ? 'GBP'
    : `${fixed(row.open_fx_quote_per_gbp, 4)} / ${fixed(row.close_fx_quote_per_gbp, 4)} ${row.currency}/GBP (${row.fx_source})`;
}

function CfdDisposals({ log }: { log: TaxCfdLogWire }) {
  return (
    <>
      <table className="grid" aria-label="CFD disposals">
        <caption>
          CFD positions closed, kept apart from share matching; treatment {log.treatment} until the
          accountant confirms it
        </caption>
        <TableHead
          columns={[
            'Closed',
            'Opened',
            'Instrument',
            'Qty',
            'Open / close price',
            'FX rate',
            'Realised',
            'Commission',
            'Financing',
            'Borrow',
            'Net',
          ]}
        />
        <tbody>
          {log.rows.map((row) => (
            <tr key={`${row.close_date}-${row.instrument}-${row.venue}-${row.open_date}`}>
              <th scope="row">{row.close_date}</th>
              <td>{row.open_date}</td>
              <td>
                {row.instrument} {row.venue} {row.direction}
              </td>
              <td>{fixed(row.qty, 4)}</td>
              <td>
                {fixed(row.open_price_native, 4)} / {fixed(row.close_price_native, 4)}{' '}
                {row.currency}
              </td>
              <td>{cfdRate(row)}</td>
              <td>{gbp(row.realised_pnl_gbp)}</td>
              <td>{gbp(row.commission_gbp)}</td>
              <td>{gbp(row.financing_gbp)}</td>
              <td>{gbp(row.borrow_gbp)}</td>
              <td className={row.net_gbp < 0 ? 'warn' : undefined}>{gbp(row.net_gbp)}</td>
            </tr>
          ))}
          <tr className="total">
            <th scope="row">Total</th>
            <td />
            <td />
            <td />
            <td />
            <td />
            <td>{gbp(log.realised_pnl_gbp)}</td>
            <td>{gbp(log.commission_gbp)}</td>
            <td>{gbp(log.financing_gbp)}</td>
            <td>{gbp(log.borrow_gbp)}</td>
            <td>{gbp(log.net_gbp)}</td>
          </tr>
        </tbody>
      </table>
      <HeldOut heldOut={log.held_out} label="CFDs held out" />
    </>
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

const CSV_PREFIX: Readonly<Record<CsvFormat, string>> = {
  csv: 'samurai-tax',
  'cfd-csv': 'samurai-tax-cfd',
};

const CSV_LABEL: Readonly<Record<CsvFormat, string>> = {
  csv: 'Download CSV',
  'cfd-csv': 'Download CFD CSV',
};

function filenameOf(response: Response, year: number, format: CsvFormat): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return match?.[1] ?? `${CSV_PREFIX[format]}-${taxYearLabel(year)}.csv`;
}

function Download({
  year,
  token,
  fetchImpl,
  format,
}: {
  year: number;
  token: string | null;
  fetchImpl: typeof fetch;
  format: CsvFormat;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const download = async () => {
    try {
      const response = await fetchImpl(taxUrl(year, format), { headers: authHeaders(token) });
      if (!response.ok) {
        setProblem(await errorOf(response));
        return;
      }
      setProblem(null);
      saveFile(await response.blob(), filenameOf(response, year, format));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <button type="button" onClick={() => void download()}>
        {CSV_LABEL[format]}
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
            <Download
              year={served.year}
              token={token}
              fetchImpl={options.fetchImpl ?? fetch}
              format="csv"
            />
            <Download
              year={served.year}
              token={token}
              fetchImpl={options.fetchImpl ?? fetch}
              format="cfd-csv"
            />
          </div>
          {served.cfd_disposals.status === 'fed' && <CfdDisposals log={served.cfd_disposals} />}
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
