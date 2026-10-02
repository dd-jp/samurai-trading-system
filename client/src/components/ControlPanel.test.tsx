// @vitest-environment jsdom
import { V2_CONTRACT_VERSION } from '@contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL, jsonResponse } from '../test-wire.ts';
import { ControlPanel, type ControlPanelProps } from './ControlPanel.tsx';

const PAUSE_ROW = {
  control_id: 7,
  action: 'pause' as const,
  reason: 'earnings week',
  source: 'dashboard 127.0.0.1',
  set_at: '2026-10-06T09:00:00.000Z',
};

function recorded(replayed = false) {
  return jsonResponse(
    { contract_version: V2_CONTRACT_VERSION, control: PAUSE_ROW, replayed },
    replayed ? 200 : 201,
  );
}

function setup(props: Partial<ControlPanelProps> = {}) {
  const fetchImpl = vi.fn<typeof fetch>();
  const onRecorded = vi.fn();
  let n = 0;
  render(
    <ControlPanel
      control={CONTROL}
      token="tok"
      fetchImpl={fetchImpl}
      newKey={() => `key-000${++n}`}
      onRecorded={onRecorded}
      {...props}
    />,
  );
  return { fetchImpl, onRecorded };
}

function typeReason(value: string) {
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value } });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('ControlPanel (P2)', () => {
  it('offers pause and halt while running, and no resume, approve or sign-off', () => {
    setup();
    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Pause entries',
      'Halt: flat at next fill',
    ]);
  });

  it('refuses to send without a reason', () => {
    const { fetchImpl } = setup();
    typeReason('   ');
    fireEvent.click(screen.getByRole('button', { name: 'Halt: flat at next fill' }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('A reason is required.');
  });

  it('posts the control with the token, then says it takes effect at the next cycle', async () => {
    const { fetchImpl, onRecorded } = setup();
    fetchImpl.mockResolvedValueOnce(recorded());
    typeReason('  earnings week ');
    fireEvent.click(screen.getByRole('button', { name: 'Pause entries' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/controls');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(sentBody(fetchImpl)).toEqual({
      action: 'pause',
      reason: 'earnings week',
      idempotency_key: 'key-0001',
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Recorded: pause #7. It takes effect at the next cycle.',
    );
    expect((screen.getByLabelText('Reason') as HTMLInputElement).value).toBe('');
  });

  it('says a recorded halt closes positions within about a minute while the signals process runs', async () => {
    const { fetchImpl, onRecorded } = setup();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(
        {
          contract_version: V2_CONTRACT_VERSION,
          control: { ...PAUSE_ROW, control_id: 8, action: 'halt' },
          replayed: false,
        },
        201,
      ),
    );
    typeReason('shock');
    fireEvent.click(screen.getByRole('button', { name: 'Halt: flat at next fill' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
    expect(screen.getByRole('status').textContent).toBe(
      'Recorded: halt #8. Positions close within about a minute, or at the next cycle if the signals process is down.',
    );
  });

  it('retries a failed send with the same key, and takes a new key for a different control', async () => {
    const { fetchImpl, onRecorded } = setup();
    fetchImpl.mockRejectedValueOnce(new Error('network down'));
    typeReason('earnings week');
    fireEvent.click(screen.getByRole('button', { name: 'Pause entries' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('network down'));
    fetchImpl.mockResolvedValueOnce(recorded(true));
    fireEvent.click(screen.getByRole('button', { name: 'Pause entries' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
    expect(sentBody(fetchImpl, 1).idempotency_key).toBe('key-0001');
    expect(screen.getByRole('status').textContent).toContain('Already recorded: pause #7');

    fetchImpl.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 409));
    typeReason('earnings week');
    fireEvent.click(screen.getByRole('button', { name: 'Halt: flat at next fill' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Refused: nope.'));
    expect(sentBody(fetchImpl, 2)).toMatchObject({ action: 'halt', idempotency_key: 'key-0002' });
  });

  it('says when to retry after the rate limit, and when the token is rejected', async () => {
    const { fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 429, { 'Retry-After': '7' }));
    typeReason('shock');
    fireEvent.click(screen.getByRole('button', { name: 'Halt: flat at next fill' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'One control per 10 seconds: try again in 7 s.',
      ),
    );
    fetchImpl.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    fireEvent.click(screen.getByRole('button', { name: 'Halt: flat at next fill' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('The dashboard token was rejected.'),
    );
  });

  it('shows the control in force, offers resume, and lists the history', () => {
    setup({
      control: {
        state: 'paused',
        in_force: PAUSE_ROW,
        loss_budget_halted_books: [],
        history: [PAUSE_ROW],
      },
    });
    expect(screen.getByText('PAUSED')).toBeTruthy();
    expect(
      screen.getByText(/since 2026-10-06 09:00Z from dashboard 127\.0\.0\.1: earnings week/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText('Control history (1)')).toBeTruthy();
  });

  it('says resume cannot lift a loss-budget halt', () => {
    setup({
      control: {
        state: 'halted-loss-budget',
        in_force: null,
        loss_budget_halted_books: ['debate/primary'],
        history: [],
      },
    });
    expect(screen.getByText('HALTED (loss budget)')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(
      'The loss budget has halted debate/primary. Resume does not lift it.',
    );
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });
});
