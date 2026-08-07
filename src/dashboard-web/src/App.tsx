/**
 * The mission-control screen (issue #538; dashboard-spec.md, "Layout"): one
 * vertically-scrolling page — telemetry strip, rooms hero, verdict ledger and
 * detail drawer, then the bento panels — ordered by how urgently an operator
 * needs each part.
 *
 * This component is the composition root and holds no domain logic: every
 * number it shows is computed server-side, and everything derived on the
 * client (room placement, the walk plan, the ledger) comes from the pure
 * modules under `lib/`, which are unit-tested without a DOM.
 *
 * Two things it deliberately does own, because nothing else can:
 *
 *  - **Selection.** Which instrument the drawer is showing, shared by the
 *    chips and the ledger rows.
 *  - **Session-observed state**: the ledger's accumulated entries and the
 *    equity samples the sparkline plots. Both are things this page watched
 *    happen; neither is on any single snapshot.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineView } from '../../dashboard/pipeline-types.ts';
import { DetailDrawer } from './components/DetailDrawer.tsx';
import { AnalystsPanel } from './components/panels/AnalystsPanel.tsx';
import { DebatesPanel } from './components/panels/DebatesPanel.tsx';
import type { EquitySample } from './components/panels/MetricsPanel.tsx';
import { MetricsPanel } from './components/panels/MetricsPanel.tsx';
import { PositionsPanel } from './components/panels/PositionsPanel.tsx';
import { SpendPanel } from './components/panels/SpendPanel.tsx';
import { RoomsGrid } from './components/RoomsGrid.tsx';
import { TelemetryStrip } from './components/TelemetryStrip.tsx';
import { VerdictLedger } from './components/VerdictLedger.tsx';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion.ts';
import { type UseSnapshotOptions, useSnapshot } from './hooks/useSnapshot.ts';
import { useWalkAnimation } from './hooks/useWalkAnimation.ts';
import { createLedger, updateLedger } from './lib/ledger.ts';
import { computeLayout, type RoomId } from './lib/room-layout.ts';
import { computeWalkPlan } from './lib/walk-plan.ts';
import './App.css';

/** An empty view, so every derived structure exists from first paint. */
const EMPTY_VIEW: PipelineView = { lanes: [], live_trace_id: null, live_entered_at: null };

/**
 * How many equity samples the sparkline keeps. Samples arrive at the Alpaca
 * probe's cadence (60s), not the page's (3s) — see `EquitySample` — so this is
 * about two hours of history, bounded so a tab left open for a week does not
 * accumulate a week's worth of points.
 */
const MAX_EQUITY_SAMPLES = 120;

export interface AppProps {
  /** Injected by tests to drive the poll deterministically. */
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  const feed = useSnapshot(snapshotOptions);
  const reducedMotion = usePrefersReducedMotion();
  // `feed.revision` is deliberately not destructured: the per-poll identity
  // every derived value keys on is `snapshot` itself, which only changes when
  // a fetch succeeds. A counter alongside it would be a second source of truth
  // for "is this new data".
  const { snapshot, previous, firstPaint, snapOnly } = feed;

  const [selected, setSelected] = useState<string | null>(null);
  const [ledger, setLedger] = useState(createLedger);
  const [equitySamples, setEquitySamples] = useState<readonly EquitySample[]>([]);

  const view = snapshot?.pipeline ?? EMPTY_VIEW;
  const previousView = previous?.pipeline ?? null;

  const layout = useMemo(() => computeLayout(view), [view]);

  // Planned once per poll: `previous` and `snapshot` only change identity when
  // a fetch succeeds, so this memo does not re-plan (and re-animate) on an
  // unrelated re-render such as a selection change.
  const plan = useMemo(
    () =>
      snapshot === null
        ? null
        : computeWalkPlan(previousView, view, {
            firstPaint,
            // A hidden tab never observed the transitions, and reduced motion
            // asks not to see them replayed. Both degrade to the same plan.
            snapOnly: snapOnly || reducedMotion,
          }),
    [snapshot, previousView, view, firstPaint, snapOnly, reducedMotion],
  );

