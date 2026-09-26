// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { DASHBOARD_TOKEN_STORAGE_KEY } from './lib/dashboard-token.ts';
import { jsonResponse, overview } from './test-wire.ts';

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it('takes the token from the URL, removes it, and polls the overview with it', async () => {
    window.history.replaceState(null, '', '/?token=secret-token#today');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overview()));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Loss budget' })).toBeTruthy());
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#today');
    expect(window.sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY)).toBe('secret-token');
    expect(fetchImpl.mock.calls[0]).toEqual([
      '/api/v2/overview',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    ]);
  });

  it('shows the Today panels under the status strip, and falls back to Today on an unknown hash', async () => {
    window.history.replaceState(null, '', '/#nowhere');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overview()));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole('region', { name: "Today's decisions" })).toBeTruthy());
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
      'Halt and pause',
      'Loss budget',
      'Positions and cash',
      "Today's decisions",
    ]);
    expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows no panel before the first good response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('token'));
    expect(screen.queryByRole('region', { name: 'Loss budget' })).toBeNull();
  });
});
