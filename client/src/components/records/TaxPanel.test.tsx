// @vitest-environment jsdom
import type { TaxCfdDisposalWire, TaxDisposalWire, TaxWire } from '@contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOURNAL, jsonResponse } from '../../test-wire.ts';
import { TaxPanel, taxYearLabel } from './TaxPanel.tsx';

const ROW: TaxDisposalWire = {
  disposal_date: '2026-07-01',
  instrument: 'AAPL',
  venue: 'alpaca',
  qty: 5,
  proceeds_gbp: 684.62,
  cost_gbp: 600,
  gain_gbp: 84.62,
  rule: 'section-104',
  acquisition_date: null,
  currency: 'USD',
  fx_quote_per_gbp: 1.3,
  fx_source: 'boe-xudluss:2026-07-01',
  provisional: true,
  cash_in_lieu: false,
  cash_in_lieu_activity: null,
};

const CFD_ROW: TaxCfdDisposalWire = {
  instrument: 'TSLA',
  venue: 'saxo_cfd_usd',
  direction: 'short',
  open_date: '2026-05-01',
  close_date: '2026-07-01',
  qty: 10,
  currency: 'USD',
  open_price_native: 200,
  close_price_native: 180,
  open_fx_quote_per_gbp: 1.25,
  close_fx_quote_per_gbp: 1.3,
  fx_source: 'boe-xudluss:2026-05-01 boe-xudluss:2026-07-01',
  open_value_gbp: 1600,
  close_value_gbp: 1384.62,
  realised_pnl_gbp: 215.38,
  commission_gbp: 4,
  financing_gbp: 1.2,
  borrow_gbp: 0.8,
  net_gbp: 209.38,
  treatment: 'unconfirmed',
};

function tax(overrides: Partial<TaxWire> = {}): TaxWire {
  return {
    contract_version: JOURNAL.contract_version,
    year: 2026,
    years: [2025, 2026],
    disposals: {
      status: 'fed',
      rows: [
        ROW,
        {
          ...ROW,
          disposal_date: '2026-09-29',
          instrument: 'VUSA',
          venue: 'saxo',
          qty: 0.5,
          proceeds_gbp: 10,
          cost_gbp: 12,
          gain_gbp: -2,
          rule: '30-day',
          acquisition_date: '2026-10-02',
          currency: 'GBP',
          fx_quote_per_gbp: 1,
          fx_source: 'gbp',
          provisional: false,
          cash_in_lieu: true,
        },
      ],
      held_out: [{ instrument: 'MSFT', venue: 'alpaca', reason: 'no fix', fills: 3 }],
      proceeds_gbp: 694.62,
      cost_gbp: 612,
      gain_gbp: 82.62,
    },
    cfd_disposals: { status: 'empty' },
    ...overrides,
  };
}

function serving(byUrl: Record<string, unknown>) {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const body = byUrl[String(url)];
    return body instanceof Response ? body : jsonResponse(body);
  });
}