  const floorRef = useRef<HTMLDivElement | null>(null);
  const roomRefs = useRef<Map<RoomId, HTMLElement>>(new Map());
  const chipRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerRoomRef = (room: RoomId, element: HTMLElement | null) => {
    if (element === null) roomRefs.current.delete(room);
    else roomRefs.current.set(room, element);
  };
  const registerChipRef = (instrument: string, element: HTMLElement | null) => {
    if (element === null) chipRefs.current.delete(instrument);
    else chipRefs.current.set(instrument, element);
  };

  useWalkAnimation({
    plan,
    layout,
    reducedMotion,
    firstPaint,
    floorRef,
    roomRefs,
    chipRefs,
  });

  // The ledger folds each poll in. `updateLedger` dedupes against every
  // trace_id seen this session, which is what makes it safe to call twice for
  // the same payload — as StrictMode does in development.
  useEffect(() => {
    if (snapshot === null) return;
    setLedger((state) => updateLedger(state, previousView, view));
  }, [snapshot, previousView, view]);

  // One equity sample per PROBE OBSERVATION, not per poll. The Alpaca tile is
  // refreshed on its own 60-second poller while this page polls every 3
  // seconds, so most snapshots re-serve a balance this series has already
  // recorded; appending those would draw horizontal runs of one number and
  // call it a curve. A sample is new when the probe observed at a new time or
  // the figure itself changed. `balance` is null unless the probe reported
  // `ok`, so a failed probe contributes no point rather than a stale one.
  useEffect(() => {
    if (snapshot === null) return;
    const alpaca = snapshot.providers.alpaca;
    const balance = alpaca.balance;
    if (balance === null || !Number.isFinite(balance.equity)) return;
    setEquitySamples((samples) => {
      const last = samples[samples.length - 1];
      if (
        last !== undefined &&
        last.observed_at === alpaca.observed_at &&
        last.equity === balance.equity
      ) {
        return samples;
      }
      return [...samples, { observed_at: alpaca.observed_at, equity: balance.equity }].slice(
        -MAX_EQUITY_SAMPLES,
      );
    });
  }, [snapshot]);

  const verdictsByTrace = useMemo(
    () => new Map((snapshot?.verdicts ?? []).map((verdict) => [verdict.trace_id, verdict])),
    [snapshot],
  );

  const selectedLane = view.lanes.find((lane) => lane.instrument === selected);
  const selectedDebate = snapshot?.debates.find((debate) => debate.instrument === selected);
  const selectedTrace = selectedLane?.trace_id ?? null;
  const selectedVerdict = selectedTrace === null ? undefined : verdictsByTrace.get(selectedTrace);

  return (
    <div className="app">
      <TelemetryStrip
        snapshot={snapshot}
        stale={feed.stale}
        lastSuccessAt={feed.lastSuccessAt}
        error={feed.error}
      />

      <main>
        <RoomsGrid
          view={view}
          layout={layout}
          selectedInstrument={selected}
          onSelect={setSelected}
          floorRef={floorRef}
          registerRoomRef={registerRoomRef}
          registerChipRef={registerChipRef}
        />

        <div className="mid-row">
          <VerdictLedger
            entries={ledger.entries}
            verdictsByTrace={verdictsByTrace}
            selectedInstrument={selected}
            onSelect={setSelected}
          />
          <DetailDrawer
            instrument={selected}
            lane={selectedLane}
            debate={selectedDebate}
            verdict={selectedVerdict}
          />
        </div>

        <div className="bento">
          <PositionsPanel positions={snapshot?.positions ?? []} />
          <MetricsPanel metrics={snapshot?.metrics ?? null} equitySamples={equitySamples} />
          <AnalystsPanel analysts={snapshot?.analysts ?? []} />
          <SpendPanel spend={snapshot?.llm_spend ?? null} />
          <DebatesPanel debates={snapshot?.debates ?? []} />
        </div>
      </main>
    </div>
  );
}
