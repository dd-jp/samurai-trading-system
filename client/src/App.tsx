/**
 * The composition root: one poll, one rail, three tabs.
 *
 * State that outlives a poll lives here — which tab is open, what each tab
 * has selected, the session's verdict ledger, and the equity samples the
 * Alpaca probe has reported — so a 3-second re-render never resets any of it.
 * Everything below is a pure function of `snapshot` plus that state.
 */
import type { VerdictRow } from '@contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Rail, TABS, type Tab } from './components/Rail.tsx';
import { type EquitySample, GlanceTab } from './components/tabs/GlanceTab.tsx';
import { LiveTab, type Selection } from './components/tabs/LiveTab.tsx';
import { ReviewTab } from './components/tabs/ReviewTab.tsx';
import { type UseSnapshotOptions, useSnapshot } from './hooks/useSnapshot.ts';
import { createLedger, updateLedger } from './lib/ledger.ts';
import './App.css';

const MAX_EQUITY_SAMPLES = 120;

function isTab(value: string): value is Tab {
  return TABS.some((entry) => entry.id === value);
}

/** The tab named by `location.hash`, so a tab survives a reload and can be linked. */
function tabFromHash(): Tab {
  if (typeof window === 'undefined') return 'glance';
  const hash = window.location.hash.replace(/^#/, '');
  return isTab(hash) ? hash : 'glance';
}

export interface AppProps {
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  const feed = useSnapshot(snapshotOptions);
  const { snapshot, previous } = feed;

  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const openTab = useCallback((next: Tab) => {
    setTab(next);
    if (typeof window !== 'undefined' && window.location.hash !== `#${next}`) {
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  const [liveSelection, setLiveSelection] = useState<Selection | null>(null);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const openTrace = useCallback(
    (instrument: string, traceId: string) => {
      setLiveSelection({ instrument, traceId });
      openTab('live');
    },
    [openTab],
  );

  const [ledger, setLedger] = useState(createLedger);
  useEffect(() => {
    if (snapshot === null) return;
    setLedger((state) => updateLedger(state, previous?.pipeline ?? null, snapshot.pipeline));
  }, [snapshot, previous]);

  const [equitySamples, setEquitySamples] = useState<readonly EquitySample[]>([]);
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
    () =>
      new Map<string, VerdictRow>(
        (snapshot?.verdicts ?? []).map((verdict) => [verdict.trace_id, verdict]),
      ),
    [snapshot],
  );

  return (
    <div className={`app app-${tab}`}>
      <Rail
        snapshot={snapshot}
        stale={feed.stale}
        lastSuccessAt={feed.lastSuccessAt}
        error={feed.error}
        tab={tab}
        onTab={openTab}
      />
      <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'glance' && (
          <GlanceTab
            snapshot={snapshot}
            equitySamples={equitySamples}
            ledger={ledger.entries}
            verdictsByTrace={verdictsByTrace}
            onOpenTrace={openTrace}
          />
        )}
        {tab === 'live' && (
          <LiveTab snapshot={snapshot} selection={liveSelection} onSelect={setLiveSelection} />
        )}
        {tab === 'review' && (
          <ReviewTab snapshot={snapshot} selectedKey={reviewKey} onSelect={setReviewKey} />
        )}
      </main>
    </div>
  );
}
