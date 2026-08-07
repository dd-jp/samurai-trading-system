// @vitest-environment jsdom
//
// Component tests for the mission-control screen (issue #538;
// dashboard-spec.md "Testing Decisions": "Component tests (RTL) cover what a
// screenshot cannot"). Everything here is driven by an injected fake `fetch`
// over the fixtures in `test-fixtures.ts` — no network, no database, no wall
// clock beyond the short poll interval each test sets.
//
// The pure logic these components consume (room placement, the walk plan, the
// ledger state machine) is tested without a DOM under `lib/`; these tests are
// deliberately about the things only a rendered tree can answer: accessible
// names, the words an empty state chooses, and whether a repaint steals focus.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { doneThrough, makeLane, makeView } from './lib/test-support.ts';
import { fakeFetch, makeSnapshot, makeSpend, makeVerdict } from './test-fixtures.ts';

// No `@testing-library/jest-dom` matchers in this repo's devDependencies, so
// assertions use plain DOM properties.
const POLL_MS = 20;

function renderApp(payloads: Parameters<typeof fakeFetch>[0]) {
  return render(<App snapshotOptions={{ fetchImpl: fakeFetch(payloads), intervalMs: POLL_MS }} />);
}

/** BTC live in debate, QQQ stopped at risk, SPY idle in the Lobby. */
function theaterView() {
  // Built with `makeLane` rather than `doneThrough` plus a `cells[1]` write:
  // the index was an unstated bet on `doneThrough`'s stage ordering, and
  // `doneThrough` only emits `done` cells, so a live stage was never something
  // it could express (#606 item 6).
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

describe('mission control', () => {
  it('names every chip outcome in words in its accessible name', async () => {
    renderApp([makeSnapshot({ pipeline: theaterView() })]);

    // The outcome ring is a colour; the word is what carries the meaning.
    expect(
      await screen.findByRole('button', { name: /BTC-USD, crypto, in flight, in Debate/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /QQQ, stocks, stopped, in Risk/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /SPY, stocks, idle, in Lobby/ })).toBeTruthy();
  });

  it('places every mounted chip, including ones the walk plan never mentions', async () => {
    // `computeWalkPlan` emits no motion for a lane that did not change room,
    // so a plan-only placement pass would leave these two chips stacked at the
    // grid's top-left corner. Both stand in Risk, so they must differ by one
    // slot's vertical pitch.
    const first = doneThrough('AAA', 'trace-a', 'risk', { outcome: 'stopped' });
    const second = doneThrough('BBB', 'trace-b', 'risk', { outcome: 'stopped' });
    renderApp([makeSnapshot({ pipeline: makeView([first, second]) })]);

    const a = await screen.findByRole('button', { name: /AAA, crypto, stopped, in Risk/ });
    const b = screen.getByRole('button', { name: /BBB, crypto, stopped, in Risk/ });
    expect(a.style.transform).toMatch(/^translate\(/);
    expect(b.style.transform).toMatch(/^translate\(/);
    expect(a.style.transform).not.toBe(b.style.transform);
  });

  it('reads out the live tick with its instrument, stage and trace', async () => {
    renderApp([
      makeSnapshot({
        pipeline: theaterView(),
        tick_status: {
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          stage: 'debate',
          trace_id: 'trace-btc',
        },
      }),
    ]);

    const strip = screen.getByRole('region', { name: 'Telemetry' });
    expect(await within(strip).findByText(/BTC-USD · crypto · debate/)).toBeTruthy();
    expect(within(strip).getByText(/since 11:59:50Z/)).toBeTruthy();
    expect(within(strip).getByText('trace trace-btc')).toBeTruthy();
    // The live room carries the word as well as the glow.
    const debateRoom = screen.getByRole('heading', { name: 'Debate' }).closest('.room');
    expect(debateRoom?.classList.contains('room-live')).toBe(true);
    expect(within(debateRoom as HTMLElement).getByText('live')).toBeTruthy();
  });

  it('draws room 04 lights-off from the data, with its reason', async () => {
    renderApp([makeSnapshot({ pipeline: theaterView() })]);

    const room = (await screen.findByRole('heading', { name: 'Invalidation' })).closest(
      '[data-room="invalidation"]',
    );
    expect(room?.classList.contains('room-lights-off')).toBe(true);
    expect(screen.getByText(/specced and not built/i)).toBeTruthy();
  });

  it('stamps a settled lane into the ledger once, and never again on a re-poll', async () => {
    const settled = doneThrough('ETH-USD', 'trace-eth', 'execution', { outcome: 'go' });
    const first = makeSnapshot({ pipeline: makeView([settled]) });
    const second = makeSnapshot({
      pipeline: makeView([settled]),
      as_of: '2026-08-07T12:00:03.000Z',
      generated_at: '2026-08-07T12:00:03.000Z',
    });
    renderApp([first, second]);

    const ledger = await screen.findByRole('region', { name: 'Verdict ledger' });
    await within(ledger).findByRole('button', { name: /ETH-USD, go/ });

    // Wait for the second poll to land — the clock is what proves it did.
    await screen.findByText('12:00:03Z');
    expect(within(ledger).getAllByRole('button', { name: /ETH-USD, go/ })).toHaveLength(1);
  });

  it('badges a HITL override on the ledger row that carries one', async () => {
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

    const row = await screen.findByRole('button', { name: /ETH-USD, no-go, human override/ });
    expect(within(row).getByText('HITL')).toBeTruthy();
    expect(within(row).getByText(/drawdown gate/)).toBeTruthy();
  });

  it('opens the drawer from a ledger row and from a chip, and names its empty states', async () => {
    renderApp([makeSnapshot({ pipeline: theaterView(), debates: [] })]);

    // Wait on a chip — a data-dependent node — rather than on the drawer
    // region, which is drawn from first paint (the deferred-shell contract) and
    // would resolve before the first payload landed.
    const spy = await screen.findByRole('button', { name: /SPY, stocks, idle/ });
    const drawer = screen.getByRole('region', { name: 'Instrument detail' });
    // Nothing selected yet: the drawer says why it is empty rather than sitting blank.
    expect(within(drawer).getByText(/no instrument selected/i)).toBeTruthy();

    fireEvent.click(spy);
    expect(within(drawer).getByText(/no trace in the last 15 minutes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /QQQ, stocks, stopped/ }));
    // The reserved invalidation section, named rather than rendered blank.
    expect(
      within(drawer).getByText(/the invalidation stage is specced and not built/i),
    ).toBeTruthy();
    // Trader and Risk persist no decision content — #328, spelled out.
    expect(within(drawer).getAllByText(/not persisted \(#328\)/i).length).toBeGreaterThan(0);
    // A debate that never completed says so, rather than spinning forever.
    expect(within(drawer).getByText(/no completed debate recorded/i)).toBeTruthy();
    // The stage strip lists all seven stages, including the never-reached ones.
    expect(within(drawer).getAllByText('not reached').length).toBeGreaterThan(0);
  });

  it('marks the strip stale after two missed polls, keeping the last numbers', async () => {
    renderApp([makeSnapshot(), null]);

    await screen.findByText('12:00:00Z');
    await waitFor(() => expect(screen.getByText(/^stale — last update/)).toBeTruthy(), {
      timeout: 2_000,
    });
    const strip = screen.getByRole('region', { name: 'Telemetry' });
    expect(strip.getAttribute('data-stale')).toBe('true');
    // Numbers are marked stale, never blanked — a blank field reads as zero.
    expect(within(strip).getByText('12:00:00Z')).toBeTruthy();
  });

  it('renders "mode unknown" when the wire carries no mode, never "paper"', async () => {
    const snapshot = makeSnapshot();
    // Deleted rather than assigned, and cast because the wire type says the
    // field is there: the case under test is a payload from a server that
    // does not send it (an older build, a proxy that rewrote the body), which
    // no type can rule out at runtime. This goes through the real fetch
    // boundary, so it also covers `toWireSnapshot` narrowing it to `null`.
    delete (snapshot as { mode?: unknown }).mode;
    renderApp([snapshot]);

    expect(await screen.findByText('mode unknown')).toBeTruthy();
    expect(screen.queryByText('PAPER')).toBeNull();
  });

  it('renders "mode unknown" for a mode word this client does not recognise', async () => {
    const snapshot = makeSnapshot();
    (snapshot as { mode?: unknown }).mode = 'staging';
    renderApp([snapshot]);

    // The unrecognised word is never printed — rendering whatever the server
    // sent is the "trust the wire" failure the boundary check exists to end.
    expect(await screen.findByText('mode unknown')).toBeTruthy();
    expect(screen.queryByText('STAGING')).toBeNull();
    expect(screen.queryByText('PAPER')).toBeNull();
  });

  it('renders a hostile instrument string as inert text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const lane = doneThrough(hostile, 'trace-x', 'verdict', { outcome: 'no_go' });
    renderApp([makeSnapshot({ pipeline: makeView([lane]), positions: [], debates: [] })]);

    const chip = await screen.findByRole('button', { name: /img src=x/ });
    // The property that matters is that the string became TEXT, not markup:
    // the callsign holds it verbatim with no element children, and nothing in
    // the document parsed it into a tag. Asserting on `innerHTML` would prove
    // nothing either way — an escaped text node serializes back to a string
    // that still contains the characters.
    const callsign = chip.querySelector('.chip-callsign');
    expect(callsign?.textContent).toBe(hostile);
    expect(callsign?.childElementCount).toBe(0);
    expect(document.querySelectorAll('img, script').length).toBe(0);
    // The ledger renders the same untrusted string on its own path.
    const ledger = screen.getByRole('region', { name: 'Verdict ledger' });
    // `findBy`, not `getBy`: the ledger is folded in by an effect, so it lands
    // one render after the chip the assertion above already waited for.
    const row = await within(ledger).findByRole('button');
    expect(row.querySelector('.ledger-instrument')?.textContent).toBe(hostile);
  });

  it('keeps keyboard focus on a chip across a poll', async () => {
    const view = theaterView();
    const next = makeSnapshot({
      pipeline: view,
      as_of: '2026-08-07T12:00:03.000Z',
      generated_at: '2026-08-07T12:00:03.000Z',
    });
    renderApp([makeSnapshot({ pipeline: view }), next]);

    const chip = await screen.findByRole('button', { name: /QQQ, stocks, stopped/ });
    chip.focus();
    expect(document.activeElement).toBe(chip);

    await screen.findByText('12:00:03Z');
    // A 3-second poll that steals focus makes the page unusable with a
    // keyboard (spec, Accessibility floor).
    expect(document.activeElement).toBe(chip);
  });

  it('carries both spend caveats whenever their counts are non-zero', async () => {
    // Both counts sit on `all_time` — the window the caveats report — because
    // the windows are nested and a call inside 24h is inside all time too.
    const spend = makeSpend();
    spend.all_time = {
      ...spend.all_time,
      unpriced_calls: 3,
      per_debate: { ...spend.all_time.per_debate, unattributed_calls: 7 },
    };
    renderApp([makeSnapshot({ llm_spend: spend })]);

    const panel = screen.getByRole('region', { name: 'LLM spend' });
    expect(await within(panel).findByText(/unpriced calls/)).toBeTruthy();
    expect(within(panel).getByText(/floor, not a total/)).toBeTruthy();
    expect(within(panel).getByText(/carry no/)).toBeTruthy();
  });

  it('counts each unpriced call ONCE across the nested spend windows', async () => {
    // #606 item 1. The same 3 unpriced and 7 unattributed calls appear in all
    // three windows, because 24h ⊂ 7d ⊂ all time (`getLlmSpend` leaves
    // `all_time` open-ended and bounds the other two by timestamp). Summing
    // the windows reported 9 and 21 — a caveat that exists to stop a spend
    // figure reading as more complete than it is, inflating its own count.
    const spend = makeSpend();
    for (const key of ['last_24h', 'last_7d', 'all_time'] as const) {
      spend[key] = {
        ...spend[key],
        unpriced_calls: 3,
        per_debate: { ...spend[key].per_debate, unattributed_calls: 7 },
      };
    }
    renderApp([makeSnapshot({ llm_spend: spend })]);

    const panel = screen.getByRole('region', { name: 'LLM spend' });
    const unpriced = await within(panel).findByText(/unpriced calls/);
    expect(unpriced.textContent).toContain('3 unpriced calls (all time)');
    expect(unpriced.textContent).not.toContain('9 unpriced');
    const unattributed = within(panel).getByText(/carry no/);
    expect(unattributed.textContent).toContain('7 calls (all time)');
    expect(unattributed.textContent).not.toContain('21 calls');
    // The strip's burn caveat already quoted `all_time`; the two agree now.
    const strip = screen.getByRole('region', { name: 'Telemetry' });
    expect(within(strip).getByText(/3 unpriced calls/)).toBeTruthy();
  });

  it('degrades to the spend panel’s empty state when the spend read is missing', async () => {
    // #606 item 2. The panel and the burn meter both have an honest rendering
    // for an absent summary; the boundary used to throw the whole payload away
    // instead, freezing every OTHER panel into stale to spare the one built to
    // degrade. Deleted rather than assigned, because the case is a server or
    // proxy that does not send the field.
    const snapshot = makeSnapshot({ pipeline: theaterView() });
    delete (snapshot as { llm_spend?: unknown }).llm_spend;
    renderApp([snapshot]);

    // The rest of the page is alive: positions, the theater and the clock all
    // landed from the very payload the boundary used to reject.
    expect(await screen.findByText('12:00:00Z')).toBeTruthy();
    expect(screen.getByRole('button', { name: /QQQ, stocks, stopped/ })).toBeTruthy();
    const spend = screen.getByRole('region', { name: 'LLM spend' });
    expect(within(spend).getByText(/an absent summary means the read failed/)).toBeTruthy();
    const strip = screen.getByRole('region', { name: 'Telemetry' });
    // Not a zero-width bar reading as "nothing spent".
    expect(within(strip).getByText(/meter not drawable/)).toBeTruthy();
    expect(strip.getAttribute('data-stale')).toBe('false');
  });

  it('renders the spend empty state, not a white screen, for a malformed spend summary', async () => {
    // PR #607 review round 1. An array passes `typeof x === 'object'`, so the
    // first narrowing handed `[]` to `SpendPanel` as a summary and the read of
    // `spend.all_time.per_debate` threw — and `main.tsx` mounts `<App/>` with
    // no error boundary, so the whole operator surface goes blank. This is the
    // end-to-end version of the boundary test: the page must survive it.
    const snapshot = makeSnapshot({ pipeline: theaterView() });
    (snapshot as { llm_spend?: unknown }).llm_spend = [];
    renderApp([snapshot]);

    expect(await screen.findByText('12:00:00Z')).toBeTruthy();
    expect(screen.getByRole('button', { name: /QQQ, stocks, stopped/ })).toBeTruthy();
    const spend = screen.getByRole('region', { name: 'LLM spend' });
    expect(within(spend).getByText(/an absent summary means the read failed/)).toBeTruthy();
    // Not a grid of em dashes reading as a real, empty spend summary.
    expect(within(spend).queryByText('24 hours')).toBeNull();
  });

  it('reads live, not idle, when a trace is running but tick_status is absent', async () => {
    // #606 item 4. `tick_status` is null while `pipeline.live_trace_id` is
    // set: the rooms hero glows and the cell's own caveat prints the trace, so
    // "idle — no tick in progress" left the strip contradicting the rest of
    // the page — and "the system has gone quiet" is the reading that makes an
    // operator intervene.
    renderApp([makeSnapshot({ pipeline: theaterView(), tick_status: null })]);

    const strip = screen.getByRole('region', { name: 'Telemetry' });
    expect(await within(strip).findByText('trace trace-btc')).toBeTruthy();
    expect(within(strip).queryByText(/idle — no tick in progress/)).toBeNull();
    expect(within(strip).getByText(/live — a trace is running/)).toBeTruthy();
    // The room it disagreed with, still glowing.
    const debateRoom = screen.getByRole('heading', { name: 'Debate' }).closest('.room');
    expect(debateRoom?.classList.contains('room-live')).toBe(true);
  });

  it('still reads idle when there is no tick AND no live trace', async () => {
    // The other half of item 4: the muted idle wording is not gone, it is
    // reserved for the case where both fields agree there is nothing running.
    renderApp([makeSnapshot({ tick_status: null })]);

    const strip = screen.getByRole('region', { name: 'Telemetry' });
    expect(await within(strip).findByText(/idle — no tick in progress/)).toBeTruthy();
    expect(within(strip).getByText('no live trace')).toBeTruthy();
  });

  it('opens the trace stamped on a ledger row, not the instrument’s current one', async () => {
    // #606 item 5. ETH-USD settles twice this session. The drawer used to be
    // keyed by instrument, so clicking the OLDER row showed the trace ETH-USD
    // is on now — a different decision than the one the row is stamped with,
    // under a subheading promising "click a row for its trace".
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
      // Both, as the wire carries them: `verdicts[]` is the last ten settled
      // decisions, not just the current tick's.
      verdicts: [
        makeVerdict({ trace_id: 'trace-new', status: 'go', reason: 'approved' }),
        makeVerdict({ trace_id: 'trace-old', status: 'no_go', reason: 'drawdown gate' }),
      ],
    });
    renderApp([first, second]);

    // Wait for the second poll, so the ledger holds both rows and the only
    // lane on the wire is the newer trace.
    await screen.findByText('12:00:03Z');
    const ledger = await screen.findByRole('region', { name: 'Verdict ledger' });
    const older = await within(ledger).findByRole('button', { name: /ETH-USD, no-go/ });
    fireEvent.click(older);

    const drawer = screen.getByRole('region', { name: 'Instrument detail' });
    expect(within(drawer).getByText('trace trace-old')).toBeTruthy();
    expect(within(drawer).queryByText('trace trace-new')).toBeNull();
    // Its own verdict travels with it, even though the lane has aged out.
    expect(within(drawer).getByText(/drawdown gate/)).toBeTruthy();
    expect(within(drawer).getByText(/aged out of the 15-minute pipeline window/)).toBeTruthy();
    // Only the row being described is highlighted.
    expect(older.classList.contains('ledger-row-selected')).toBe(true);
    const newer = within(ledger).getByRole('button', { name: /ETH-USD, go/ });
    expect(newer.classList.contains('ledger-row-selected')).toBe(false);

    // And the current row still resolves to the live lane's stage strip.
    fireEvent.click(newer);
    expect(within(drawer).getByText('trace trace-new')).toBeTruthy();
    // A trace still inside the window keeps its full stage strip.
    expect(within(drawer).getByRole('columnheader', { name: 'Stage' })).toBeTruthy();
  });

  it('samples equity per probe observation, not per poll', async () => {
    // The Alpaca tile is refreshed on its own 60-second poller, so the same
    // balance is re-served across ~20 of these 3-second polls. Counting each
    // one would draw a "curve" of one repeated number.
    const polls = [0, 1, 2, 3].map((step) =>
      makeSnapshot({
        as_of: `2026-08-07T12:00:0${step}.000Z`,
        generated_at: `2026-08-07T12:00:0${step}.000Z`,
      }),
    );
    // The fifth poll carries a genuinely new probe observation.
    const moved = makeSnapshot({
      as_of: '2026-08-07T12:00:04.000Z',
      generated_at: '2026-08-07T12:00:04.000Z',
    });
    moved.providers.alpaca = {
      ...moved.providers.alpaca,
      observed_at: '2026-08-07T12:01:00.000Z',
      balance: { cash: 99_000, equity: 100_500.5, buying_power: 198_000 },
    };
    renderApp([...polls, moved]);

    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    // Four snapshots, one unchanged observation between them: still no series.
    await screen.findByText('12:00:03Z');
    expect(within(metrics).getByText(/No equity series yet/)).toBeTruthy();
    expect(within(metrics).getByText(/one distinct observation so far/)).toBeTruthy();

    // The moved observation is a second point, and the line appears — so the
    // assertion above is about de-duplication, not about never accumulating.
    await screen.findByText('12:00:04Z');
    expect(await within(metrics).findByRole('img', { name: /Alpaca equity/ })).toBeTruthy();
    expect(within(metrics).getByText(/2 probe observations this session/)).toBeTruthy();
  });

  it('shows the whole metrics suite and the honest empty states around it', async () => {
    renderApp([makeSnapshot({ positions: [], analysts: [], debates: [] })]);

    const metrics = screen.getByRole('region', { name: 'Metrics suite' });
    await within(metrics).findByText('Sharpe');
    for (const label of [
      'Sharpe',
      'Sortino',
      'Calmar',
      'Max drawdown',
      'Profit factor',
      'Expectancy',
      'Skew',
      'Excess kurtosis',
      'Turnover',
      'Exposure',
    ]) {
      expect(within(metrics).getByText(label)).toBeTruthy();
    }
    // One equity sample is not a series, and the panel says so.
    expect(within(metrics).getByText(/No equity series yet/)).toBeTruthy();
    expect(screen.getByText(/No open position/)).toBeTruthy();
    expect(screen.getByText(/No analyst weights/)).toBeTruthy();
  });
});
