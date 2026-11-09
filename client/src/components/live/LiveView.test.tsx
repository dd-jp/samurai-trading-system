// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JOURNAL, jsonResponse, overview } from '../../test-wire.ts';
import { LiveView } from './LiveView.tsx';

function trace(): HTMLElement {
  return screen.getByRole('region', { name: 'Trace' });
}

function show(body: unknown = JOURNAL) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
  render(<LiveView overview={overview()} token="t" options={{ fetchImpl }} />);
  return fetchImpl;
}

function select(instrument: string) {
  fireEvent.click(screen.getByRole('button', { name: instrument }));
}

describe('LiveView', () => {
  it('asks for a selection until a decision is picked', async () => {
    const fetchImpl = show();
    await waitFor(() => expect(trace().textContent).toContain('Select a decision'));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/v2/journal');
  });

  it('opens the journal trace of the selected decision and marks it pressed', async () => {
    show();
    await waitFor(() => expect(trace().textContent).toContain('Select a decision'));
    select('AAPL');
    const panel = within(trace());
    expect(panel.getByText('vetoed:earnings')).toBeTruthy();
    expect(panel.getByText('debate-9')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AAPL' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says so when the decision is not on the newest journal page', async () => {
    show({ ...JOURNAL, days: [] });
    await waitFor(() => expect(trace().textContent).toContain('Select a decision'));
    select('AAPL');
    expect(trace().textContent).toContain('not on the newest journal page');
  });

  it('tells two decisions on one instrument apart by id', async () => {
    const day = JOURNAL.days[0];
    const decision = day?.decisions[0];
    if (day === undefined || decision === undefined) throw new Error('fixture changed');
    show({
      ...JOURNAL,
      days: [
        {
          ...day,
          decisions: [{ ...decision, decision_id: 'd-0', reason: 'the other signal' }, decision],
        },
      ],
    });
    await waitFor(() => expect(trace().textContent).toContain('Select a decision'));
    select('AAPL');
    expect(trace().textContent).toContain('vetoed:earnings');
    expect(trace().textContent).not.toContain('the other signal');
  });

  it('shows the feed problem when the journal cannot be read', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 503));
    render(<LiveView overview={overview()} token="t" options={{ fetchImpl }} />);
    await waitFor(() => expect(trace().textContent).toContain('Could not read it'));
  });
});
