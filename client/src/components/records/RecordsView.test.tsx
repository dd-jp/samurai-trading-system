// @vitest-environment jsdom
import type { LlmSpendWire, PanelWire, V2OverviewWire } from '@contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PollState } from '../../hooks/usePoll.ts';
import { JOURNAL, jsonResponse, overview, research } from '../../test-wire.ts';
import { RecordsView } from './RecordsView.tsx';

const RECONCILE = {
  contract_version: JOURNAL.contract_version,
  reconcile: { status: 'not-yet-fed', owner: 'Step 4 / Step 3e', ticket: '#1784' },
};
const TAX = {
  contract_version: JOURNAL.contract_version,
  year: null,
  disposals: { status: 'not-yet-fed', owner: 'Step 4', ticket: '#1746' },
};

function routes(researchBody: unknown = research()): typeof fetch {
  const bodies: Record<string, unknown> = {
    '/api/v2/journal': JOURNAL,
    '/api/v2/research': researchBody,
    '/api/v2/reconcile': RECONCILE,
    '/api/v2/tax': TAX,
  };
  return vi.fn<typeof fetch>().mockImplementation(async (url) => jsonResponse(bodies[String(url)]));
}

const SPEND = overview().llm_spend;

function served(llmSpend: PanelWire<LlmSpendWire>): PollState<V2OverviewWire> {
  return {
    data: { ...overview(), llm_spend: llmSpend },
    status: 'ok',
    error: null,
    lastSuccessAt: 1,
  };
}

function mount(
  fetchImpl: typeof fetch,
  llmSpend: PanelWire<LlmSpendWire> = SPEND,
  overviewState: PollState<V2OverviewWire> = served(llmSpend),
) {
  render(<RecordsView token="tok" options={{ fetchImpl }} overview={overviewState} />);
}

describe('RecordsView (P9–P13)', () => {
  it('lists the trial ledger with its total and the unruled loop steps (P10)', async () => {
    mount(routes());
    await screen.findByText('2 trials in total (the DSR deflator)');
    const panel = screen.getByRole('region', { name: 'Research loop' });
    expect(within(panel).getByRole('row', { name: 'trend 2' })).toBeTruthy();
    expect(within(panel).getByRole('row', { name: /^1 trend h1 backtest/ }).textContent).toBe(
      '1trendh1backtest2026-10-01 09:00Z',
    );
    for (const step of ['Proposals', 'Promotions', 'Demotions']) {
      expect(panel.textContent).toContain(`${step}: Not yet fed: G11 not ruled (#1717).`);
    }
  });

  it('says when no trial is recorded (P10)', async () => {
    mount(routes(research({ ledger: { status: 'empty' } })));
    expect(await screen.findByText('No trials recorded yet.')).toBeTruthy();
  });

  it('names the owner of an unfed ledger (P10)', async () => {
    const owner = { status: 'not-yet-fed', owner: 'research store', ticket: '#1785' } as const;
    mount(routes(research({ ledger: owner })));
    await screen.findByText('Not yet fed: research store (#1785).');
  });

  it('says when no LLM call is recorded (P11)', () => {
    mount(routes(), { status: 'empty' });
    expect(screen.getByRole('region', { name: 'LLM spend' }).textContent).toContain(
      'No LLM calls this month.',
    );
  });

  it('names the owner of unfed LLM spend (P11)', () => {
    mount(routes(), { status: 'not-yet-fed', owner: 'Step 3', ticket: '#1745' });
    expect(screen.getByRole('region', { name: 'LLM spend' }).textContent).toContain(
      'Not yet fed: Step 3 (#1745).',
    );
  });

  it('shows month-to-date LLM spend against the cap, per model and per day (P11)', async () => {
    mount(routes(), {
      status: 'fed',
      month_start: '2026-10-01T00:00:00.000Z',
      spent_usd: 4.2,
      budget_usd: 30,
      calls_stopped: false,
      by_model: [{ model: 'claude-sonnet-5', cost_usd: 3 }],
      by_day: [{ day: '2026-10-05', cost_usd: 1.2 }],
    });
    const panel = screen.getByRole('region', { name: 'LLM spend' });
    expect(panel.textContent).toContain('$4.20 of $30.00 since 2026-10-01');
    expect(within(panel).getByRole('table', { name: 'By model' }).textContent).toContain(
      'claude-sonnet-5$3.00',
    );
    expect(within(panel).getByRole('table', { name: 'By day' }).textContent).toContain(
      '2026-10-05$1.20',
    );
    expect(within(panel).queryByRole('note')).toBeNull();
  });

  it('says when the cap has stopped calls (P11)', () => {
    const fed = { ...SPEND, status: 'fed' } as Extract<PanelWire<LlmSpendWire>, { status: 'fed' }>;
    mount(routes(), { ...fed, calls_stopped: true });
    expect(screen.getByRole('note').textContent).toBe(
      'The cap has stopped LLM calls. Exits are unaffected.',
    );
  });

  it('reads an unreadable spend as refusing calls, once', () => {
    const fed = { ...SPEND, status: 'fed' } as Extract<PanelWire<LlmSpendWire>, { status: 'fed' }>;
    mount(routes(), { ...fed, spent_usd: null, calls_stopped: true });
    const panel = screen.getByRole('region', { name: 'LLM spend' });
    expect(
      within(panel)
        .getAllByRole('note')
        .map((note) => note.textContent),
    ).toEqual(['The spend could not be read, so LLM calls are refused. Exits are unaffected.']);
    expect(panel.textContent).toContain('— of $30.00');
  });

  it('shows the journal while the overview cannot be read, and says so on LLM spend', async () => {
    mount(routes(), SPEND, {
      data: null,
      status: 'failed',
      error: 'store unavailable',
      lastSuccessAt: null,
    });
    await screen.findByRole('article', { name: 'Cycle 2026-10-05' });
    expect(screen.getByRole('region', { name: 'LLM spend' }).textContent).toBe(
      'LLM spendCould not read it: store unavailable.',
    );
  });

  it('shows reconcile and tax as owned by their steps (P12, P13)', async () => {
    mount(routes());
    await screen.findByText('Not yet fed: Step 4 / Step 3e (#1784).');
    await screen.findByText('Not yet fed: Step 4 (#1746).');
    expect(screen.getByRole('region', { name: 'Reconcile diffs' }).dataset.status).toBe(
      'not-yet-fed',
    );
    const tax = screen.getByRole('region', { name: 'Tax export' });
    expect(tax.textContent).toContain('CSV download');
    expect(within(tax).queryByRole('link')).toBeNull();
  });

  it('holds each fetched panel in a loading state until its route answers', () => {
    mount(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)));
    for (const name of ['Research loop', 'Reconcile diffs', 'Tax export']) {
      expect(screen.getByRole('region', { name }).textContent).toBe(`${name}Loading…`);
    }
  });
});
