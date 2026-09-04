// @vitest-environment jsdom
/**
 * The shell: one poll feeds a rail and three tabs. These tests cover what a
 * screenshot cannot — the words in accessible names, the honest empty
 * states, focus surviving a poll, and a hostile string rendering inert —
 * against a fake `fetch`, so nothing here touches a network.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { doneThrough, makeLane, makeView } from './lib/test-support.ts';
import {
  fakeFetch,
  makeCondition,
  makeRiskCritic,
  makeSnapshot,
  makeSpend,
  makeVerdict,
} from './test-fixtures.ts';

const POLL_MS = 20;

function renderApp(payloads: Parameters<typeof fakeFetch>[0]) {
  return render(<App snapshotOptions={{ fetchImpl: fakeFetch(payloads), intervalMs: POLL_MS }} />);
}

function laneView() {
  const btc = makeLane({
    instrument: 'BTC-USD',
    trace_id: 'trace-btc',
    outcome: 'in_flight',
    final_stage: 'debate',
    started_at: '2026-08-07T11:59:49.000Z',
    cells: {
      analysts: { state: 'done', recorded_at: '2026-08-07T11:59:50.000Z', duration_ms: 1_000 },
      debate: { state: 'live' },
    },
  });
  const qqq = makeLane({
    instrument: 'QQQ',
    trace_id: 'trace-qqq',
    asset_class: 'stocks',
    outcome: 'stopped',
    final_stage: 'risk',
    started_at: '2026-08-07T11:58:00.000Z',
    total_ms: 31_000,
    cells: {
      analysts: { state: 'done', recorded_at: '2026-08-07T11:58:01.000Z', duration_ms: 1_300 },
      debate: { state: 'done', recorded_at: '2026-08-07T11:58:25.000Z', duration_ms: 24_100 },
      trader: { state: 'done', recorded_at: '2026-08-07T11:58:28.000Z', duration_ms: 3_000 },
      risk: {
        state: 'stopped',
        recorded_at: '2026-08-07T11:58:31.000Z',
        duration_ms: 2_600,
        decision: 'rejected · exposure cap',
      },
    },
  });
  const spy = makeLane({ instrument: 'SPY', asset_class: 'stocks', outcome: 'idle' });
  return makeView([btc, qqq, spy], {
    live_trace_id: 'trace-btc',
    live_entered_at: '2026-08-07T11:59:50.000Z',
  });
}

function openTab(name: 'Glance' | 'Live' | 'Review') {
  fireEvent.click(screen.getByRole('tab', { name }));
}

afterEach(() => {
  window.history.replaceState(null, '', '#');
});

describe('rail', () => {
  it('reads ALIVE with the poll clock, PAPER, the live tick and both providers', async () => {
    renderApp([
      makeSnapshot({
        pipeline: laneView(),
        tick_status: {
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          stage: 'debate',
          trace_id: 'trace-btc',
        },
      }),
    ]);
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText('ALIVE')).toBeTruthy();
    expect(within(rail).getByText('polled 12:00:00Z')).toBeTruthy();
    expect(within(rail).getByText('PAPER')).toBeTruthy();
    expect(within(rail).getByText(/BTC-USD · debate · since 11:59:50Z/)).toBeTruthy();
    expect(within(rail).getByText('trace-btc')).toBeTruthy();
    expect(within(rail).getAllByText('ok')).toHaveLength(2);
    expect(within(rail).getByRole('img', { name: /LLM budget used/ })).toBeTruthy();
    expect(within(rail).getByRole('img', { name: /max drawdown .* index tolerance/ })).toBeTruthy();
  });

  it('marks the page STALE after two missed polls and keeps the last clock', async () => {
    renderApp([makeSnapshot(), null]);
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    await within(rail).findByText('ALIVE');
    await waitFor(() => expect(within(rail).getByText('STALE')).toBeTruthy(), {
      timeout: 2_000,
    });
    expect(rail.getAttribute('data-stale')).toBe('true');
    expect(within(rail).getByRole('status').textContent).toMatch(/^stale — last update 12:00:00Z/);
    expect(within(rail).getByText('snapshot 12:00:00Z')).toBeTruthy();
  });

  it('renders "mode unknown" when the wire carries no mode, never "paper"', async () => {
    const snapshot = makeSnapshot();
    delete (snapshot as { mode?: unknown }).mode;
    renderApp([snapshot]);
    expect(await screen.findByText('mode unknown')).toBeTruthy();
    expect(screen.queryByText('PAPER')).toBeNull();
  });

  it('reads live, not idle, when a trace is running but tick_status is absent', async () => {
    renderApp([makeSnapshot({ pipeline: laneView(), tick_status: null })]);
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText(/live — a trace is running/)).toBeTruthy();
    expect(within(rail).queryByText(/idle — no tick in progress/)).toBeNull();
  });

  it('degrades the LLM meter to words when the spend summary is missing or malformed', async () => {
    const snapshot = makeSnapshot();
    (snapshot as { llm_spend?: unknown }).llm_spend = [];
    renderApp([snapshot]);
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText(/meter not drawable/)).toBeTruthy();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
  });

  it('calls the meter a floor whenever unpriced calls exist', async () => {
    const spend = makeSpend();
    spend.all_time = { ...spend.all_time, unpriced_calls: 3 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    expect(await screen.findByText(/floor — 3 unpriced calls/)).toBeTruthy();
  });
});

describe('tabs', () => {
  it('opens on Glance, switches by tab, and reflects the tab in the hash', async () => {
    renderApp([makeSnapshot()]);
    expect(screen.getByRole('tab', { name: 'Glance' }).getAttribute('aria-selected')).toBe('true');
    await screen.findByRole('region', { name: 'P&L today' });
    openTab('Review');
    expect(window.location.hash).toBe('#review');
    expect(screen.getByRole('region', { name: 'Closed trades' })).toBeTruthy();
    openTab('Live');
    expect(screen.getByRole('region', { name: 'Lanes' })).toBeTruthy();
  });

  it('boots on the tab the hash names', async () => {
    window.history.replaceState(null, '', '#review');
    renderApp([makeSnapshot()]);
    expect(await screen.findByRole('region', { name: 'Closed trades' })).toBeTruthy();
  });
});

describe('glance → live', () => {
  it('stamps a settled lane into the verdict list once, and never again on a re-poll', async () => {
    const settled = doneThrough('ETH-USD', 'trace-eth', 'execution', { outcome: 'go' });
    const first = makeSnapshot({ pipeline: makeView([settled]) });
    const second = makeSnapshot({
      pipeline: makeView([settled]),
      as_of: '2026-08-07T12:00:03.000Z',
      generated_at: '2026-08-07T12:00:03.000Z',
    });
    renderApp([first, second]);
    const verdicts = await screen.findByRole('region', { name: 'Verdicts this session' });
    await within(verdicts).findByRole('button', { name: /ETH-USD, go/ });
    await screen.findByText('snapshot 12:00:03Z');
    expect(within(verdicts).getAllByRole('button', { name: /ETH-USD, go/ })).toHaveLength(1);
  });

  it('badges a HITL override and carries the verdict reason', async () => {
    const settled = doneThrough('ETH-USD', 'trace-eth', 'verdict', { outcome: 'no_go' });
    renderApp([
      makeSnapshot({
        pipeline: makeView([settled]),
        verdicts: [
          makeVerdict({
            trace_id: 'trace-eth',
            status: 'no_go',
            reason: 'drawdown gate',
            hitl_override: true,
          }),
        ],
      }),
    ]);
    const row = await screen.findByRole('button', {
      name: 'ETH-USD, no-go, human override, drawdown gate',
    });
    expect(within(row).getByText('HITL')).toBeTruthy();
  });

  it('opens the trace stamped on a verdict row on Live, not the instrument’s current one', async () => {
    const old = doneThrough('ETH-USD', 'trace-old', 'verdict', { outcome: 'no_go' });
    const current = doneThrough('ETH-USD', 'trace-new', 'execution', { outcome: 'go' });
    const first = makeSnapshot({
      pipeline: makeView([old]),
      verdicts: [makeVerdict({ trace_id: 'trace-old', status: 'no_go', reason: 'drawdown gate' })],
    });
    const second = makeSnapshot({
      pipeline: makeView([current]),
      as_of: '2026-08-07T12:00:03.000Z',
      generated_at: '2026-08-07T12:00:03.000Z',
      verdicts: [
        makeVerdict({ trace_id: 'trace-new', status: 'go', reason: 'approved' }),
        makeVerdict({ trace_id: 'trace-old', status: 'no_go', reason: 'drawdown gate' }),
      ],
    });
    renderApp([first, second]);
    await screen.findByText('snapshot 12:00:03Z');
    fireEvent.click(await screen.findByRole('button', { name: /ETH-USD, no-go/ }));
    expect(window.location.hash).toBe('#live');
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(within(drawer).getByText('trace-old')).toBeTruthy();
    expect(within(drawer).queryByText('trace-new')).toBeNull();
    expect(within(drawer).getByText(/aged out of the 15-minute pipeline window/)).toBeTruthy();
    expect(within(drawer).getByText(/drawdown gate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^ETH-USD, crypto, go/ }));
    expect(within(drawer).getByText('trace-new')).toBeTruthy();
    expect(within(drawer).getByRole('list', { name: 'Stage timeline' })).toBeTruthy();
  });
});

describe('live', () => {
  it('names every lane’s outcome and stage in words, and reads a stopped cell’s decision', async () => {
    renderApp([makeSnapshot({ pipeline: laneView() })]);
    openTab('Live');
    expect(
      await screen.findByRole('button', { name: 'BTC-USD, crypto, in flight, at Debate' }),
    ).toBeTruthy();
    const qqq = screen.getByRole('button', { name: 'QQQ, stocks, stopped, at Risk' });
    expect(within(qqq).getByText('rejected · exposure cap')).toBeTruthy();
    expect(within(qqq).getAllByText('not reached').length).toBeGreaterThan(0);
    const spy = screen.getByRole('button', { name: 'SPY, stocks, idle, no trace in the window' });
    expect(within(spy).getAllByText('idle')).toHaveLength(6);
    const btc = screen.getByRole('button', { name: /BTC-USD/ });
    expect(within(btc).getAllByText('wait')).toHaveLength(4);
  });

  it('shows the invalidation conditions of the selected trace, not the instrument’s other one', async () => {
    renderApp([
      makeSnapshot({
        pipeline: laneView(),
        risk_critics: [
          makeRiskCritic({
            trace_id: 'trace-qqq-older',
            instrument: 'QQQ',
            conditions: [makeCondition({ id: 'older-trace-condition' })],
          }),
          makeRiskCritic({
            trace_id: 'trace-qqq',
            instrument: 'QQQ',
            binding_constraint: 'risk_critic:invalidated',
            conditions: [makeCondition({ id: 'shown-trace-condition', observed: 401.25 })],
          }),
        ],
      }),
    ]);
    openTab('Live');
    fireEvent.click(await screen.findByRole('button', { name: /QQQ, stocks, stopped/ }));
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(drawer.querySelector('[data-condition="shown-trace-condition"]')).toBeTruthy();
    expect(drawer.querySelector('[data-condition="older-trace-condition"]')).toBeNull();
    expect(
      drawer.querySelector('[data-invalidation="binding"]')?.getAttribute('data-binding'),
    ).toBe('risk_critic:invalidated');
  });

  it('names its empty states: no selection, an idle lane, no debate, no Risk decision', async () => {
    renderApp([makeSnapshot({ pipeline: laneView(), debates: [], positions: [] })]);
    openTab('Live');
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(await within(drawer).findByText(/No lane selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /SPY, stocks, idle/ }));
    expect(within(drawer).getByText(/idle — no trace in the last 15 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /QQQ, stocks, stopped/ }));
    expect(drawer.querySelector('[data-invalidation="no-decision"]')).toBeTruthy();
    expect(within(drawer).getByText(/no completed debate recorded/i)).toBeTruthy();
    expect(within(drawer).getByText(/No open position for this instrument/)).toBeTruthy();
    expect(within(drawer).getAllByText(/no decision word recorded \(#328\)/).length).toBe(1);
  });

  it('keeps keyboard focus on a lane across a poll', async () => {
    const view = laneView();
    renderApp([
      makeSnapshot({ pipeline: view }),
      makeSnapshot({
        pipeline: view,
        as_of: '2026-08-07T12:00:03.000Z',
        generated_at: '2026-08-07T12:00:03.000Z',
      }),
    ]);
    openTab('Live');
    const lane = await screen.findByRole('button', { name: /QQQ, stocks, stopped/ });
    lane.focus();
    await screen.findByText('snapshot 12:00:03Z');
    expect(document.activeElement).toBe(lane);
  });

  it('renders a hostile instrument string as inert text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const lane = doneThrough(hostile, 'trace-x', 'verdict', { outcome: 'no_go' });
    renderApp([makeSnapshot({ pipeline: makeView([lane]), positions: [], debates: [] })]);
    openTab('Live');
    const button = await screen.findByRole('button', { name: /img src=x/ });
    const name = button.querySelector('.lane-instrument');
    expect(name?.textContent).toBe(hostile);
    expect(name?.childElementCount).toBe(0);
    expect(document.querySelectorAll('img, script').length).toBe(0);
  });
});