function mount(fetchImpl: typeof fetch): void {
  render(<TaxPanel token="tok" options={{ fetchImpl }} />);
}

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Tax export' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaxPanel (P13)', () => {
  it('lists each disposal in GBP with its rule, the FX rate used and the totals', async () => {
    mount(serving({ '/api/v2/tax': tax() }));
    await screen.findByText('2026-07-01');
    expect(
      within(region())
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual([
      '2026-07-01AAPL alpaca5.0000£684.62£600.00£84.62section 1041.3 USD/GBP (boe-xudluss:2026-07-01)provisional: 30-day window open',
      "2026-09-29VUSA saxo0.5000£10.00£12.00−£2.0030 dayGBPacquired 2026-10-02; cash in lieu at the latest close; the broker's amount is not read yet",
      'Total£694.62£612.00£82.62',
    ]);
    expect(within(region()).getByRole('list', { name: 'Held out' }).textContent).toBe(
      'MSFT alpaca: 3 fills held out, no fix',
    );
    expect(region().textContent).toContain('Paper disposals are not taxable.');
  });

  it("names the broker's cash-in-lieu activity when the broker's amount replaced the estimate", async () => {
    const paid = { ...ROW, cash_in_lieu: true, cash_in_lieu_activity: 'alpaca:cil-1' };
    mount(
      serving({
        '/api/v2/tax': tax({
          disposals: {
            status: 'fed',
            rows: [paid],
            held_out: [],
            proceeds_gbp: paid.proceeds_gbp,
            cost_gbp: paid.cost_gbp,
            gain_gbp: paid.gain_gbp,
          },
        }),
      }),
    );
    await screen.findByText('2026-07-01');
    expect(region().textContent).toContain("cash in lieu at the broker's amount (alpaca:cil-1)");
    expect(region().textContent).not.toContain('latest close');
  });

  it('lists closed CFD positions apart from share matching, with carry as costs and the treatment unconfirmed', async () => {
    mount(
      serving({
        '/api/v2/tax': tax({
          cfd_disposals: {
            status: 'fed',
            rows: [
              CFD_ROW,
              {
                ...CFD_ROW,
                instrument: 'VOD',
                venue: 'saxo_cfd_gbp',
                direction: 'long',
                currency: 'GBP',
                net_gbp: -1,
              },
            ],
            held_out: [{ instrument: 'ISF', venue: 'saxo_cfd_gbp', reason: 'no carry', fills: 2 }],
            realised_pnl_gbp: 430.76,
            commission_gbp: 8,
            financing_gbp: 2.4,
            borrow_gbp: 1.6,
            net_gbp: 208.38,
            treatment: 'unconfirmed',
          },
        }),
      }),
    );
    const table = await screen.findByRole('table', { name: 'CFD disposals' });
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual([
      '2026-07-012026-05-01TSLA saxo_cfd_usd short10.0000200.0000 / 180.0000 USD1.2500 / 1.3000 USD/GBP (boe-xudluss:2026-05-01 boe-xudluss:2026-07-01)£215.38£4.00£1.20£0.80£209.38',
      '2026-07-012026-05-01VOD saxo_cfd_gbp long10.0000200.0000 / 180.0000 GBPGBP£215.38£4.00£1.20£0.80−£1.00',
      'Total£430.76£8.00£2.40£1.60£208.38',
    ]);
    expect(table.textContent).toContain('treatment unconfirmed');
    expect(within(region()).getByRole('list', { name: 'CFDs held out' }).textContent).toBe(
      'ISF saxo_cfd_gbp: 2 fills held out, no carry',
    );
  });

  it('downloads the CFD log as its own CSV', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:tax', revokeObjectURL: () => undefined });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const fetchImpl = serving({
      '/api/v2/tax': tax(),
      '/api/v2/tax?year=2026&format=cfd-csv': new Response('x'),
    });
    mount(fetchImpl);
    fireEvent.click(await screen.findByRole('button', { name: 'Download CFD CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
      'samurai-tax-cfd-2026-27.csv',
    );
  });

  it('says when a year has no disposals, and loads another year when picked', async () => {
    const fetchImpl = serving({
      '/api/v2/tax': tax({ disposals: { status: 'empty' }, years: [2025] }),
      '/api/v2/tax?year=2025': tax({ year: 2025, years: [2025] }),
    });
    mount(fetchImpl);
    await screen.findByText('No disposals in 2026-27.');
    const picker = within(region()).getByLabelText('Tax year') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(['2026-27', '2025-26']);
    fireEvent.change(picker, { target: { value: '2025' } });
    await screen.findByText('2026-07-01');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain('/api/v2/tax?year=2025');
  });

  it('downloads the shown year as a CSV with the token, under the server’s file name', async () => {
    const created = vi.fn(() => 'blob:tax');
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const csv = new Response('disposal_date\n', {
      headers: { 'Content-Disposition': 'attachment; filename="samurai-tax-2026-27.csv"' },
    });
    const fetchImpl = serving({ '/api/v2/tax': tax(), '/api/v2/tax?year=2026&format=csv': csv });
    mount(fetchImpl);
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('samurai-tax-2026-27.csv');
    expect(link.href).toBe('blob:tax');
    expect(revoked).toHaveBeenCalledWith('blob:tax');
    const [, init] = fetchImpl.mock.calls.find(([url]) => String(url).includes('csv')) ?? [];
    expect(init?.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('names the file itself when the server gives no name', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:tax', revokeObjectURL: () => undefined });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const fetchImpl = serving({
      '/api/v2/tax': tax(),
      '/api/v2/tax?year=2026&format=csv': new Response('x'),
    });
    mount(fetchImpl);
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
      'samurai-tax-2026-27.csv',
    );
  });

  it('says why a download failed, and clears it after one that works', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:tax', revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (!String(url).includes('csv')) return jsonResponse(tax());
      attempt += 1;
      if (attempt === 1) return jsonResponse({ error: 'year is invalid' }, 400);
      if (attempt === 2) throw new Error('offline');
      return new Response('x');
    });
    mount(fetchImpl);
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The CSV download failed: year is invalid.',
    );
    fireEvent.click(button);
    await screen.findByText('The CSV download failed: offline.');
    fireEvent.click(button);
    await waitFor(() => expect(within(region()).queryByRole('alert')).toBeNull());
  });

  it('holds a loading state until the route answers', () => {
    mount(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)));
    expect(region().textContent).toBe('Tax exportLoading…');
  });

  it('labels a tax year by its two calendar years', () => {
    expect(taxYearLabel(2026)).toBe('2026-27');
    expect(taxYearLabel(2099)).toBe('2099-00');
  });
});
