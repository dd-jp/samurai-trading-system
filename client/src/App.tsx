import type { TradingArmWire, VerdictRow } from '@contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ColdStart } from './components/ColdStart.tsx';
import { ARMS, Rail, TABS, type Tab } from './components/Rail.tsx';
import { GlanceTab } from './components/tabs/GlanceTab.tsx';
import { LiveTab } from './components/tabs/LiveTab.tsx';
import { ReviewTab } from './components/tabs/ReviewTab.tsx';
import { useEquitySamples } from './hooks/useEquitySamples.ts';
import { useLedger } from './hooks/useLedger.ts';
import {
  feedView,
  type LiveFeed,
  type UseSnapshotOptions,
  useSnapshot,
} from './hooks/useSnapshot.ts';
import {
  resolveDashboardToken,
  stripTokenParam,
  type TokenStorage,
} from './lib/dashboard-token.ts';
import type { Selection } from './lib/resolve-trace.ts';
import './App.css';

function isTab(value: string): value is Tab {
  return TABS.some((entry) => entry.id === value);
}

function isArm(value: string | undefined): value is TradingArmWire {
  return value !== undefined && ARMS.some((entry) => entry.id === value);
}

function hashSegments(): [tab: string, arm: string | undefined] {
  const raw = window.location.hash.replace(/^#/, '');
  const [tab = '', arm] = raw.split('/');
  return [tab, arm];
}

function tabFromHash(): Tab {
  const [tab] = hashSegments();
  return isTab(tab) ? tab : 'glance';
}

function armFromHash(): TradingArmWire {
  const [, arm] = hashSegments();
  return isArm(arm) ? arm : 'live';
}

function hashFor(tab: Tab, arm: TradingArmWire): string {
  return arm === 'control' ? `#${tab}/control` : `#${tab}`;
}

function safeSessionStorage(): TokenStorage {
  let store: TokenStorage;
  try {
    store = window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
  return {
    getItem: (key) => {
      try {
        return store.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        store.setItem(key, value);
      } catch {
      }
    },
  };
}

interface DashboardProps {
  live: LiveFeed;
  arm: TradingArmWire;
  onArm: (next: TradingArmWire) => void;
  tab: Tab;
  onTab: (next: Tab) => void;
  onOpenTrace: (selection: Selection) => void;
  liveSelection: Selection | null;
  onSelectLive: (selection: Selection) => void;
  reviewKey: string | null;
  onSelectReview: (key: string | null) => void;
}

function Dashboard(props: DashboardProps) {
  const {
    live,
    arm,
    onArm,
    tab,
    onTab,
    onOpenTrace,
    liveSelection,
    onSelectLive,
    reviewKey,
    onSelectReview,
  } = props;
  const { snapshot } = live;
  const isControl = arm === 'control';

  const ledger = useLedger(snapshot);
  const equitySamples = useEquitySamples(snapshot);
  const verdictsByTrace = useMemo(
    () => new Map<string, VerdictRow>(snapshot.verdicts.map((v) => [v.trace_id, v])),
    [snapshot],
  );

  return (
    <div className={isControl ? 'app-shell app-control' : 'app-shell'}>
      {isControl && (
        <div className="control-banner" role="status" data-field="control-banner">
          CONTROL ARM — simulated fills, no money
        </div>
      )}
      <div className={`app app-${tab}`}>
        <Rail feed={live} tab={tab} onTab={onTab} arm={arm} onArm={onArm} />
        <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'glance' && (
            <GlanceTab
              snapshot={snapshot}
              equitySamples={equitySamples}
              ledger={ledger}
              verdictsByTrace={verdictsByTrace}
              onOpenTrace={onOpenTrace}
            />
          )}
          {tab === 'live' && (
            <LiveTab snapshot={snapshot} selection={liveSelection} onSelect={onSelectLive} />
          )}
          {tab === 'review' && (
            <ReviewTab snapshot={snapshot} selectedKey={reviewKey} onSelect={onSelectReview} />
          )}
        </main>
      </div>
    </div>
  );
}

interface ArmViewProps {
  arm: TradingArmWire;
  onArm: (next: TradingArmWire) => void;
  authToken: string | null;
  snapshotOptions: UseSnapshotOptions | undefined;
  tab: Tab;
  onTab: (next: Tab) => void;
  onOpenTrace: (selection: Selection) => void;
  liveSelection: Selection | null;
  onSelectLive: (selection: Selection) => void;
  reviewKey: string | null;
  onSelectReview: (key: string | null) => void;
}

function ArmView(props: ArmViewProps) {
  const { arm, onArm, authToken, snapshotOptions, ...rest } = props;
  const feed = useSnapshot({ authToken, ...snapshotOptions, arm });

  const view = feedView(feed);
  if (view.kind === 'cold') return <ColdStart feed={view.feed} />;

  return <Dashboard live={view.feed} arm={arm} onArm={onArm} {...rest} />;
}

export interface AppProps {
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  const [authToken] = useState<string | null>(() =>
    resolveDashboardToken(window.location.search, safeSessionStorage()),
  );
  useEffect(() => {
    const nextSearch = stripTokenParam(window.location.search);
    if (nextSearch !== window.location.search) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${nextSearch}${window.location.hash}`,
      );
    }
  }, []);

  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [arm, setArm] = useState<TradingArmWire>(armFromHash);
  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setArm(armFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const openTab = useCallback(
    (next: Tab) => {
      setTab(next);
      const nextHash = hashFor(next, arm);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    },
    [arm],
  );
  const openArm = useCallback(
    (next: TradingArmWire) => {
      setArm(next);
      const nextHash = hashFor(tab, next);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    },
    [tab],
  );

  const [liveSelection, setLiveSelection] = useState<Selection | null>(null);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const openTrace = useCallback(
    (selection: Selection) => {
      setLiveSelection(selection);
      openTab('live');
    },
    [openTab],
  );

  return (
    <ArmView
      key={arm}
      arm={arm}
      onArm={openArm}
      authToken={authToken}
      snapshotOptions={snapshotOptions}
      tab={tab}
      onTab={openTab}
      onOpenTrace={openTrace}
      liveSelection={liveSelection}
      onSelectLive={setLiveSelection}
      reviewKey={reviewKey}
      onSelectReview={setReviewKey}
    />
  );
}
