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

import type {
  AnalystPerformanceRow,
  ArmComparisonRow,
  ClosedTradeRow,
  DebateRow,
  FillRow,
  OutsideBenchmarkRow,
  PipelineView,
  PositionRow,
} from '@contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DetailDrawer } from './components/DetailDrawer.tsx';
import { AnalystsPanel } from './components/panels/AnalystsPanel.tsx';
import { ArmComparisonPanel } from './components/panels/ArmComparisonPanel.tsx';
import { ClosedTradesPanel } from './components/panels/ClosedTradesPanel.tsx';
import { DebatesPanel } from './components/panels/DebatesPanel.tsx';
import type { EquitySample } from './components/panels/MetricsPanel.tsx';
import { MetricsPanel } from './components/panels/MetricsPanel.tsx';
import { OutsideBenchmarkPanel } from './components/panels/OutsideBenchmarkPanel.tsx';
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
 * The panels' empty fallbacks, hoisted for the same reason `EMPTY_VIEW` is
 * (#606 item 6): `?? []` inside the render minted a fresh array identity every
 * pass, so a panel wrapped in `React.memo` would re-render on every 3-second
 * poll — and on every selection change — even when the page has no data for it
 * at all. No panel is memoised today; this is the identity discipline that
 * makes memoising one work when it happens, and it matches `EMPTY_VIEW`, whose
 * stable identity the walk planner's memo already depends on.
 */
const EMPTY_POSITIONS: readonly PositionRow[] = [];
const EMPTY_CLOSED_TRADES: readonly ClosedTradeRow[] = [];
const EMPTY_FILLS: readonly FillRow[] = [];
const EMPTY_ANALYSTS: readonly AnalystPerformanceRow[] = [];
const EMPTY_DEBATES: readonly DebateRow[] = [];
/** #971 — an empty list is the honest "no comparison computed yet" state. */
const EMPTY_ARM_COMPARISONS: readonly ArmComparisonRow[] = [];
const EMPTY_OUTSIDE_BENCHMARKS: readonly OutsideBenchmarkRow[] = [];

/**
 * What the drawer is showing: an instrument AND the trace within it (#606 item
 * 5).
 *
 * The trace is part of the selection rather than derived from the instrument
 * because an instrument settles repeatedly in a session and the ledger keeps
 * every settled row. A ledger row names its own `trace_id`; a sigil chip
 * stands for whatever trace its lane carries right now, so it selects
 * `traceId: null` and the lane resolves it.
 */
interface Selection {
  instrument: string;
  /** `null` means "whatever trace this instrument's lane carries now". */
  traceId: string | null;
}

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

  const [selection, setSelection] = useState<Selection | null>(null);
  const [ledger, setLedger] = useState(createLedger);
  const [equitySamples, setEquitySamples] = useState<readonly EquitySample[]>([]);

  const selected = selection?.instrument ?? null;
  // A chip stands for its lane's CURRENT trace, so it pins none; a ledger row
  // is a settled decision and pins the trace stamped on it (#606 item 5).
  // `useCallback` for the same identity reason as the empty fallbacks above:
  // these replaced a bare `setSelection`, which React guarantees is stable, and
  // a handler rebuilt every render would hand that guarantee back.
  const selectChip = useCallback(
    (instrument: string) => setSelection({ instrument, traceId: null }),
    [],
  );
  const selectLedgerRow = useCallback(
    (instrument: string, traceId: string) => setSelection({ instrument, traceId }),
    [],
  );

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

  // A ledger row pins its own trace, so the lane is looked up BY TRACE when
  // one is pinned: an older settled row must not resolve to the lane that
  // instrument is running now (#606 item 5). A pinned trace that has aged out
  // of the 15-minute pipeline window finds no lane, and the drawer says so
  // rather than substituting a newer decision.
  const selectedLane =
    selection === null
      ? undefined
      : selection.traceId === null
        ? view.lanes.find((lane) => lane.instrument === selection.instrument)
        : view.lanes.find((lane) => lane.trace_id === selection.traceId);
  const selectedDebate = snapshot?.debates.find((debate) => debate.instrument === selected);
  const selectedTrace = selection?.traceId ?? selectedLane?.trace_id ?? null;
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
          onSelect={selectChip}
          floorRef={floorRef}
          registerRoomRef={registerRoomRef}
          registerChipRef={registerChipRef}
        />

        <div className="mid-row">
          <VerdictLedger
            entries={ledger.entries}
            verdictsByTrace={verdictsByTrace}
            // The RESOLVED trace, so a chip click also highlights the ledger
            // row describing the trace that chip is standing on. The chip and
            // its room stay highlighted by instrument, which is still true of
            // both — only the drawer and this list are per-trace.
            selectedTraceId={selectedTrace}
            onSelect={selectLedgerRow}
          />
          <DetailDrawer
            instrument={selected}
            traceId={selectedTrace}
            lane={selectedLane}
            debate={selectedDebate}
            verdict={selectedVerdict}
          />
        </div>

        <div className="bento">
          <PositionsPanel positions={snapshot?.positions ?? EMPTY_POSITIONS} />
          <ClosedTradesPanel
            trades={snapshot?.closed_trades ?? EMPTY_CLOSED_TRADES}
            fills={snapshot?.fills ?? EMPTY_FILLS}
          />
          <MetricsPanel metrics={snapshot?.metrics ?? null} equitySamples={equitySamples} />
          <ArmComparisonPanel comparisons={snapshot?.arm_comparison ?? EMPTY_ARM_COMPARISONS} />
          {/*
            #981. BESIDE the matched control and immediately AFTER it, never
            before: the outside benchmarks are secondary, and reading order is
            part of saying so. `OutsideBenchmarkPanel` carries the rest of that
            (no verdict line, no alert styling, `panel-secondary`).
          */}
          <OutsideBenchmarkPanel
            benchmarks={snapshot?.outside_benchmarks ?? EMPTY_OUTSIDE_BENCHMARKS}
          />
          <AnalystsPanel analysts={snapshot?.analysts ?? EMPTY_ANALYSTS} />
          <SpendPanel spend={snapshot?.llm_spend ?? null} />
          <DebatesPanel debates={snapshot?.debates ?? EMPTY_DEBATES} />
        </div>
      </main>
    </div>
  );
}
