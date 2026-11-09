// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { DASHBOARD_TOKEN_STORAGE_KEY } from './lib/dashboard-token.ts';
import { evidence, JOURNAL, jsonResponse, overview, research } from './test-wire.ts';

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it('takes the token from the URL, removes it, and polls the overview with it', async () => {
    window.history.replaceState(null, '', '/?token=secret-token#glance');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overview()));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Loss budget' })).toBeTruthy());
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#glance');
    expect(window.sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY)).toBe('secret-token');
    expect(fetchImpl.mock.calls[0]).toEqual([
      '/api/v2/overview',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-token' } }),
    ]);
  });

  it('shows the Glance panels beside the rail, and falls back to Glance on an unknown hash', async () => {
    window.history.replaceState(null, '', '/#nowhere');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overview()));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Positions and cash' })).toBeTruthy(),
    );
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
    ).toEqual([
      'Halt and pause',
      'P&L',
      'Open risk',
      'Verdicts',
      'Loss budget',
      'Positions and cash',
    ]);
    expect(screen.getByText('LLM cap')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Glance' }).getAttribute('aria-current')).toBe('page');
  });

  it('switches to Live and Review on the hash, fetching the routes of each view', async () => {
    const bodies: Record<string, unknown> = {
      '/api/v2/overview': overview(),
      '/api/v2/evidence': evidence(),
      '/api/v2/journal': JOURNAL,
      '/api/v2/research': research(),
      '/api/v2/reconcile': { contract_version: JOURNAL.contract_version, reconcile: {} },
      '/api/v2/tax': {
        contract_version: JOURNAL.contract_version,
        year: 2026,
        years: [],
        disposals: { status: 'empty' },
        cfd_disposals: { status: 'empty' },
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) => jsonResponse(bodies[String(url)]));
    render(<App fetchImpl={fetchImpl} />);
    await screen.findByRole('region', { name: 'Loss budget' });

    act(() => {
      window.location.hash = '#live';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('region', { name: "Today's decisions" });
    expect(screen.queryByRole('region', { name: 'Loss budget' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Live' }).getAttribute('aria-current')).toBe('page');

    act(() => {
      window.location.hash = '#review';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('region', { name: 'Debate G1 progress' });
    await screen.findByRole('region', { name: 'LLM spend' });
    await screen.findByRole('article', { name: 'Cycle 2026-10-05' });
    expect(screen.queryByRole('region', { name: "Today's decisions" })).toBeNull();
    const asked = new Set(fetchImpl.mock.calls.map(([url]) => String(url)));
    expect([...asked].sort()).toEqual(Object.keys(bodies).sort());
  });

  it('shows no panel before the first good response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('token'));
    expect(screen.queryByRole('region', { name: 'Loss budget' })).toBeNull();
  });
});
