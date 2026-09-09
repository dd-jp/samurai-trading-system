/**
 * The composition root: one poll, one rail, three tabs.
 *
 * State that outlives a poll lives here — which tab is open and what each
 * tab has selected — so a 3-second re-render never resets any of it. The
 * verdict ledger and equity series live in `useLedger`/`useEquitySamples`.
 * Everything below is a pure function of `snapshot` plus that state.
 */
import type { VerdictRow } from '@contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Rail, TABS, type Tab } from './components/Rail.tsx';
import { GlanceTab } from './components/tabs/GlanceTab.tsx';
import { LiveTab } from './components/tabs/LiveTab.tsx';
import { ReviewTab } from './components/tabs/ReviewTab.tsx';
import { useEquitySamples } from './hooks/useEquitySamples.ts';
import { useLedger } from './hooks/useLedger.ts';
import { type UseSnapshotOptions, useSnapshot } from './hooks/useSnapshot.ts';
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

/** The tab named by `location.hash`, so a tab survives a reload and can be linked. */
function tabFromHash(): Tab {
  const hash = window.location.hash.replace(/^#/, '');
  return isTab(hash) ? hash : 'glance';
}

/**
 * `window.sessionStorage` throws `SecurityError` on the property access
 * itself where site data is blocked (Safari's Block All Cookies, some
 * Chrome privacy settings, some extensions) — not only on `getItem`/
 * `setItem`. Degrading to a store that reads nothing and writes nowhere
 * keeps the dashboard on its no-token default path instead of white-
 * screening from inside a render.
 */
function safeSessionStorage(): TokenStorage {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

export interface AppProps {
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  // Resolved (and, for a URL-borne token, persisted) in an effect rather
  // than useState's lazy initializer: React invokes a state initializer
  // twice under StrictMode to surface impure code, and both the storage
  // write and the property access that can throw belong to a side effect,
  // not to render.
  const [authToken, setAuthToken] = useState<string | null>(null);
  useEffect(() => {
    setAuthToken(resolveDashboardToken(window.location.search, safeSessionStorage()));
    // Scrubs `?token=...` off the address bar (dashboard-token.ts's header:
    // history, referrers and a shared screen are all places a URL-borne
    // credential leaks). Preserves `pathname`/`hash` — `tabFromHash` above
    // reads the hash directly off `location`, and rewriting it away here
    // would silently reset whichever tab a shared link pointed at.
    const nextSearch = stripTokenParam(window.location.search);
    if (nextSearch !== window.location.search) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${nextSearch}${window.location.hash}`,
      );
    }
  }, []);

  const feed = useSnapshot({ authToken, ...snapshotOptions });
  const { snapshot } = feed;

  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const openTab = useCallback((next: Tab) => {
    setTab(next);
    if (window.location.hash !== `#${next}`) {
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  const [liveSelection, setLiveSelection] = useState<Selection | null>(null);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const openTrace = useCallback(
    (selection: Selection) => {
      setLiveSelection(selection);
      openTab('live');
    },
    [openTab],
  );

  const ledger = useLedger(snapshot);
  const equitySamples = useEquitySamples(snapshot);

  const verdictsByTrace = useMemo(
    () =>
      new Map<string, VerdictRow>(
        (snapshot?.verdicts ?? []).map((verdict) => [verdict.trace_id, verdict]),
      ),
    [snapshot],
  );

  return (
    <div className={`app app-${tab}`}>
      <Rail feed={feed} tab={tab} onTab={openTab} />
      <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'glance' && (
          <GlanceTab
            snapshot={snapshot}
            equitySamples={equitySamples}
            ledger={ledger}
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
