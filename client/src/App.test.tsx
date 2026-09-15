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
  HANGS,
  makeCondition,
  makeDebate,
  makePosition,
  makeRiskCritic,
  makeSnapshot,
  makeSpend,
  makeVerdict,
} from './test-fixtures.ts';

const POLL_MS = 20;

function renderApp(payloads: Parameters<typeof fakeFetch>[0], now?: () => number) {
  return render(
    <App snapshotOptions={{ fetchImpl: fakeFetch(payloads), intervalMs: POLL_MS, now }} />,
  );
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

async function openTab(name: 'Glance' | 'Live' | 'Review') {
  // Awaited: since #1520 the tablist does not exist until the first snapshot
  // lands — the page is the cold-start state until then.
  fireEvent.click(await screen.findByRole('tab', { name }));
}

afterEach(() => {
  window.history.replaceState(null, '', '#');
});

describe('rail', () => {
  it('reads ALIVE with the poll clock, PAPER, the live tick and both providers', async () => {
    // The snapshot's own `generated_at` stays at the fixture default
    // (12:00:00Z, via `makeSnapshot`) while the injected client clock reads a
    // different instant — the poll clock and the snapshot clock must read
    // their own sources rather than coincide because a test happened not to
    // vary them (#1166).
    renderApp(
      [
        makeSnapshot({
          pipeline: laneView(),
          tick_status: {
            instrument: 'BTC-USD',
            asset_class: 'crypto',
            stage: 'debate',
            trace_id: 'trace-btc',
          },
        }),
      ],
      () => Date.parse('2026-08-07T12:00:05.000Z'),
    );
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText('ALIVE')).toBeTruthy();
    expect(within(rail).getByText('polled 12:00:05Z')).toBeTruthy();
    expect(within(rail).queryByText('polled 12:00:00Z')).toBeNull();
    expect(within(rail).getByText('PAPER')).toBeTruthy();
    expect(within(rail).getByText(/BTC-USD · debate · since 11:59:50Z/)).toBeTruthy();
    expect(within(rail).getByText('trace-btc')).toBeTruthy();
    expect(within(rail).getAllByText('ok')).toHaveLength(2);
    const balance = rail.querySelector('[data-field="alpaca-balance"]');
    expect([...(balance?.children ?? [])].map((row) => row.textContent)).toEqual([
      'Equity$100,112.98',
      'Cash$99,213.40',
      'Buying power$198,426.80',
    ]);
    expect(within(rail).getByText('Alpaca · account reachable')).toBeTruthy();
    expect(within(rail).getByRole('img', { name: /LLM budget used/ })).toBeTruthy();
    expect(within(rail).getByText(/^24h \$.* · 7d \$.* · all \$/)).toBeTruthy();
    expect(within(rail).getByRole('img', { name: /max drawdown .* index tolerance/ })).toBeTruthy();
  });

  it('marks the page STALE after two missed polls and keeps the last clock', async () => {
    renderApp([makeSnapshot(), null]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    await within(rail).findByText('ALIVE');
    await waitFor(() => expect(within(rail).getByText('STALE')).toBeTruthy(), {
      timeout: 2_000,
    });
    expect(rail.getAttribute('data-stale')).toBe('true');
    expect(within(rail).getByRole('status').textContent).toMatch(/^stale — last update 12:00:00Z/);
    expect(within(rail).getByText('snapshot 12:00:00Z')).toBeTruthy();
  });

  it('renders "mode unknown" when the wire carries no mode, never "paper"', async () => {
    const withoutMode = Object.fromEntries(
      Object.entries(makeSnapshot()).filter(([key]) => key !== 'mode'),
    );
    renderApp([withoutMode]);
    expect(await screen.findByText('mode unknown')).toBeTruthy();
    expect(screen.queryByText('PAPER')).toBeNull();
  });

  it('reads live, not idle, when a trace is running but tick_status is absent', async () => {
    renderApp([makeSnapshot({ pipeline: laneView(), tick_status: null })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText(/live — a trace is running/)).toBeTruthy();
    expect(within(rail).queryByText(/idle — no tick in progress/)).toBeNull();
  });

  it('degrades the LLM meter to words when the spend summary is missing or malformed', async () => {
    renderApp([{ ...makeSnapshot(), llm_spend: [] }]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(
      await within(rail).findByText('no spend figure on this snapshot — meter not drawable'),
    ).toBeTruthy();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
  });

  // A snapshotless client knows nothing about the operator's budget: claiming
  // it was never armed, or that it's deliberately uncapped, is as false as
  // drawing a meter against an invented one — "unknown" must outrank both
  // (#1140's priority order, sharpened by #1196's two new claims it could
  // make from zero information). Since #1520 the page answers this by not
  // rendering the meter at all before the first snapshot, which is the same
  // claim made one level up.
  it('does not claim the budget is armed, unarmed, or uncapped before the first poll lands', () => {
    renderApp([HANGS]);

    expect(screen.queryByRole('img', { name: /LLM budget used/ })).toBeNull();
    expect(screen.queryByText(/never armed/)).toBeNull();
    expect(screen.queryByText(/deliberately uncapped/)).toBeNull();
    expect(screen.queryByText(/meter not drawable/)).toBeNull();
  });

  it('degrades the LLM meter to words when the wire carries no spend summary at all', async () => {
    const withoutSpend = Object.fromEntries(
      Object.entries(makeSnapshot()).filter(([key]) => key !== 'llm_spend'),
    );
    renderApp([withoutSpend]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(
      within(rail).getByText('no spend figure on this snapshot — meter not drawable'),
    ).toBeTruthy();
    expect(within(rail).queryByText(/never armed/)).toBeNull();
    expect(within(rail).queryByText(/deliberately uncapped/)).toBeNull();
  });

  // #1140: the denominator is the enforcer's, so a raised budget must move the
  // meter — with a client-side constant this test reads $50 whatever the wire
  // says, which is the defect.
  it('draws the meter against the cap the wire carries, not a fixed figure', async () => {
    const spend = makeSpend({ cap_usd: 200 });
    spend.all_time = { ...spend.all_time, cost_usd: 50 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(await within(rail).findByText('$50.00 / $200.00')).toBeTruthy();
    expect(
      within(rail).getByRole('img', { name: 'LLM budget used: 25.0% of the $200.00 cap' }),
    ).toBeTruthy();
    expect(within(rail).queryByText(/over cap/)).toBeNull();
  });

  it('says over cap only against the enforced cap, never a stale one', async () => {
    const spend = makeSpend({ cap_usd: 20 });
    spend.all_time = { ...spend.all_time, cost_usd: 25 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(await within(rail).findByText(/over cap/)).toBeTruthy();
  });

  // #1196: an armed-uncapped run (the wire's `cap_usd: null` PLUS a non-null
  // `cap_armed_at`) is a deliberate operator choice, not an absent or unarmed
  // one — the rail must say so, never "never armed" or "ambiguous".
  it('names the reason instead of drawing a meter when the run is armed uncapped', async () => {
    renderApp([makeSnapshot({ llm_spend: makeSpend({ cap_usd: null }) })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(
      await within(rail).findByText('LLM spend is deliberately uncapped — meter not drawable'),
    ).toBeTruthy();
    expect(within(rail).queryByText(/never armed/)).toBeNull();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
    expect(within(rail).queryByText(/over cap/)).toBeNull();
  });

  // Review round 3's MAJOR, reproduced exactly: a real, enforced cap
  // serialized as a string (e.g. by a corrupted `budget_usd` column,
  // `SqliteLlmSpendCapStore.read()`) alongside an intact `cap_armed_at` must
  // not render as "deliberately uncapped" — that claim comes from `cap_usd`
  // being EXPLICITLY `null`, and a malformed `cap_usd` is a different fact
  // entirely: this client could not read it, not that the wire said so.
  it('names the cap unreadable, never "deliberately uncapped", when cap_usd is malformed', async () => {
    const spend = { ...makeSpend({ cap_usd: 50 }) };
    // @ts-expect-error simulating a malformed wire value (e.g. corrupted storage)
    spend.cap_usd = '50';
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(
      await within(rail).findByText(
        'LLM spend cap on this snapshot could not be read — meter not drawable',
      ),
    ).toBeTruthy();
    expect(within(rail).queryByText(/deliberately uncapped/)).toBeNull();
    expect(within(rail).queryByText(/never armed/)).toBeNull();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
    expect(within(rail).queryByText(/over cap/)).toBeNull();
  });

  // #1196's core acceptance criterion: "never armed" (no row was ever
  // written) must read differently from "armed uncapped" (a deliberate
  // operator choice) — collapsing both into the same sentence is the defect.
  it('names "never armed" distinctly from "armed uncapped", and never claims a budget is merely unconfigured', async () => {
    renderApp([makeSnapshot({ llm_spend: makeSpend({ cap_usd: null, cap_armed_at: null }) })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(
      await within(rail).findByText('LLM spend cap was never armed — meter not drawable'),
    ).toBeTruthy();
    expect(within(rail).queryByText(/deliberately uncapped/)).toBeNull();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
    expect(within(rail).queryByText(/over cap/)).toBeNull();
  });

  // Round 2's MAJOR: `cap_usd: null` with `cap_armed_at` ABSENT (not
  // explicitly `null`) is a pre-#1196 server — it did boot and did arm, it
  // simply predates this field. Reading that absence as "never armed" is an
  // affirmative false claim about enforcement, the same shape of defect
  // #1196 itself fixed one field up. The rail must assert neither "armed"
  // nor "unarmed" for this cell — the one combination nothing tested before
  // this round.
  it('claims neither armed nor unarmed when cap_usd is null and cap_armed_at is absent entirely', async () => {
    const spend = { ...makeSpend({ cap_usd: null }) };
    // @ts-expect-error simulating a pre-#1196 server's wire shape
    delete spend.cap_armed_at;
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(
      await within(rail).findByText(
        'no trustworthy arming record on this snapshot — meter not drawable',
      ),
    ).toBeTruthy();
    expect(within(rail).queryByText(/never armed/)).toBeNull();
    expect(within(rail).queryByText(/deliberately uncapped/)).toBeNull();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
    expect(within(rail).queryByText(/over cap/)).toBeNull();
  });

  // A numeric `cap_usd` is itself affirmative evidence something armed —
  // `cap_armed_at` is #1196's discriminator for a NULL cap only, never a
  // gate on a numeric one. A payload carrying a real cap but missing (not
  // explicitly null) `cap_armed_at` — the shape an older server or a
  // version-skewed deployment would send — must still draw the meter, not
  // regress to "never armed" and throw the denominator away (review finding).
  it('draws the meter from a numeric cap even when cap_armed_at is absent from the wire', async () => {
    const spend = { ...makeSpend({ cap_usd: 50 }) };
    // @ts-expect-error simulating an older/mixed-version wire payload
    delete spend.cap_armed_at;
    spend.all_time = { ...spend.all_time, cost_usd: 12.5 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(await within(rail).findByText('$12.50 / $50.00')).toBeTruthy();
    expect(
      within(rail).getByRole('img', { name: 'LLM budget used: 25.0% of the $50.00 cap' }),
    ).toBeTruthy();
    expect(within(rail).queryByText(/never armed/)).toBeNull();
  });

  // The additional defect found in review: a $0 cap is the MOST restrictive
  // budget possible and must not render as "no budget configured" (the least
  // restrictive reading) — nor as a silently-healthy meter.
  it('states an armed $0 cap explicitly, never as an unconfigured budget', async () => {
    const spend = makeSpend({ cap_usd: 0 });
    spend.all_time = { ...spend.all_time, cost_usd: 0 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(await within(rail).findByText(/LLM spend cap is \$0/)).toBeTruthy();
    expect(within(rail).queryByText(/deliberately uncapped/)).toBeNull();
    expect(within(rail).queryByRole('img', { name: /LLM budget used/ })).toBeNull();
  });

  it('flags an armed $0 cap as already over when any spend at all is recorded', async () => {
    const spend = makeSpend({ cap_usd: 0 });
    spend.all_time = { ...spend.all_time, cost_usd: 0.01 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });

    expect(await within(rail).findByText(/LLM spend cap is \$0.*already over/)).toBeTruthy();
    expect(within(rail).getByText(/^over cap/)).toBeTruthy();
  });

  it('says the Alpaca equity is unavailable, with the probe detail, when the probe is not ok', async () => {
    const snapshot = makeSnapshot();
    snapshot.providers.alpaca = {
      ...snapshot.providers.alpaca,
      state: 'unauthorized',
      detail: 'key rejected',
      balance: null,
    };
    renderApp([snapshot]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(await within(rail).findByText('unauthorized')).toBeTruthy();
    expect(within(rail).getByText('equity unavailable — key rejected')).toBeTruthy();
  });

  it('calls the meter a floor whenever unpriced calls exist', async () => {
    const spend = makeSpend();
    spend.all_time = { ...spend.all_time, unpriced_calls: 3 };
    renderApp([makeSnapshot({ llm_spend: spend })]);
    expect(await screen.findByText(/floor — 3 unpriced calls/)).toBeTruthy();
  });

  it('says nothing about the alert channel when nothing has failed to deliver', async () => {
    renderApp([makeSnapshot()]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    await within(rail).findByText('ALIVE');
    expect(within(rail).queryByText(/failed to deliver/)).toBeNull();
  });

  // #1108: silence must not read as calm — the rail names the count instead.
  // #1131: the field and its rendered text both name the 24h window now, so
  // the tile itself does not overclaim a lifetime total.
  it('surfaces a nonzero alert_delivery_failures_24h count as a degraded channel', async () => {
    renderApp([makeSnapshot({ alert_delivery_failures_24h: 4 })]);
    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(
      await within(rail).findByText('4 alerts failed to deliver in the last 24h'),
    ).toBeTruthy();
  });
});

/**
 * #1520 (decided in #1144): the page answers "has a snapshot ever arrived"
 * ONCE, at the root, instead of letting 22 leaves each answer "is one present
 * right now". The three states below have to stay distinguishable from each
 * other — a cold start must not be dressed as an empty book, and a stale feed
 * must not be dressed as a cold start, which would throw away the last known
 * state of the book at exactly the moment an operator is reaching for it.
 *
 * The cold-start states are the SAME `FeedStatus` machine the rail reads
 * (#1316's discriminator), not a second one beside it — which is what the
 * MISMATCH case below pins: a first poll that answers with a wire contract
 * this client cannot read is a cold start whose word is MISMATCH, not
 * WAITING.
 */
describe('cold start (#1520)', () => {
  it('gates the whole dashboard on the first snapshot: one waiting state, no rail and no tabs', () => {
    renderApp([HANGS]);

    expect(screen.getByText('WAITING')).toBeTruthy();
    expect(screen.getByText('waiting for the first snapshot')).toBeTruthy();
    // Not a half-rendered dashboard: no rail, no tablist, no empty cards that
    // an operator could read as a book with nothing in it.
    expect(screen.queryByRole('complementary', { name: 'Rail' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.queryByLabelText('Open risk')).toBeNull();
  });

  it('says MISMATCH, not WAITING, when the very first poll disagrees about the wire contract', async () => {
    renderApp([makeSnapshot({ contract_version: 'not-this-clients-version' })]);

    expect(await screen.findByText('MISMATCH')).toBeTruthy();
    expect(screen.queryByText('WAITING')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/wire contract/);
    expect(screen.queryByRole('complementary', { name: 'Rail' })).toBeNull();
  });

  it('replaces the waiting state with the dashboard once the first snapshot lands', async () => {
    renderApp([makeSnapshot()]);

    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    expect(within(rail).getByText('ALIVE')).toBeTruthy();
    expect(screen.queryByText('waiting for the first snapshot')).toBeNull();
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });

  it('keeps the last known book on screen when the feed goes stale — a stale feed is never a cold start', async () => {
    renderApp([makeSnapshot({ positions: [makePosition({ instrument: 'SPY' })] }), null]);

    const rail = await screen.findByRole('complementary', { name: 'Rail' });
    await within(rail).findByText('ALIVE');
    await waitFor(() => expect(within(rail).getByText('STALE')).toBeTruthy(), { timeout: 2_000 });

    expect(screen.queryByText('waiting for the first snapshot')).toBeNull();
    expect(screen.queryByText('WAITING')).toBeNull();
    // The numbers themselves stay: staleness is a label and a border, never a
    // disappearance (dashboard-spec.md, "Layout — the Rail").
    expect(within(screen.getByLabelText('Open risk')).getByText('SPY')).toBeTruthy();
    expect(within(rail).getByText('snapshot 12:00:00Z')).toBeTruthy();
  });
});

describe('tabs', () => {
  it('opens on Glance, switches by tab, and reflects the tab in the hash', async () => {
    renderApp([makeSnapshot()]);
    expect((await screen.findByRole('tab', { name: 'Glance' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    await screen.findByRole('region', { name: 'P&L' });
    await openTab('Review');
    expect(window.location.hash).toBe('#review');
    expect(screen.getByRole('region', { name: 'Closed trades' })).toBeTruthy();
    await openTab('Live');
    expect(screen.getByRole('region', { name: 'Lanes' })).toBeTruthy();
  });

  it('moves the selected tab with the arrow keys and keeps focus on it', async () => {
    renderApp([makeSnapshot()]);
    const glance = await screen.findByRole('tab', { name: 'Glance' });
    glance.focus();
    fireEvent.keyDown(glance, { key: 'ArrowDown' });
    const live = screen.getByRole('tab', { name: 'Live' });
    expect(live.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(live);
    fireEvent.keyDown(live, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'ArrowDown' });
    expect(glance.getAttribute('aria-selected')).toBe('true');
  });

  it('boots on the tab the hash names', async () => {
    window.history.replaceState(null, '', '#review');
    renderApp([makeSnapshot()]);
    expect(await screen.findByRole('region', { name: 'Closed trades' })).toBeTruthy();
  });
});

describe('glance → live', () => {
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
    await openTab('Live');
    expect(
      await screen.findByRole('button', { name: 'BTC-USD, crypto, in flight, at Debate' }),
    ).toBeTruthy();
    const qqq = screen.getByRole('button', { name: 'QQQ, stocks, stopped, at Risk' });
    expect(within(qqq).getByText('rejected · exposure cap')).toBeTruthy();
    expect(within(qqq).getByRole('img', { name: 'stopped' })).toBeTruthy();
    expect(within(qqq).getAllByText('not reached').length).toBeGreaterThan(0);
    const spy = screen.getByRole('button', { name: 'SPY, stocks, idle, no trace in the window' });
    expect(within(spy).getAllByText('idle')).toHaveLength(6);
    const btc = screen.getByRole('button', { name: /BTC-USD/ });
    expect(within(btc).getAllByText('wait')).toHaveLength(4);
  });

  it('draws the selected trace’s conditions, its binding constraint and each stage’s clock', async () => {
    renderApp([
      makeSnapshot({
        pipeline: laneView(),
        risk_critics: [
          makeRiskCritic({
            trace_id: 'trace-qqq',
            instrument: 'QQQ',
            binding_constraint: 'risk_critic:invalidated',
            conditions: [makeCondition({ id: 'shown-trace-condition', observed: 401.25 })],
          }),
        ],
        debates: [makeDebate({ instrument: 'QQQ' })],
      }),
    ]);
    await openTab('Live');
    fireEvent.click(await screen.findByRole('button', { name: /QQQ, stocks, stopped/ }));
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(drawer.querySelector('[data-condition="shown-trace-condition"]')).toBeTruthy();
    expect(
      drawer.querySelector('[data-invalidation="binding"]')?.getAttribute('data-binding'),
    ).toBe('risk_critic:invalidated');
    const riskRow = drawer.querySelector('[data-stage="risk"]');
    expect(riskRow?.textContent).toContain('11:58:31Z · 2.6s');
    expect(within(drawer).getByText(/not keyed to this trace/)).toBeTruthy();
  });

  it('names its empty states: no selection, an idle lane, no debate, no Risk decision', async () => {
    renderApp([makeSnapshot({ pipeline: laneView(), debates: [], positions: [] })]);
    await openTab('Live');
    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(await within(drawer).findByText(/No lane selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /SPY, stocks, idle/ }));
    expect(within(drawer).getByText(/idle — no trace in the last 15 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /QQQ, stocks, stopped/ }));
    expect(within(drawer).getByText(/No Risk decision for this trace/)).toBeTruthy();
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
    await openTab('Live');
    const lane = await screen.findByRole('button', { name: /QQQ, stocks, stopped/ });
    lane.focus();
    await screen.findByText('snapshot 12:00:03Z');
    expect(document.activeElement).toBe(lane);
  });

  it('renders a hostile instrument string as inert text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const lane = doneThrough(hostile, 'trace-x', 'verdict', { outcome: 'no_go' });
    renderApp([makeSnapshot({ pipeline: makeView([lane]), positions: [], debates: [] })]);
    await openTab('Live');
    const button = await screen.findByRole('button', { name: /img src=x/ });
    const name = button.querySelector('.lane-instrument');
    expect(name?.textContent).toBe(hostile);
    expect(name?.childElementCount).toBe(0);
    expect(document.querySelectorAll('img, script').length).toBe(0);
  });
});

/**
 * #1080. A debate that hit its latency budget before any round completed
 * returns `neutral` with zero confidence, so the trace it leaves —
 * `debate: neutral`, `trader: no_trade` — used to be byte-identical to a
 * debate that ran to convergence and genuinely found nothing. The page is
 * where an operator reads that trace, so this is where the two have to look
 * different.
 */
describe('degraded stages on the page (#1080)', () => {
  function starvedLaneView() {
    const starved = makeLane({
      instrument: 'QQQ',
      trace_id: 'trace-qqq',
      asset_class: 'stocks',
      outcome: 'stopped',
      final_stage: 'trader',
      started_at: '2026-08-07T11:58:00.000Z',
      cells: {
        analysts: { state: 'done', recorded_at: '2026-08-07T11:58:01.000Z', duration_ms: 1_300 },
        debate: {
          state: 'done',
          recorded_at: '2026-08-07T11:59:01.000Z',
          duration_ms: 60_002,
          decision: 'budget_exhausted',
        },
        trader: {
          state: 'stopped',
          recorded_at: '2026-08-07T11:59:02.000Z',
          duration_ms: 100,
          decision: 'no_trade',
        },
      },
    });
    return makeView([starved], { live_trace_id: null, live_entered_at: null });
  }

  it('explains a starved sub-budget in the drawer instead of showing a bare word', async () => {
    renderApp([makeSnapshot({ pipeline: starvedLaneView() })]);
    await openTab('Live');
    fireEvent.click(await screen.findByRole('button', { name: /QQQ, stocks, stopped/ }));

    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    const debateRow = drawer.querySelector('[data-stage="debate"]');
    expect(debateRow?.getAttribute('data-degraded')).toBe('true');
    expect(debateRow?.textContent).toContain('budget_exhausted');
    expect(debateRow?.textContent).toContain('before any round completed');

    // The no_trade beside it is a genuine decision word and must NOT be
    // recoloured — the point is telling the two apart, not flagging the pair.
    expect(drawer.querySelector('[data-stage="trader"]')?.getAttribute('data-degraded')).toBeNull();
  });

  // F1 (#1142): the lane matrix walked the same cells as the drawer but
  // rendered a bare `decisionOf(cell)`, so this same starved debate read
  // glossed in the drawer and unglossed in the matrix — the surface an
  // operator scans first. Both now render from `resolveLaneCells`, so the
  // matrix carries the drawer's `data-degraded` hook too. The per-word
  // coverage (which decisions gloss, and what they say) lives at the
  // resolver in `lane-cells.test.ts`; this is the DOM wiring proof for the
  // renderer the drawer test above does not touch.
  it('explains a starved sub-budget in the LANE MATRIX too, not only the drawer', async () => {
    renderApp([makeSnapshot({ pipeline: starvedLaneView() })]);
    await openTab('Live');

    // aria-label overrides inner text for assistive tech (LiveTab.tsx's
    // button), so the lane's own accessible name has to say "degraded" too —
    // otherwise the fix is sighted-only.
    const qqq = await screen.findByRole('button', { name: /QQQ, stocks, stopped, .*degraded/ });
    const debateCell = qqq.querySelector('[data-stage="debate"]');
    expect(debateCell?.getAttribute('data-degraded')).toBe('true');

    // The cell paints its decision WORD (dashboard-spec.md:135), not the
    // gloss sentence — a sentence overflows the matrix column. The gloss
    // reaches the surface as `title` and as the non-colour glyph, not as the
    // cell's visible text.
    const decisionSpan = debateCell?.querySelector('.lane-decision');
    expect(decisionSpan?.textContent).toContain('budget_exhausted');
    expect(decisionSpan?.textContent).not.toContain('before any round completed');
    expect(decisionSpan?.getAttribute('title')).toContain('before any round completed');
    expect(decisionSpan?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'degraded',
    );

    expect(qqq.querySelector('[data-stage="trader"]')?.getAttribute('data-degraded')).toBeNull();
  });

  // #1428: the wiring proof for the two renderers #1396 left on the old
  // `audit_log`-only resolution. `budget_exhausted` is written for an escaped
  // LLM failure exactly as it is for a genuine budget expiry, so the drawer
  // could state both answers at once — the Timeline row saying one thing and
  // the debate section directly beneath it saying another, for one debate.
  const llmFailureDebate = makeDebate({
    instrument: 'QQQ',
    termination: 'latency_truncated',
    termination_cause: 'llm_failure',
  });
  const CAUSE = 'an LLM call failed outright';

  it('gives the drawer ONE answer for why a debate degraded, not one per section', async () => {
    renderApp([makeSnapshot({ pipeline: starvedLaneView(), debates: [llmFailureDebate] })]);
    await openTab('Live');
    fireEvent.click(await screen.findByRole('button', { name: /QQQ, stocks, stopped/ }));

    const drawer = screen.getByRole('complementary', { name: 'Trace detail' });
    expect(drawer.querySelector('[data-stage="debate"]')?.textContent).toContain(CAUSE);
    expect(drawer.querySelector('[data-section="debate"]')?.textContent).toContain(CAUSE);
  });

  it('carries the cause to the lane matrix cell an operator scans first', async () => {
    renderApp([makeSnapshot({ pipeline: starvedLaneView(), debates: [llmFailureDebate] })]);
    await openTab('Live');

    const qqq = await screen.findByRole('button', { name: /QQQ, stocks, stopped, .*degraded/ });
    const decisionSpan = qqq.querySelector('[data-stage="debate"] .lane-decision');
    // Still the bare word visibly (dashboard-spec.md:135); the cause reaches
    // the surface through the same `title` the audit gloss already used.
    expect(decisionSpan?.textContent).toContain('budget_exhausted');
    expect(decisionSpan?.textContent).not.toContain(CAUSE);
    expect(decisionSpan?.getAttribute('title')).toContain(CAUSE);
  });
});

/**
 * #1038: the dashboard's only way to acquire a bearer token is `?token=` on
 * a shared link (`lib/dashboard-token.ts`'s header). These are the wiring
 * tests — the pure resolve/strip logic is covered directly in
 * `lib/dashboard-token.test.ts`; this file proves `App.tsx` actually calls
 * it, scrubs the address bar, and reaches the poll's `Authorization` header.
 */
describe('dashboard token from the URL (#1038)', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  function recordingFetch(): {
    fetchImpl: typeof fetch;
    inits: () => (RequestInit | undefined)[];
    lastInit: () => RequestInit | undefined;
  } {
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      inits.push(init);
      return { ok: true, status: 200, json: async () => makeSnapshot() } as Response;
    }) as typeof fetch;
    return { fetchImpl, inits: () => inits, lastInit: () => inits[inits.length - 1] };
  }

  // Pins `inits()[0]`, not `lastInit()`: round 2 finding A found the round-1
  // fix regressed exactly the first poll to unauthenticated while a later,
  // correctly-authenticated poll still landed within `waitFor`'s retry
  // window — `lastInit()` never caught it.
  it('sends the ?token= from a shared link as the very first poll’s Authorization header', async () => {
    window.history.pushState(null, '', '/?token=fixture-dashboard-token');
    const { fetchImpl, inits } = recordingFetch();

    render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

    await waitFor(() => expect(inits().length).toBeGreaterThan(0));
    const headers = inits()[0]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer fixture-dashboard-token');
  });

  it('scrubs ?token= off the address bar after capture, preserving other params and the hash', async () => {
    window.history.pushState(null, '', '/?token=fixture-dashboard-token&tab=live#live');
    const { fetchImpl } = recordingFetch();

    render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

    await waitFor(() => expect(window.location.search).not.toContain('token'));
    expect(window.location.search).toBe('?tab=live');
    expect(window.location.hash).toBe('#live');
  });

  it('reuses a previously-captured token from sessionStorage on the first poll of a later mount with no ?token=', async () => {
    window.sessionStorage.setItem('samurai-dashboard-token', 'fixture-dashboard-token');
    const { fetchImpl, inits } = recordingFetch();

    render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

    await waitFor(() => expect(inits().length).toBeGreaterThan(0));
    const headers = inits()[0]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer fixture-dashboard-token');
  });

  it('sends no Authorization header on the default path — no ?token= and nothing in storage', async () => {
    const { fetchImpl, lastInit } = recordingFetch();

    render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

    await waitFor(() => expect(lastInit()).toBeDefined());
    const headers = lastInit()?.headers as Record<string, string> | undefined;
    expect(headers === undefined || headers.Authorization === undefined).toBe(true);
  });

  // Token resolution runs inside useState's lazy initializer (round 2
  // finding A moved it back there from an effect, to win the race against
  // useSnapshot's mount-time poll). `window.sessionStorage`'s PROPERTY ACCESS
  // itself throws `SecurityError` where site data is blocked (Safari Block
  // All Cookies, some Chrome privacy settings, privacy extensions) — with no
  // error boundary, an uncaught throw here would blow up render (a white
  // screen). `safeSessionStorage()` catches it and degrades to a no-op
  // store, so the default no-token path renders instead.
  it('renders the default path instead of white-screening when sessionStorage access throws', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      const { fetchImpl, lastInit } = recordingFetch();

      render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

      const rail = await screen.findByRole('complementary', { name: 'Rail' });
      expect(rail).toBeTruthy();
      await waitFor(() => expect(lastInit()).toBeDefined());
      const headers = lastInit()?.headers as Record<string, string> | undefined;
      expect(headers === undefined || headers.Authorization === undefined).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  // Round 2 finding B: `safeSessionStorage()` guarded only the property
  // access, so a throwing `getItem`/`setItem` (Safari private browsing,
  // `QuotaExceededError`) still escaped — and `resolveDashboardToken` calls
  // `storage.setItem` BEFORE returning a fresh URL token, so an unguarded
  // throw there would both blank the dashboard (thrown out of the lazy
  // initializer, no error boundary) AND lose the URL token that triggered
  // the write. Both halves are asserted: the dashboard renders, and the
  // first poll still carries the URL token despite the write failing.
  it('carries the URL token on the first poll, and does not blank the dashboard, when sessionStorage.setItem throws', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const throwingStore: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => throwingStore,
    });
    try {
      window.history.pushState(null, '', '/?token=fixture-dashboard-token');
      const { fetchImpl, inits } = recordingFetch();

      render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

      const rail = await screen.findByRole('complementary', { name: 'Rail' });
      expect(rail).toBeTruthy();
      await waitFor(() => expect(inits().length).toBeGreaterThan(0));
      const headers = inits()[0]?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe('Bearer fixture-dashboard-token');
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  // Round 2 finding B's other half: `getItem` throwing (not just `setItem`)
  // must also degrade to the default path rather than blank the dashboard.
  // No ?token= here, so `resolveDashboardToken` falls through to the
  // `storage.getItem` read this store throws on.
  it('renders the default path instead of white-screening when sessionStorage.getItem throws', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const throwingStore: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      setItem: () => {},
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => throwingStore,
    });
    try {
      const { fetchImpl, inits } = recordingFetch();

      render(<App snapshotOptions={{ fetchImpl, intervalMs: POLL_MS }} />);

      const rail = await screen.findByRole('complementary', { name: 'Rail' });
      expect(rail).toBeTruthy();
      await waitFor(() => expect(inits().length).toBeGreaterThan(0));
      const headers = inits()[0]?.headers as Record<string, string> | undefined;
      expect(headers === undefined || headers.Authorization === undefined).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

/**
 * #1593: the rail's Live/Control selector, the hash it lives in beside the
 * tab, and the Control banner. `App.tsx`'s `ArmView` is keyed by `arm`, so
 * switching arms remounts the whole snapshot-derived subtree rather than
 * mutating it in place — the tests below that assert the PREVIOUS arm's data
 * is gone, not just joined by the new arm's, are the mutation evidence for
 * that: they fail against a version that swaps `snapshot` in place inside one
 * `useSnapshot` call (a plausible, WRONG first implementation) whenever that
 * version's poll for the new arm has not landed yet, because the old arm's
 * numbers would still be on screen instead of the cold start.
 */
describe('arm selector (#1593)', () => {
  /** Routes a fake poll by whether its URL asked for the control arm. */
  function fetchByArm(payloads: { live: unknown; control: unknown }): typeof fetch {
    const impl = async (input: unknown): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      const payload = url.includes('arm=control') ? payloads.control : payloads.live;
      if (payload === HANGS) return new Promise<Response>(() => {});
      return { ok: true, status: 200, json: async () => payload } as Response;
    };
    return impl as unknown as typeof fetch;
  }

  it('opens on Live with no hash, and there is no Control banner', async () => {
    renderApp([makeSnapshot()]);
    await screen.findByRole('tab', { name: 'Glance' });
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('button', { name: 'Live arm, selected' })).toBeTruthy();
    expect(screen.queryByText(/CONTROL ARM/)).toBeNull();
  });

  it('writes the arm into the hash beside the tab, and the banner follows onto every tab', async () => {
    renderApp([makeSnapshot()]);
    await screen.findByRole('tab', { name: 'Glance' });

    fireEvent.click(screen.getByRole('button', { name: 'Control arm' }));
    expect(window.location.hash).toBe('#glance/control');
    expect(await screen.findByText('CONTROL ARM — simulated fills, no money')).toBeTruthy();

    await openTab('Live');
    expect(window.location.hash).toBe('#live/control');
    expect(screen.getByText('CONTROL ARM — simulated fills, no money')).toBeTruthy();

    await openTab('Review');
    expect(window.location.hash).toBe('#review/control');
    expect(screen.getByText('CONTROL ARM — simulated fills, no money')).toBeTruthy();

    // Round trip back to Live: no second segment, not `#review/live`.
    fireEvent.click(screen.getByRole('button', { name: 'Live arm' }));
    await waitFor(() => expect(screen.queryByText(/CONTROL ARM/)).toBeNull());
    expect(window.location.hash).toBe('#review');
  });

  it('never renders the banner in Live, on any tab', async () => {
    renderApp([makeSnapshot()]);
    await openTab('Live');
    expect(screen.queryByText(/CONTROL ARM/)).toBeNull();
    await openTab('Review');
    expect(screen.queryByText(/CONTROL ARM/)).toBeNull();
  });

  it('boots straight into Control when the hash names it — a reload keeps the arm', async () => {
    window.history.replaceState(null, '', '#review/control');
    renderApp([makeSnapshot()]);

    expect(await screen.findByText('CONTROL ARM — simulated fills, no money')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control arm, selected' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Closed trades' })).toBeTruthy();
  });

  it('reads an unrecognised arm hash segment as Live', async () => {
    window.history.replaceState(null, '', '#glance/bogus');
    renderApp([makeSnapshot()]);

    await screen.findByRole('tab', { name: 'Glance' });
    expect(screen.getByRole('button', { name: 'Live arm, selected' })).toBeTruthy();
    expect(screen.queryByText(/CONTROL ARM/)).toBeNull();
  });

  it('polls ?arm=control only once Control is selected, and drops the live arm’s data once Control’s own snapshot lands', async () => {
    const liveSnapshot = makeSnapshot({ positions: [makePosition({ instrument: 'LIVE-ONLY' })] });
    const controlSnapshot = makeSnapshot({
      positions: [makePosition({ instrument: 'CONTROL-ONLY' })],
    });
    render(
      <App
        snapshotOptions={{
          fetchImpl: fetchByArm({ live: liveSnapshot, control: controlSnapshot }),
          intervalMs: POLL_MS,
        }}
      />,
    );

    const openRisk = await screen.findByRole('region', { name: 'Open risk' });
    expect(within(openRisk).getByText('LIVE-ONLY')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Control arm' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Open risk' })).getByText('CONTROL-ONLY'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('LIVE-ONLY')).toBeNull();
  });

  it('cold-starts on switching to Control while its first poll hangs, rather than leaving the live arm’s numbers on screen', async () => {
    const liveSnapshot = makeSnapshot({ positions: [makePosition({ instrument: 'LIVE-ONLY' })] });
    render(
      <App
        snapshotOptions={{
          fetchImpl: fetchByArm({ live: liveSnapshot, control: HANGS }),
          intervalMs: POLL_MS,
        }}
      />,
    );

    await screen.findByText('LIVE-ONLY');
    fireEvent.click(screen.getByRole('button', { name: 'Control arm' }));

    expect(await screen.findByText('waiting for the first snapshot')).toBeTruthy();
    expect(screen.queryByText('LIVE-ONLY')).toBeNull();
  });
});
