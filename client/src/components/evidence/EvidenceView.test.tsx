// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS } from '../../hooks/usePoll.ts';
import { evidence, jsonResponse } from '../../test-wire.ts';
import { EvidenceView } from './EvidenceView.tsx';

afterEach(() => vi.useRealTimers());

function region(name: string) {
  return screen.getByRole('region', { name });
}

async function shown(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, status));
  render(<EvidenceView token="tok" options={{ fetchImpl }} />);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  return fetchImpl;
}

describe('EvidenceView (P5–P8)', () => {
  it('reads the evidence route with the token', async () => {
    const fetchImpl = await shown(evidence());
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v2/evidence');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('shows each book risk-adjusted, primary first, with its equity curve (P5)', async () => {
    await shown(evidence());
    const panel = await screen.findByRole('region', { name: 'Sleeve vs benchmark' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'debate/primary31.23−5.0%',
      '↳ no-veto (shadow)3—0.0%—',
    ]);
    expect(
      within(panel).getByRole('img', {
        name: 'debate/primary equity, £2,000.00 on 2026-10-01 to £1,940.00 on 2026-10-05',
      }),
    ).toBeTruthy();
    expect(panel.textContent).toContain('vs arm 2: Not yet fed: arm 2 (#1773).');
    expect(panel.textContent).toContain(
      'vs risk-matched buy-and-hold: Not yet fed: Step 1b (#1785).',
    );
  });

  it('shows a null Sharpe as unknown, not zero', async () => {
    await shown(evidence());
    const panel = await screen.findByRole('region', { name: 'Sleeve vs benchmark' });
    const shadow = within(panel).getByRole('row', { name: /no-veto/ });
    expect(within(shadow).getAllByRole('cell')[1]?.textContent).toBe('—');
  });

  it('counts closed trades toward G1 and names the arm 2 test owner (P6)', async () => {
    await shown(evidence());
    const panel = await screen.findByRole('region', { name: 'Debate G1 progress' });
    expect(within(panel).getByRole('row', { name: /debate\/primary/ }).textContent).toContain(
      '12 of 100',
    );
    expect(
      within(panel).getByRole('progressbar', { name: 'debate/primary: 12 of 100 closed trades' }),
    ).toBeTruthy();
    expect(panel.textContent).toContain('One-sided 95% test vs arm 2: Not yet fed: arm 2 (#1773).');
  });

  it('splits the closed trades by entry offset and by model pins (#1815, #1747)', async () => {
    await shown(evidence());
    const panel = await screen.findByRole('region', { name: 'Debate G1 progress' });
    const cells = within(within(panel).getByRole('row', { name: /debate\/primary/ })).getAllByRole(
      'cell',
    );
    expect(cells.slice(-2).map((cell) => cell.textContent)).toEqual([
      '0 bps: 3, 50 bps: 12',
      'no digest: 4, 0123456789abcdef: 11',
    ]);
  });

  it('names an untagged offset', async () => {
    await shown(
      evidence({
        trade_count: {
          status: 'fed',
          target: 100,
          books: [
            {
              book_id: 'debate/primary',
              variant: 'primary',
              closed_trades: 1,
              by_entry_offset: [{ entry_offset_bps: null, closed_trades: 1 }],
              by_model_pins: [{ pin_digest: null, closed_trades: 1 }],
            },
          ],
        },
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Debate G1 progress' });
    expect(panel.textContent).toContain('no offset: 1');
  });

  it('shows the band and gate as owned by their steps (P7, P8)', async () => {
    await shown(evidence());
    const band = await screen.findByRole('region', { name: 'Live-vs-backtest band' });
    expect(band.textContent).toContain('Not yet fed: Step 1b (#1785).');
    expect(band.textContent).toContain('forward paper');
    expect(region('Gate statistics').textContent).toContain(
      'Not yet fed: Step 1b and Step 4 (#1785).',
    );
  });

  it('says so when nothing is recorded yet', async () => {
    await shown(evidence({ performance: { status: 'empty' }, trade_count: { status: 'empty' } }));
    expect(
      (await screen.findByRole('region', { name: 'Sleeve vs benchmark' })).textContent,
    ).toContain('No recorded cycle days yet.');
    expect(region('Debate G1 progress').textContent).toContain('No closed paper trades yet.');
  });

  it('names the owner of a panel the server does not feed yet', async () => {
    const owner = { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' } as const;
    await shown(evidence({ performance: owner, trade_count: owner }));
    await screen.findByRole('region', { name: 'Sleeve vs benchmark' });
    for (const name of ['Sleeve vs benchmark', 'Debate G1 progress']) {
      expect(region(name).dataset.status).toBe('not-yet-fed');
      expect(region(name).textContent).toContain('Not yet fed: Step 1b (#1785).');
    }
  });

  it('says it is loading, then why it could not read the route', async () => {
    await shown({ error: 'store unavailable' }, 503);
    expect(
      await within(region('Evidence')).findByText('Could not read it: store unavailable.'),
    ).toBeTruthy();
  });

  it('keeps the last good read when a later poll fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(evidence()))
      .mockResolvedValueOnce(jsonResponse({ error: 'store unavailable' }, 503));
    render(<EvidenceView token="tok" options={{ fetchImpl }} />);
    const panel = await screen.findByRole('region', { name: 'Sleeve vs benchmark' });
    await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
    await waitFor(() =>
      expect(panel.textContent).toContain(
        'Could not read it: store unavailable. Showing the last good read.',
      ),
    );
    expect(within(panel).getAllByRole('row')).toHaveLength(3);
  });
});
