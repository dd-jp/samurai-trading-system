// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JOURNAL, jsonResponse } from '../../test-wire.ts';
import { JournalPanel } from './JournalPanel.tsx';

function mount(fetchImpl: typeof fetch) {
  render(<JournalPanel token="tok" options={{ fetchImpl }} />);
  return screen.getByRole('region', { name: 'Decision journal' });
}

function serving(body: unknown = JOURNAL, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(body, status));
}

function urls(fetchImpl: ReturnType<typeof serving>): string[] {
  return fetchImpl.mock.calls.map(([url]) => String(url));
}

describe('JournalPanel (P9)', () => {
  it('lists each cycle day with its decisions, unowned orders and refusals', async () => {
    const panel = mount(serving());
    const day = await within(panel).findByRole('article', { name: 'Cycle 2026-10-05' });
    const decision = within(day).getByText(/AAPL long, debate\/primary: vetoed, 64%/);
    expect(decision.closest('details')?.dataset.outcome).toBe('vetoed');
    expect(within(day).getByRole('list', { name: 'Orders no decision owns' }).textContent).toBe(
      'exit sell MSFT (alpaca), filled, 2026-10-05 21:41ZFill 2 at £310.00, fee £0.50, 2026-10-05 21:42Z',
    );
    expect(within(day).getByRole('list', { name: 'Refusals' }).textContent).toBe(
      'universe, saxo_universe (#1740): unset',
    );
  });

  it('expands a decision to its reason, veto, inputs hash, debate and payload', async () => {
    const panel = mount(serving());
    const summary = await within(panel).findByText(/AAPL long/);
    fireEvent.click(summary);
    const details = summary.closest('details') as HTMLElement;
    const facts = within(details)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(facts).toEqual([
      'Reason',
      'Veto category',
      'Size',
      'Inputs hash',
      'Debate',
      'Recorded',
      'Payload',
    ]);
    expect(details.textContent).toContain('vetoed:earnings');
    expect(details.textContent).toContain('0 shares, stop —');
    expect(details.textContent).toContain('abc123');
    expect(details.textContent).toContain('debate-9');
    expect(details.textContent).toContain('"judge": "opus"');
  });

  it('searches with only the filters set, from the newest page', async () => {
    const fetchImpl = serving();
    const panel = mount(fetchImpl);
    await within(panel).findByRole('article');
    const form = within(panel).getByRole('form', { name: 'Search the journal' });
    fireEvent.change(within(form).getByLabelText('Book'), {
      target: { value: 'debate/primary' },
    });
    fireEvent.change(within(form).getByLabelText('Outcome'), { target: { value: 'vetoed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(urls(fetchImpl).at(-1)).toBe('/api/v2/journal?book=debate%2Fprimary&action=vetoed'),
    );
    expect(urls(fetchImpl)[0]).toBe('/api/v2/journal');
  });

  it('caps each text filter at the server limit', async () => {
    const panel = mount(serving());
    const form = await within(panel).findByRole('form', { name: 'Search the journal' });
    for (const name of ['Book', 'Instrument', 'Veto category']) {
      expect((within(form).getByLabelText(name) as HTMLInputElement).maxLength).toBe(64);
    }
  });

  it('searches from the newest page after paging', async () => {
    const fetchImpl = serving();
    const panel = mount(fetchImpl);
    fireEvent.click(await within(panel).findByRole('button', { name: 'Older' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/v2/journal?before=2026-10-05'));
    const form = await within(panel).findByRole('form', { name: 'Search the journal' });
    fireEvent.change(within(form).getByLabelText('Instrument'), { target: { value: 'AAPL' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/v2/journal?instrument=AAPL'));
  });

  it('pages to older days and back to the newest', async () => {
    const fetchImpl = serving();
    const panel = mount(fetchImpl);
    await within(panel).findByRole('button', { name: 'Older' });
    expect(within(panel).queryByRole('button', { name: 'Newest' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/v2/journal?before=2026-10-05'));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Newest' }));
    await waitFor(() => expect(urls(fetchImpl).at(-1)).toBe('/api/v2/journal'));
  });

  it('offers no older page on the last one, and says when no day matches', async () => {
    const panel = mount(serving({ ...JOURNAL, days: [], next_before: null }));
    expect(await within(panel).findByText('No cycle days match.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Older' })).toBeNull();
  });

  it('shows why the server refused a search', async () => {
    const panel = mount(serving({ error: 'from is after to' }, 400));
    expect(await within(panel).findByText('Could not read it: from is after to.')).toBeTruthy();
  });
});
