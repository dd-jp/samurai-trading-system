/**
 * The composition root: one poll, one rail, three tabs.
 *
 * State that outlives a poll lives here — which tab is open and what each
 * tab has selected — so a 3-second re-render never resets any of it. The
 * verdict ledger and equity series live in `useLedger`/`useEquitySamples`.
 * Everything below is a pure function of `snapshot` plus that state.
 *
 * It is also where the client decides, once, whether a snapshot exists at all
 * (#1520): before the first one lands this renders `ColdStart` and nothing
 * else, and after it the rail and all three tabs are handed a non-null
 * `WireSnapshot`. That is a guarantee rather than a reading, because the feed
 * never clears a snapshot it has accepted — see `feedView` in
 * `hooks/useSnapshot.ts`.
 */
import type { VerdictRow } from '@contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ColdStart } from './components/ColdStart.tsx';
import { Rail, TABS, type Tab } from './components/Rail.tsx';
import { GlanceTab } from './components/tabs/GlanceTab.tsx';
import { LiveTab } from './components/tabs/LiveTab.tsx';
import { ReviewTab } from './components/tabs/ReviewTab.tsx';
import { useEquitySamples } from './hooks/useEquitySamples.ts';
import { useLedger } from './hooks/useLedger.ts';
import { feedView, type UseSnapshotOptions, useSnapshot } from './hooks/useSnapshot.ts';
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
 * Two independent throw sites, both guarded: `window.sessionStorage`'s
 * PROPERTY ACCESS throws `SecurityError` where site data is blocked
 * (Safari's Block All Cookies, some Chrome privacy settings, some
 * extensions); separately, `getItem`/`setItem` THEMSELVES can throw once the
 * property access has already succeeded (Safari private browsing,
 * `QuotaExceededError`). This runs inside `useState`'s lazy initializer
 * (#1038 round 2 finding A), so either throw reaching the caller unguarded
 * would blow up render with no error boundary to catch it — a white screen,
 * not a degraded dashboard.
 */
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
        // Swallowed: `resolveDashboardToken` still returns the just-read URL
        // token to the caller even when persisting it fails (round 2 finding
        // B) — an unreachable store must cost the NEXT reload its token, not
        // this one's first poll.
      }
    },
  };
}

export interface AppProps {
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  // Resolved synchronously in useState's lazy initializer, not an effect:
  // useSnapshot's poll effect reads `optionsRef.current.authToken` — set
  // during render — the instant it mounts, so an effect-deferred resolution
  // loses that race and sends the FIRST poll unauthenticated whenever a
  // token is resolvable (#1038 round 2 finding A). StrictMode double-invokes
  // this initializer, but that is idempotent (same value, same URL) and not
  // a reason to move it back into an effect. `safeSessionStorage()` guards
  // every storage access this can reach, so nothing here throws out of
  // render (finding B).
  const [authToken] = useState<string | null>(() =>
    resolveDashboardToken(window.location.search, safeSessionStorage()),
  );
  useEffect(() => {
    // Scrubs `?token=...` off the address bar: keeps the token out of the
    // poll's referrer and out of the URL visible after first paint — it
    // does not keep the token off the browser history entry the initial
    // navigation already committed, or out of same-origin subresource
    // `Referer` headers the HTML shell sent before this ran
    // (dashboard-token.ts's header). Preserves `pathname`/`hash` —
    // `tabFromHash` above reads the hash directly off `location`, and
    // rewriting it away here would silently reset whichever tab a shared
    // link pointed at.
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

  // The one place the client asks whether a snapshot exists (#1520). Below
  // this line every leaf has one, for the rest of the session — see
  // `feedView`. It is also why every hook above runs unconditionally first:
  // the cold branch returns early, and a hook after it would change the hook
  // order on the poll that ends the cold start.
  const view = feedView(feed);
  if (view.kind === 'cold') return <ColdStart feed={view.feed} />;
  const live = view.feed;

  return (
    <div className={`app app-${tab}`}>
      <Rail feed={live} tab={tab} onTab={openTab} />
      <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'glance' && (
          <GlanceTab
            snapshot={live.snapshot}
            equitySamples={equitySamples}
            ledger={ledger}
            verdictsByTrace={verdictsByTrace}
            onOpenTrace={openTrace}
          />
        )}
        {tab === 'live' && (
          <LiveTab snapshot={live.snapshot} selection={liveSelection} onSelect={setLiveSelection} />
        )}
        {tab === 'review' && (
          <ReviewTab snapshot={live.snapshot} selectedKey={reviewKey} onSelect={setReviewKey} />
        )}
      </main>
    </div>
  );
}
